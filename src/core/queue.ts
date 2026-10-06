import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { askHaiku } from "./dispatch.ts";
import { createNode, EditError, endSession } from "./edit.ts";
import { expandHome, resolveInRoot } from "./paths.ts";
import { launch, liveTmuxSessions, readSessions, splitRepo, tmuxBase, type Session } from "./sessions.ts";
import { flatten, nodeContext, readTree, type TreeNode } from "./tree.ts";

// A node's "## Queue" section is a checklist of tasks. The server's manager loop hands each one to a
// background worker: a child node with its own session, and its own git worktree when the node has a repo.
// When the worker stops, the manager commits its work, merges the branch, and checks the item off.
//
//   - [ ] waiting
//   - [>] running → <child path>
//   - [x] done → <child path>
//     Result: <the worker's Status line>
//   - [!] failed → <child path> — <reason>

export const PARALLEL = 2;
const ITEM = /^- \[([ >x!])\] (.+?)(?: → (\S+))?(?: — (.+))?$/;

type Item = { mark: string; text: string; child?: string };

function section(lines: string[]): [number, number] | undefined {
  const start = lines.findIndex((l) => /^##\s+Queue\s*$/i.test(l));
  if (start === -1) return undefined;
  const next = lines.findIndex((l, i) => i > start && /^#{1,6}\s/.test(l));
  return [start, next === -1 ? lines.length : next];
}

export function queueItems(text: string): Item[] {
  const lines = text.split("\n");
  const range = section(lines);
  if (!range) return [];
  return lines.slice(range[0] + 1, range[1]).flatMap((l) => {
    const m = l.match(ITEM);
    return m ? [{ mark: m[1], text: m[2], child: m[3] }] : [];
  });
}

const fileOf = (root: string, rel: string) => path.join(resolveInRoot(root, rel), "CLAUDE.md");

// Adds a task to the end of the node's queue, creating the section (before ## Log) when it is missing.
export function addToQueue(root: string, rel: string, task: string) {
  const text = task.trim().replace(/\s+/g, " ");
  if (!text) throw new EditError("task is empty");
  const file = fileOf(root, rel);
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const range = section(lines);
  if (range) {
    let at = range[1];
    while (at > range[0] + 1 && !lines[at - 1].trim()) at--;
    lines.splice(at, 0, `- [ ] ${text}`);
  } else {
    const log = lines.findIndex((l) => /^##\s+Log\s*$/i.test(l));
    lines.splice(log === -1 ? lines.length : log, 0, "## Queue", `- [ ] ${text}`, "");
  }
  fs.writeFileSync(file, lines.join("\n"));
}

// Rewrites one item's line, found by its text. The file is re-read, so edits made meanwhile survive.
function setItem(file: string, text: string, mark: string, child?: string, note?: string) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const range = section(lines);
  if (!range) return;
  for (let i = range[0] + 1; i < range[1]; i++) {
    if (lines[i].match(ITEM)?.[2] !== text) continue;
    lines[i] = `- [${mark}] ${text}${child ? ` → ${child}` : ""}${mark === "!" && note ? ` — ${oneLine(note)}` : ""}`;
    if (mark === "x") lines.splice(i + 1, 0, `  Result: ${oneLine(note ?? "finished")}`);
    break;
  }
  fs.writeFileSync(file, lines.join("\n"));
}

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    slug: { type: "string" },
    title: { type: "string" },
    model: { type: "string", enum: ["haiku", "sonnet"] },
    context: { type: "string" },
  },
  required: ["slug", "title", "model", "context"],
};

const PLAN_SYSTEM = `You hand one task from a project's queue to a Claude worker. Return:
- slug: a lowercase kebab-case folder name for the task, 1 to 4 words.
- title: 2 to 5 words.
- model: "haiku" for a small mechanical task (a rename, a copy edit, a one-line fix). "sonnet" for anything that needs design or touches several files.
- context: 1 to 4 sentences the worker needs beyond the task itself: the relevant notes, constraints and places to look. Do not repeat the task.`;

// Items being planned or merged, so a slow step never runs twice.
const busy = new Set<string>();
// Workers sent back to fix a merge conflict: the turn that conflicted, and its result.
const retried = new Map<string, { finishedAt?: string; summary?: string }>();

// One pass of the manager: finish stopped workers, then start waiting items up to PARALLEL per node.
export async function runQueues(root: string) {
  const live = liveTmuxSessions();
  for (const n of flatten(readTree(root))) {
    const file = fileOf(root, n.path);
    const items = queueItems(fs.readFileSync(file, "utf8"));
    let running = 0;
    for (const item of items.filter((i) => i.mark === ">")) {
      running++;
      const key = `${n.path}\n${item.text}`;
      if (busy.has(key)) continue;
      // A [>] with no child was mid-plan when the server stopped: put it back in line.
      if (!item.child) {
        setItem(file, item.text, " ");
        running--;
        continue;
      }
      const childDir = resolveInRoot(root, item.child);
      const s = readSessions(childDir)[0];
      if (s?.state === "ready" && s.finishedAt && retried.get(item.child)?.finishedAt !== s.finishedAt) {
        busy.add(key);
        try { finish(root, n, item, s); } catch (err) { fail(file, item, (err as Error).message); } finally { busy.delete(key); }
      } else if (!s && !live.has(tmuxBase(root, childDir))) {
        fail(file, item, "the worker session ended before it finished");
      }
    }
    for (const item of items.filter((i) => i.mark === " ")) {
      if (running >= PARALLEL) break;
      running++;
      start(root, n, item); // async: the plan takes a few seconds, and the [>] mark holds the slot
    }
  }
}

