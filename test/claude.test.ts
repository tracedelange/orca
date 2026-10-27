import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";

// test/bin/claude stands in for Claude: `-p` calls answer from FAKE_CLAUDE_ANSWER, sessions idle.
// These tests check what orca does with Claude's answers, not that Claude still answers this way.
//
// Sessions start in a tmux server of their own (TMUX_TMPDIR, no TMUX), so they never reach the user's
// tmux, whose PATH would find the real claude. HOME is a temp folder, so the hook check never reads ~/.claude.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orca-claude-"));
Object.assign(process.env, {
  HOME: path.join(tmp, "home"),
  PATH: `${path.resolve(import.meta.dirname, "bin")}:${process.env.PATH}`,
  TMUX_TMPDIR: path.join(tmp, "tmux"),
  FAKE_CLAUDE_LOG: path.join(tmp, "claude.log"),
  GIT_AUTHOR_NAME: "orca", GIT_AUTHOR_EMAIL: "orca@test", GIT_COMMITTER_NAME: "orca", GIT_COMMITTER_EMAIL: "orca@test",
});
delete process.env.TMUX;
fs.mkdirSync(process.env.HOME!);
fs.mkdirSync(process.env.TMUX_TMPDIR!);

const { installHooks, USER_SETTINGS } = await import("../src/core/install.ts");
const { askHaiku, chooseDispatch, dismissDispatch, dispatch, listJobs, queueDispatch, retryDispatch } = await import("../src/core/dispatch.ts");
const { consolidate } = await import("../src/core/consolidate.ts");
const { closeShell, launch, launchShell, listShells } = await import("../src/core/sessions.ts");
const { queueItems, runQueues } = await import("../src/core/queue.ts");
const { flatten, readTree } = await import("../src/core/tree.ts");
installHooks(USER_SETTINGS);

const killSessions = () => {
  try { execFileSync("tmux", ["kill-server"], { stdio: "ignore" }); } catch {}
};
beforeEach(() => {
  killSessions();
  fs.writeFileSync(process.env.FAKE_CLAUDE_LOG!, "");
});
after(killSessions);

function seededRoot(): string {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orca-")), "nodes");
  fs.cpSync(path.resolve(import.meta.dirname, "seed"), root, { recursive: true });
  return root;
}

const answer = (a: { place?: object; plan?: object }) => (process.env.FAKE_CLAUDE_ANSWER = JSON.stringify(a));
const calls = (): string[][] => fs.readFileSync(process.env.FAKE_CLAUDE_LOG!, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const node = (root: string, rel: string) => flatten(readTree(root)).find((n) => n.path === rel);

async function until<T>(check: () => T | undefined, ms = 5000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    const v = check();
    if (v) return v;
  }
  throw new Error("timed out");
}
// The fake claude's arguments once a session started in tmux has run it.
const session = () => until(() => calls().find((c) => !c.includes("-p")));

test("askHaiku asks for structured output with no tools or settings, and fails on an error answer", async () => {
  answer({ place: { sure: true, choices: [] } });
  assert.deepEqual(await askHaiku("system", { type: "object" }, "prompt"), { sure: true, choices: [] });
  const args = calls()[0];
  for (const flag of ["--model", "--json-schema", "--output-format", "--tools", "--setting-sources", "--no-session-persistence"]) assert.ok(args.includes(flag), flag);
  answer({});
  await assert.rejects(askHaiku("system", { type: "object" }, "prompt"), /Haiku call failed: no answer set/);
});

test("dispatch files a sure placement as a new node under its parent and starts Claude there", async () => {
  const root = seededRoot();
  answer({ place: { sure: true, choices: [{ path: "work/report", title: "Weekly report", goal: "Send the report." }] } });
  const d = await dispatch(root, "work", "Write the weekly report", undefined, "work");
  assert.deepEqual([d.path, d.created, d.tmux], ["work/report", ["work/report"], "orca-work-report"]);
  const n = node(root, "work/report")!;
  assert.deepEqual([n.title, n.goal, n.parent], ["Weekly report", "Send the report.", "work"]);
  const args = await session();
  assert.deepEqual(args.slice(0, 2), ["-n", "Weekly report"]);
  assert.deepEqual(args.slice(-2), ["--", "Write the weekly report"]);
});

