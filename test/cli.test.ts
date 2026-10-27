import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { queueItems } from "../src/core/queue.ts";
import { flatten, readTree } from "../src/core/tree.ts";

const CLI = path.resolve(import.meta.dirname, "../bin/orca.js");

// A temp tree and a temp HOME, so no command reaches the real ~/nodes or ~/.claude.
// test/bin/ssh stands in for workers.
function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orca-"));
  const root = path.join(tmp, "nodes");
  fs.cpSync(path.resolve(import.meta.dirname, "seed"), root, { recursive: true });
  fs.mkdirSync(path.join(tmp, "home"));
  fs.writeFileSync(path.join(tmp, "ssh.log"), "");
  const env = {
    ...process.env,
    NODES_ROOT: root,
    HOME: path.join(tmp, "home"),
    PATH: `${path.resolve(import.meta.dirname, "bin")}:${process.env.PATH}`,
    FAKE_SSH_LOG: path.join(tmp, "ssh.log"),
  };
  const orca = (...args: string[]) => execFileSync(CLI, args, { env, encoding: "utf8", stdio: "pipe" });
  const fails = (args: string[], message: RegExp) =>
    assert.throws(() => orca(...args), (err: { stderr: string }) => message.test(err.stderr));
  return { root, home: env.HOME, orca, fails };
}

test("queue adds tasks and lists them", () => {
  const { root, orca, fails } = setup();
  orca("queue", "work", "Fix", "the", "bug");
  orca("queue", "work", "Add dark mode");
  assert.equal(orca("queue", "work"), "[ ] Fix the bug\n[ ] Add dark mode\n");
  assert.equal(queueItems(fs.readFileSync(path.join(root, "work/CLAUDE.md"), "utf8")).length, 2);
  fails(["queue"], /usage: orca queue/);
});

test("todo adds ideas, checks them off and lists the open ones", () => {
  const { orca, fails } = setup();
  orca("todo", "work", "Park", "this");
  orca("todo", "work", "And this");
  orca("todo", ".", "At the root");
  assert.match(orca("todo", "work", "--done", "1"), /done: Park this/);
  assert.equal(orca("todo", "work"), "2. And this\n");
  assert.equal(orca("todo", "--all"), "/\n1. At the root\nwork\n2. And this\n");
  fails(["todo"], /usage: orca todo/);
});

test("mv, rm and set change the tree", () => {
  const { root, orca, fails } = setup();
  assert.match(orca("mv", "home/household", "work/household"), /moved to work\/household/);
  assert.match(orca("rm", "work/household"), /moved to .*\.trash/);
  orca("set", "work", "--title", "Job", "--goal", "Ship it");
  const work = flatten(readTree(root)).find((n) => n.path === "work");
  assert.deepEqual([work?.title, work?.goal], ["Job", "Ship it"]);
  fails(["mv", "work"], /usage: orca mv/);
  fails(["rm"], /usage: orca rm/);
  fails(["set"], /usage: orca set/);
});

test("tree prints titles indented by depth", () => {
  const { orca } = setup();
  const lines = orca("tree").split("\n");
  assert.ok(lines.includes("  Work"));
  assert.ok(lines.some((l) => /^    \S/.test(l)));
});

test("wait and send need a live session on the node", () => {
  const { orca, fails } = setup();
  assert.equal(orca("wait", "work"), "no live session\n");
  fails(["send", "work", "hi"], /no session in tmux on work/);
  fails(["wait"], /usage: orca wait/);
  fails(["send", "work"], /usage: orca send/);
});

test("wait prints a finished child's status", () => {
  const { root, orca } = setup();
  const dir = path.join(root, "work/.node/sessions");
  fs.mkdirSync(dir, { recursive: true });
  const s = { sessionId: "c1", pid: process.pid, cwd: "x", state: "ready", summary: "All done.", updatedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, "c1.json"), JSON.stringify(s));
  assert.equal(orca("wait", "work"), "ready: All done.\n");
});

test("worker add, ls and rm go through ssh; end finds a session on a worker", () => {
  const { orca, fails } = setup();
  assert.match(orca("worker", "add", "box.tail"), /added worker box \(box\.tail\)/);
  assert.equal(orca("worker", "ls"), "box  box.tail\n");
  assert.equal(orca("end", "r1"), "ended r1 on box\n");
  assert.match(orca("worker", "rm", "box.tail"), /removed worker box\.tail/);
  fails(["worker"], /usage: orca worker/);
  fails(["end", "nope"], /nope/);
});

test("install-hooks writes the hook and the skill under HOME, and --remove takes them out", () => {
  const { home, orca } = setup();
  const settings = path.join(home, ".claude/settings.json");
  assert.match(orca("install-hooks"), /installed orca hooks/);
  assert.match(fs.readFileSync(settings, "utf8"), /orca-hook/);
  assert.ok(fs.existsSync(path.join(home, ".claude/skills/orca/SKILL.md")));
  assert.match(orca("install-hooks", "--remove"), /removed orca hooks/);
  assert.doesNotMatch(fs.readFileSync(settings, "utf8"), /orca-hook/);
});

test("commands check their arguments", () => {
  const { orca, fails } = setup();
  fails(["launch"], /usage: orca launch/);
  fails(["dispatch", "work"], /usage: orca dispatch/);
  fails(["adopt"], /usage: orca adopt/);
  fails(["end"], /usage: orca end/);
  fails(["nonsense"], /usage: orca <command>/);
  assert.match(orca("help"), /usage: orca <command>/);
});