async function start(root: string, n: TreeNode, item: Item) {
  const key = `${n.path}\n${item.text}`;
  const file = fileOf(root, n.path);
  busy.add(key);
  setItem(file, item.text, ">");
  try {
    const plan = await askHaiku(PLAN_SYSTEM, PLAN_SCHEMA, `${nodeContext(root, path.join(root, n.path))}\n\nTask:\n${item.text}`);
    const slug = plan.slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "task";
    let child = n.path ? `${n.path}/${slug}` : slug;
    for (let i = 2; fs.existsSync(path.join(root, child)); i++) child = `${n.path ? `${n.path}/` : ""}${slug}-${i}`;

    createNode(root, child, { title: plan.title, goal: item.text, context: plan.context, background: true });
    const repo = gitRepo(n);
    const cwd = repo ? worktreeOf(root, child) : undefined;
    if (repo) git(repo, "worktree", "add", "-b", branchOf(child), cwd!);

    const rules = [
      `You are a queue worker. Your node's CLAUDE.md files are already loaded.`,
      // No repo path here: workers given the main checkout's path read and edit it instead of the worktree.
      repo && `Your working folder, ${cwd}, is a git worktree on its own branch: every file for the task is there. Do not commit: the manager commits and merges your work when you stop.`,
      "Do the task without asking questions where a sensible default exists. Your Status line is the result: say what you changed.",
    ].filter(Boolean).join(" ");
    launch(root, child, { prompt: `${item.text}\n\n${rules}`, cwd, model: plan.model, permissionMode: "acceptEdits",
      allowedTools: [`Read(/${root}/**)`] }); // "//" marks an absolute path; workers may read the whole tree
    setItem(file, item.text, ">", child);
  } catch (err) {
    fail(file, item, (err as Error).message);
  } finally {
    busy.delete(key);
  }
}

// Commits the worker's changes and merges its branch into the repo's current branch. On a conflict the
// manager merges the other way, in the worktree, and sends the worker back once to resolve the markers.
// A second conflict fails the item.
function finish(root: string, n: TreeNode, item: Item, s: Session) {
  const child = item.child!;
  const repo = gitRepo(n);
  const wt = worktreeOf(root, child);
  if (repo && fs.existsSync(wt)) {
    if (git(wt, "status", "--porcelain")) {
      const markers = spawnSync("git", ["-C", wt, "grep", "-l", "-E", "^(<<<<<<<|>>>>>>>) "], { encoding: "utf8" }).stdout.trim();
      if (markers) throw new Error(`unresolved conflict markers in ${markers.split("\n").join(", ")}`);
      git(wt, "add", "-A");
      git(wt, "commit", "-m", `${item.text}\n\nQueue worker for ${child}.`);
    }
    const base = git(repo, "rev-parse", "--abbrev-ref", "HEAD");
    const merge = spawnSync("git", ["-C", repo, "merge", "--no-ff", "--no-edit", branchOf(child)], { encoding: "utf8" });
    if (merge.status !== 0) {
      const conflicts = git(repo, "diff", "--name-only", "--diff-filter=U");
      if (!conflicts) throw new Error(`merge refused: ${merge.stderr || merge.stdout}`);
      git(repo, "merge", "--abort");
      const files = conflicts.split("\n").join(", ");
      if (retried.has(child)) throw new Error(`merge conflict in ${files}`);
      spawnSync("git", ["-C", wt, "merge", "--no-edit", base]);
      retried.set(child, { finishedAt: s.finishedAt, summary: s.summary });
      return send(s, `The manager merged ${base} into your branch and it conflicts in ${files}. Edit those files to remove the conflict markers, keeping the intent of both sides. Do not run git.`);
    }
    git(repo, "worktree", "remove", "--force", wt);
    git(repo, "branch", "-d", branchOf(child));
  }
  const summary = retried.get(child)?.summary ?? s.summary;
  retried.delete(child);
  endSession(root, s.sessionId);
  setItem(fileOf(root, n.path), item.text, "x", child, summary);
}

function fail(file: string, item: Item, reason: string) {
  setItem(file, item.text, "!", item.child, reason);
}

// The node's first local repo that is a git checkout.
function gitRepo(n: TreeNode): string | undefined {
  return n.repos.filter((r) => !splitRepo(r).host).map(expandHome).find((r) => fs.existsSync(path.join(r, ".git")));
}

const worktreeOf = (root: string, child: string) => path.join(root, child, ".node", "worktree");
const branchOf = (child: string) => `orca/${child}`;
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
const oneLine = (s: string) => s.trim().split("\n")[0].replace(/\s+/g, " ");

// Types a new prompt into a worker's Claude. The trailing ":" makes "=name" an exact session target for a pane.
function send(s: Session, prompt: string) {
  if (!s.tmux) throw new Error("the worker is not in tmux");
  execFileSync("tmux", ["send-keys", "-t", `=${s.tmux}:`, "-l", prompt]);
  execFileSync("tmux", ["send-keys", "-t", `=${s.tmux}:`, "Enter"]);
}