test("dispatch refuses an unsure or out-of-scope placement, and an empty prompt", async () => {
  const root = seededRoot();
  const place = (path: string) => ({ path, title: "T", goal: "G" });
  answer({ place: { sure: false, choices: [place("work/a"), place("work/b"), place("home/c")] } });
  await assert.rejects(dispatch(root, "work", "Do it"), /not sure where this goes: work\/a, work\/b\./);
  answer({ place: { sure: true, choices: [place("home/c")] } });
  await assert.rejects(dispatch(root, "work", "Do it"), /placement is outside work/);
  await assert.rejects(dispatch(root, "work", "  "), /prompt is empty/);
});

test("a queued dispatch waits on choices, files the one picked, and keeps a failure for retry", async () => {
  const root = seededRoot();
  const place = (path: string) => ({ path, title: path.split("/").pop(), goal: "G" });
  answer({ place: { sure: false, choices: [place("work/a"), place("work/b")] } });
  const job = queueDispatch(root, "work", "Do it");
  await until(() => listJobs().find((j) => j.id === job.id)?.choices);
  assert.equal(chooseDispatch(root, job.id, 1).path, "work/b");
  assert.ok(!listJobs().some((j) => j.id === job.id));
  assert.throws(() => chooseDispatch(root, job.id, 0), /no such choice/);

  answer({});
  const failed = queueDispatch(root, "work", "Do it");
  await until(() => listJobs().find((j) => j.id === failed.id)?.error);
  answer({ place: { sure: true, choices: [place("work/c")] } });
  retryDispatch(root, failed.id);
  await until(() => !listJobs().some((j) => j.id === failed.id));
  assert.ok(node(root, "work/c"));

  answer({});
  const dropped = queueDispatch(root, "work", "Do it");
  await until(() => listJobs().find((j) => j.id === dropped.id)?.error);
  dismissDispatch(dropped.id);
  assert.throws(() => retryDispatch(root, dropped.id), /no such dispatch/);
});

test("the queue plans a waiting item into a child node and starts a worker on it", async () => {
  const root = seededRoot();
  fs.mkdirSync(path.join(root, "work/q/write-docs"), { recursive: true }); // taken, so the child gets -2
  fs.writeFileSync(path.join(root, "work/q/CLAUDE.md"), "---\ntitle: Q\n---\n## Queue\n- [ ] Write the docs\n");
  answer({ plan: { slug: "Write Docs!", title: "Docs", model: "haiku", context: "See the README." } });
  await runQueues(root);
  const item = await until(() => queueItems(fs.readFileSync(path.join(root, "work/q/CLAUDE.md"), "utf8")).find((i) => i.child));
  assert.deepEqual([item.mark, item.child], [">", "work/q/write-docs-2"]);
  const n = node(root, "work/q/write-docs-2")!;
  assert.deepEqual([n.title, n.goal, n.background], ["Docs", "Write the docs", true]);
  const args = await session();
  assert.equal(args[args.indexOf("--model") + 1], "haiku");
  assert.equal(args[args.indexOf("--permission-mode") + 1], "acceptEdits");
  assert.match(args.at(-1)!, /^Write the docs\n\nYou are a queue worker\./);
});

test("a queue worker on a node with a repo gets a worktree on its own branch", async () => {
  const root = seededRoot();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "orca-repo-"));
  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "first"]);
  fs.mkdirSync(path.join(root, "work/proj"));
  fs.writeFileSync(path.join(root, "work/proj/CLAUDE.md"), `---\ntitle: Proj\nrepo: ${repo}\n---\n## Queue\n- [ ] Add notes\n`);
  answer({ plan: { slug: "notes", title: "Notes", model: "sonnet", context: "" } });
  await runQueues(root);
  await until(() => queueItems(fs.readFileSync(path.join(root, "work/proj/CLAUDE.md"), "utf8"))[0].child);
  const wt = path.join(root, "work/proj/notes/.node/worktree");
  assert.equal(execFileSync("git", ["-C", wt, "branch", "--show-current"], { encoding: "utf8" }).trim(), "orca/work/proj/notes");
  assert.match((await session()).at(-1)!, /is a git worktree on its own branch/);
});

