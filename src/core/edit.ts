import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument, stringify } from "yaml";
import { resolveInRoot } from "./paths.ts";
import { execFileSync } from "node:child_process";
import { isAlive, launch, sessionsDir } from "./sessions.ts";
import { flatten, readTree } from "./tree.ts";

const TEMPLATE = fileURLToPath(new URL("../../templates/node.md", import.meta.url));
// The "sv" locale formats dates as YYYY-MM-DD in local time.
const today = () => new Date().toLocaleDateString("sv");

export class EditError extends Error {}

// Returns the paths of every node created, parents first.
export function createNode(root: string, rel: string, fields: { title?: string; goal?: string; context?: string }): string[] {
  const dir = nodeDir(root, rel);
  const file = path.join(dir, "CLAUDE.md");
  if (fs.existsSync(file)) throw new EditError(`${rel} already exists`);

  const segments = relOf(root, dir).split("/");
  const created: string[] = [];
  let current = root;
  for (const seg of segments.slice(0, -1)) {
    current = path.join(current, seg);
    if (fs.existsSync(path.join(current, "CLAUDE.md"))) continue;
    fs.mkdirSync(current, { recursive: true });
    fs.writeFileSync(path.join(current, "CLAUDE.md"), `---\n${stringify({ title: seg })}---\n`);
    created.push(relOf(root, current));
  }

  fs.mkdirSync(dir, { recursive: true });
  const frontmatter = stringify({ title: fields.title || segments.at(-1) });
  const goal = fields.goal ? `## Goal\n${fields.goal}\n\n` : "";
  let text = fs.readFileSync(TEMPLATE, "utf8")
    .replace("{{frontmatter}}", frontmatter).replace("{{goal}}", goal).replace("{{date}}", today());
  if (fields.context) text = text.replace(/(## Context\n).*\n/, (_, h) => `${h}${fields.context}\n`);
  fs.writeFileSync(file, text);
  created.push(relOf(root, dir));
  return created;
}

// Moves or renames a node with its whole subtree. The new parent must already be a node.
export function moveNode(root: string, from: string, to: string): string {
  const src = existingNode(root, from);
  const dst = nodeDir(root, to);
  if (fs.existsSync(dst)) throw new EditError(`${to} already exists`);
  if (!fs.existsSync(path.join(path.dirname(dst), "CLAUDE.md"))) throw new EditError(`parent of ${to} is not a node`);
  if ((dst + path.sep).startsWith(src + path.sep)) throw new EditError("cannot move a node inside itself");
  refuseLiveSessions(root, src);
  fs.renameSync(src, dst);
  return relOf(root, dst);
}

// Moves the node and its subtree into <root>/.trash, which the tree walk skips.
export function removeNode(root: string, rel: string): string {
  const src = existingNode(root, rel);
  refuseLiveSessions(root, src);
  const trash = path.join(root, ".trash");
  fs.mkdirSync(trash, { recursive: true });
  const dst = path.join(trash, `${new Date().toISOString().replace(/[:.]/g, "-")}-${path.basename(src)}`);
  fs.renameSync(src, dst);
  return dst;
}

// Edits title and goal in place. Other frontmatter keys, comments and the rest of the body are kept.
// An empty goal removes the ## Goal section.
export function updateNode(root: string, rel: string, fields: { title?: string; goal?: string }) {
  const file = path.join(resolveInRoot(root, rel), "CLAUDE.md");
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");
  const end = lines[0]?.trim() === "---" ? lines.findIndex((l, i) => i > 0 && l.trim() === "---") : -1;
  const doc = parseDocument(end === -1 ? "" : lines.slice(1, end).join("\n"));
  if (doc.errors.length) throw new EditError("frontmatter does not parse; fix the file by hand first");
  let body = end === -1 ? text : lines.slice(end + 1).join("\n");

  if (fields.title !== undefined) {
    if (!fields.title.trim()) throw new EditError("title cannot be empty");
    doc.set("title", fields.title.trim());
  }
  if (fields.goal !== undefined) {
    doc.delete("goal"); // the goal belongs in the body
    body = setGoal(body, fields.goal.trim());
  }
  fs.writeFileSync(file, `---\n${doc.toString()}---\n${body}`);
}

// Ends a live session: closes its tmux session (which quits Claude), or signals Claude directly.
// The conversation stays on disk; `launch` with resume picks it up again. `id` is a session id or tmux name.
export function endSession(root: string, id: string): string {
  const node = flatten(readTree(root)).find((n) => n.sessions.some((s) => s.sessionId === id || s.tmux === id));
  const s = node?.sessions.find((x) => x.sessionId === id || x.tmux === id);
  if (!node || !s) throw new EditError(`no live session ${id}`);
  if (s.tmux) execFileSync("tmux", ["kill-session", "-t", `=${s.tmux}`]);
  else process.kill(s.pid, "SIGTERM");
  fs.rmSync(path.join(sessionsDir(path.join(root, node.path)), `${s.sessionId}.json`), { force: true });
  return node.path;
}

// Moves a session that runs outside tmux into orca: quits that Claude (which saves the conversation),
// then resumes the same conversation in tmux, in the same folder, on the same node.
export function adoptSession(root: string, id: string): { tmux: string; path: string } {
  const node = flatten(readTree(root)).find((n) => n.sessions.some((s) => s.sessionId === id));
  const s = node?.sessions.find((x) => x.sessionId === id);
  if (!node || !s) throw new EditError(`no live session ${id} on this machine`);
  if (s.tmux) throw new EditError("this session already runs in tmux");
  if (s.state !== "ready") throw new EditError("wait until the session finishes its turn, then move it");

  process.kill(s.pid, "SIGTERM");
  const deadline = Date.now() + 10_000;
  while (isAlive(s.pid)) {
    if (Date.now() > deadline) throw new EditError(`Claude (pid ${s.pid}) did not exit; quit it by hand and use Resume`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  fs.rmSync(path.join(sessionsDir(path.join(root, node.path)), `${s.sessionId}.json`), { force: true });
  return { tmux: launch(root, node.path, { resumeId: s.sessionId, cwd: s.cwd }), path: node.path };
}

function setGoal(body: string, goal: string): string {
  const section = /^##\s+Goal\s*$[\s\S]*?(?=^#{1,6}\s|(?![\s\S]))/im;
  const block = goal ? `## Goal\n${goal}\n\n` : "";
  if (section.test(body)) return body.replace(section, block);
  if (!goal) return body;
  // New section goes before the first heading, or at the end if there is none.
  const first = body.search(/^#{1,6}\s/m);
  return first === -1 ? `${body.trimEnd()}\n\n${block}` : body.slice(0, first) + block + body.slice(first);
}

function nodeDir(root: string, rel: string): string {
  const dir = resolveInRoot(root, rel);
  const segments = relOf(root, dir).split("/");
  if (!segments[0]) throw new EditError("path must name a node below the root");
  if (segments.some((s) => s.startsWith(".") || s === "node_modules")) {
    throw new EditError("hidden and node_modules directories cannot be nodes");
  }
  return dir;
}

function existingNode(root: string, rel: string): string {
  const dir = nodeDir(root, rel);
  if (!fs.existsSync(path.join(dir, "CLAUDE.md"))) throw new EditError(`${rel} is not a node`);
  return dir;
}

function refuseLiveSessions(root: string, dir: string) {
  const prefix = relOf(root, dir);
  const busy = flatten(readTree(root)).filter(
    (n) => (n.path === prefix || n.path.startsWith(prefix + "/")) && n.sessions.length,
  );
  if (busy.length) throw new EditError(`live sessions in ${busy.map((n) => n.path).join(", ")}; end them first`);
}

const relOf = (root: string, abs: string) => path.relative(root, abs).split(path.sep).join("/");
