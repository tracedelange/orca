import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createNode } from "../src/core/edit.ts";
import { queueItems, runQueues } from "../src/core/queue.ts";

// The manager commits and merges as the user; CI has no git identity.
Object.assign(process.env, { GIT_AUTHOR_NAME: "orca", GIT_AUTHOR_EMAIL: "orca@test", GIT_COMMITTER_NAME: "orca", GIT_COMMITTER_EMAIL: "orca@test" });

function seededRoot(): string {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orca-")), "nodes");
  fs.cpSync(path.resolve(import.meta.dirname, "seed"), root, { recursive: true });
  return root;
}

const queueOf = (root: string, rel: string) => queueItems(fs.readFileSync(path.join(root, rel, "CLAUDE.md"), "utf8"));

// A finished worker: a live process (so the session file counts) that endSession can stop.
function finishedWorker(root: string, rel: string, summary: string) {
  const proc = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
  proc.unref();
  const dir = path.join(root, rel, ".node", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const s = { sessionId: `w-${proc.pid}`, pid: proc.pid, cwd: path.join(root, rel), state: "ready", updatedAt: now, finishedAt: now, summary };
  fs.writeFileSync(path.join(dir, `${s.sessionId}.json`), JSON.stringify(s));
  return { pid: proc.pid!, file: path.join(dir, `${s.sessionId}.json`) };
}

const alive = (pid: number) => {
  try { return process.kill(pid, 0); } catch { return false; }
};

// No test leaves a waiting item: starting one would ask Haiku through the claude CLI.
test("a running item with no worker yet goes back in line", async () => {
  const root = seededRoot();
  createNode(root, "work/q", { title: "Q" });
  fs.appendFileSync(path.join(root, "work/q/CLAUDE.md"), "\n## Queue\n- [>] Plan me\n");
  await runQueues(root);
  assert.deepEqual(queueOf(root, "work/q").map((i) => [i.mark, i.text]), [[" ", "Plan me"]]);
});

test("a running item whose worker is gone fails with the reason", async () => {
  const root = seededRoot();
  createNode(root, "work/q", { title: "Q" });
  createNode(root, "work/q/gone", { title: "Gone" });
  fs.appendFileSync(path.join(root, "work/q/CLAUDE.md"), "\n## Queue\n- [>] Vanish → work/q/gone\n");
  await runQueues(root);
  assert.deepEqual(queueOf(root, "work/q"), [{ mark: "!", text: "Vanish", child: "work/q/gone", note: "the worker session ended before it finished" }]);
});

test("a finished worker without a repo is ended and checked off with its Status line", async () => {
  const root = seededRoot();
  createNode(root, "work/q", { title: "Q" });
  createNode(root, "work/q/done", { title: "Done" });
  fs.appendFileSync(path.join(root, "work/q/CLAUDE.md"), "\n## Queue\n- [>] Tidy → work/q/done\n");
  const w = finishedWorker(root, "work/q/done", "Tidied the notes.\nSecond line is dropped.");
  await runQueues(root);
  assert.deepEqual(queueOf(root, "work/q"), [{ mark: "x", text: "Tidy", child: "work/q/done", note: "Tidied the notes." }]);
  assert.ok(!fs.existsSync(w.file));
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!alive(w.pid));
});

test("a finished worker's changes are committed and merged into the node's repo", async () => {
  const root = seededRoot();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "orca-repo-"));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  git(repo, "init", "-q");
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");

  fs.mkdirSync(path.join(root, "work/proj"));
  fs.writeFileSync(path.join(root, "work/proj/CLAUDE.md"), `---\ntitle: Proj\nrepo: ${repo}\n---\n## Queue\n- [>] Add notes → work/proj/notes\n`);
  createNode(root, "work/proj/notes", { title: "Notes" });
  const wt = path.join(root, "work/proj/notes/.node/worktree");
  git(repo, "worktree", "add", "-q", "-b", "orca/work/proj/notes", wt);
  fs.writeFileSync(path.join(wt, "NOTES.md"), "from the worker\n");
  finishedWorker(root, "work/proj/notes", "Added NOTES.md.");

  await runQueues(root);
  assert.equal(queueOf(root, "work/proj")[0].mark, "x");
  assert.equal(fs.readFileSync(path.join(repo, "NOTES.md"), "utf8"), "from the worker\n");
  assert.match(git(repo, "log", "-1", "--format=%s"), /^Merge branch 'orca\/work\/proj\/notes'/);
  assert.ok(!fs.existsSync(wt));
  assert.equal(git(repo, "branch", "--list", "orca/*"), "");
});
