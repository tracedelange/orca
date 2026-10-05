import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createNode, EditError, moveNode, removeNode, updateNode } from "../src/core/edit.ts";
import { PathError } from "../src/core/paths.ts";
import { flatten, readNodeDetail, readTree } from "../src/core/tree.ts";

function seededRoot(): string {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orca-")), "nodes");
  execFileSync(path.resolve(import.meta.dirname, "../bin/nodes.js"), ["init"], { env: { ...process.env, NODES_ROOT: root } });
  return root;
}
const paths = (root: string) => flatten(readTree(root)).map((n) => n.path);

test("move renames and reparents whole subtrees", () => {
  const root = seededRoot();
  assert.equal(moveNode(root, "personal/side-projects", "work/side"), "work/side");
  assert.ok(paths(root).includes("work/side/example-project"));
  assert.throws(() => moveNode(root, "work", "work/side/inner"), EditError);
  assert.throws(() => moveNode(root, "home", "personal"), EditError);
  assert.throws(() => moveNode(root, "home", "nowhere/home"), EditError);
  assert.throws(() => moveNode(root, "home", "../escaped"), PathError);
  assert.throws(() => moveNode(root, "", "x"), EditError);
});

test("remove moves the subtree to .trash and hides it", () => {
  const root = seededRoot();
  const trashed = removeNode(root, "home");
  assert.ok(fs.existsSync(path.join(trashed, "household", "CLAUDE.md")));
  assert.ok(!paths(root).some((p) => p.startsWith("home")));
  assert.throws(() => removeNode(root, ""), EditError);
});

test("update edits fields and keeps everything else", () => {
  const root = seededRoot();
  const file = path.join(root, "work", "vmt-analyzer", "CLAUDE.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("branch: main", "branch: main # trunk\nowner: me"));
  updateNode(root, "work/vmt-analyzer", { title: "VMT", goal: "New goal" });
  const n = readNodeDetail(root, "work/vmt-analyzer");
  assert.deepEqual([n.title, n.goal, n.extra.owner], ["VMT", "New goal", "me"]);
  assert.match(fs.readFileSync(file, "utf8"), /# trunk/);
  assert.match(n.body, /## Context/);

  updateNode(root, "work/vmt-analyzer", { goal: "" });
  assert.equal(readNodeDetail(root, "work/vmt-analyzer").goal, undefined);
  updateNode(root, "work", { goal: "Added" });
  assert.match(fs.readFileSync(path.join(root, "work", "CLAUDE.md"), "utf8"), /## Goal\nAdded\n\n## Context/);
});

test("create refuses existing nodes and hidden names", () => {
  const root = seededRoot();
  assert.deepEqual(createNode(root, "work/a/b", { goal: "G" }), ["work/a", "work/a/b"]);
  assert.throws(() => createNode(root, "work", {}), EditError);
  assert.throws(() => createNode(root, "work/.hidden", {}), EditError);
});

test("endSession closes the tmux session and drops the session file", async () => {
  const { endSession } = await import("../src/core/edit.ts");
  const root = seededRoot();
  const name = `orca-test-${process.pid}`;
  execFileSync("tmux", ["new-session", "-d", "-s", name, "sleep 300"]);
  const pid = Number(execFileSync("tmux", ["display", "-p", "-t", name, "#{pane_pid}"], { encoding: "utf8" }).trim());
  const dir = path.join(root, "work", ".node", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const s = { sessionId: "t1", pid, cwd: "x", tmux: name, state: "ready", updatedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, "t1.json"), JSON.stringify(s));

  assert.equal(endSession(root, "t1"), "work");
  assert.throws(() => execFileSync("tmux", ["has-session", "-t", `=${name}`], { stdio: "pipe" }));
  assert.ok(!fs.existsSync(path.join(dir, "t1.json")));
  assert.throws(() => endSession(root, "t1"), EditError);
});
