import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { addWorker, attachArgs, findWorker, pollWorkers, readWorkers, remoteEnd, removeWorker, startSession } from "../src/core/workers.ts";

// test/bin/ssh stands in for the worker: it logs each call and answers like the remote scripts.
process.env.PATH = `${path.resolve(import.meta.dirname, "bin")}:${process.env.PATH}`;

function seededRoot(): string {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orca-")), "nodes");
  fs.cpSync(path.resolve(import.meta.dirname, "seed"), root, { recursive: true });
  return root;
}

// Each call as [host, remote command, input].
function sshLog() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orca-ssh-")), "log");
  fs.writeFileSync(file, "");
  process.env.FAKE_SSH_LOG = file;
  return () => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t"));
}

test("adding a worker installs the scripts and records it; removing undoes both", () => {
  const root = seededRoot();
  const calls = sshLog();
  assert.deepEqual(addWorker(root, "box.tail"), { host: "box.tail", name: "box" });
  assert.deepEqual(addWorker(root, "box.tail"), { host: "box.tail", name: "box" }); // a re-add replaces
  assert.deepEqual(readWorkers(root), [{ host: "box.tail", name: "box" }]);
  assert.equal(findWorker(root, "box")?.host, "box.tail");
  assert.match(calls()[0][1], /tar -C ~\/.orca\/bin -xf -/);
  assert.match(calls()[1][1], /install\.mjs$/);

  removeWorker(root, "box");
  assert.match(calls().at(-1)![1], /install\.mjs --remove/);
  assert.deepEqual(readWorkers(root), []);
  assert.throws(() => removeWorker(root, "box"), /no worker box/);
  assert.throws(() => addWorker(root, "bad;host"), /bad host/);
});

test("polling tags each worker's sessions and reports an unreachable worker", async () => {
  const root = seededRoot();
  sshLog();
  addWorker(root, "box.tail");
  fs.writeFileSync(path.join(root, ".orca", "workers.json"), JSON.stringify([{ host: "box.tail", name: "box" }, { host: "down", name: "down" }]));
  const [box, down] = await pollWorkers(root);
  assert.equal(box.home, "/home/box");
  assert.deepEqual(box.sessions.map((s) => [s.sessionId, s.host]), [["r1", "box"]]);
  assert.deepEqual(down.sessions, []);
  assert.match(down.error!, /ssh/);
});

test("a session on a worker runs in the node's repo there, with the node chain as system prompt", () => {
  const root = seededRoot();
  const calls = sshLog();
  addWorker(root, "box.tail");
  // work has no repo, so it runs in a folder named after the node.
  assert.deepEqual(startSession(root, "work", { host: "box", prompt: "go", resume: true }), { tmux: "orca-work", host: "box" });
  const spec = JSON.parse(calls().at(-1)![2]);
  assert.equal(spec.dir, "~/orca/work");
  assert.equal(spec.node, "work");
  assert.deepEqual(spec.args.slice(-3), ["--continue", "--", "go"]);

  const file = path.join(root, "work/vmt-analyzer/CLAUDE.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("repo: ~/code/vmt-analyzer", "repo: box:~/code/vmt"));
  startSession(root, "work/vmt-analyzer", { host: "box" });
  assert.equal(JSON.parse(calls().at(-1)![2]).dir, "~/code/vmt");
  assert.throws(() => startSession(root, "work", { host: "nope" }), /no worker nope/);
});

test("ending a worker session kills its tmux session, or its process", () => {
  const calls = sshLog();
  const w = { host: "box.tail", name: "box" };
  const s = { sessionId: "r1", pid: 7, cwd: "/x", state: "working", updatedAt: "" } as const;
  remoteEnd(w, { ...s, tmux: "orca-work" });
  assert.equal(calls().at(-1)![1], "tmux kill-session -t '=orca-work'");
  remoteEnd(w, s);
  assert.equal(calls().at(-1)![1], "kill 7");
  assert.throws(() => remoteEnd(w, { ...s, tmux: "x'; rm -rf ~" }), /bad tmux name/);
  assert.equal(attachArgs(w, "orca-work", ["-f", "read-only"]).at(-1), "tmux attach-session -f read-only -t '=orca-work'");
});