test("a failed plan fails the item", async () => {
  const root = seededRoot();
  fs.mkdirSync(path.join(root, "work/q"));
  fs.writeFileSync(path.join(root, "work/q/CLAUDE.md"), "---\ntitle: Q\n---\n## Queue\n- [ ] Write the docs\n");
  answer({});
  await runQueues(root);
  const item = await until(() => queueItems(fs.readFileSync(path.join(root, "work/q/CLAUDE.md"), "utf8")).find((i) => i.mark === "!"));
  assert.match(item.note!, /Haiku call failed/);
});

test("launch names sessions after the node, resumes with --continue, and needs the hooks", async () => {
  const root = seededRoot();
  assert.equal(launch(root, "work"), "orca-work");
  assert.equal(launch(root, "work", { resume: true }), "orca-work-2");
  await until(() => calls().filter((c) => !c.includes("-p")).length === 2 || undefined);
  assert.ok(calls().some((c) => c.includes("--continue")));
  installHooks(USER_SETTINGS, true);
  try {
    assert.throws(() => launch(root, "work"), /orca hooks are not installed/);
  } finally {
    installHooks(USER_SETTINGS);
  }
});

test("a shell starts in its node folder, lists with its node, and closes only as a shell", async () => {
  const root = seededRoot();
  assert.equal(launchShell(root, "work"), "orca-sh-work");
  assert.equal(launchShell(root, ""), "orca-sh-root");
  launch(root, "work");
  const shells = await until(() => { const l = listShells(); return l.length === 2 && l.every((s) => s.cwd) ? l : undefined; });
  const work = shells.find((s) => s.tmux === "orca-sh-work")!;
  assert.deepEqual([work.path, fs.realpathSync(work.cwd)], ["work", fs.realpathSync(path.join(root, "work"))]);
  assert.throws(() => closeShell("orca-work"), /no shell orca-work/);
  closeShell("orca-sh-work");
  assert.deepEqual(listShells().map((s) => [s.tmux, s.path]), [["orca-sh-root", ""]]);
});

test("the CLI launches and dispatches, and says how to attach", async () => {
  const root = seededRoot();
  const orca = (...args: string[]) =>
    execFileSync(path.resolve(import.meta.dirname, "../bin/orca.js"), args, { env: { ...process.env, NODES_ROOT: root }, encoding: "utf8" });
  assert.equal(orca("launch", "work"), "started orca-work; attach with: tmux attach -t orca-work\n");
  answer({ place: { sure: true, choices: [{ path: "home/chores", title: "Chores", goal: "Done." }] } });
  assert.equal(orca("dispatch", "home", "Do the chores"), "created home/chores\ndispatched to home/chores; attach with: tmux attach -t orca-home-chores\n");
});

test("consolidate needs a git repo, commits a snapshot, and starts a session with the prompt", async () => {
  const root = seededRoot();
  const template = path.resolve(import.meta.dirname, "../templates/consolidate.md");
  assert.throws(() => consolidate(root, "work", template), /is not a git repo/);
  execFileSync("git", ["-C", root, "init", "-q"]);
  const c = consolidate(root, "work", template);
  assert.equal(execFileSync("git", ["-C", root, "log", "--format=%s"], { encoding: "utf8" }), "snapshot: before consolidating work\n");
  assert.equal(execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" }), "");
  assert.equal(c.tmux, "orca-work");
  const prompt = (await session()).at(-1)!;
  assert.match(prompt, /Consolidate the subtree under this node \(work\)/);
  assert.doesNotMatch(prompt, /\{\{/);
  // A clean tree is not committed again.
  assert.equal(consolidate(root, "work", template).commit, c.commit);
});
