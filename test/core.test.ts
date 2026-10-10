import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseNode } from "../src/core/node.ts";
import { PathError, resolveInRoot } from "../src/core/paths.ts";
import { flatten, readTree } from "../src/core/tree.ts";

const CLI = path.resolve(import.meta.dirname, "../bin/orca.js");

function seededRoot(): string {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orca-")), "nodes");
  execFileSync(CLI, ["init"], { env: { ...process.env, NODES_ROOT: root } });
  return root;
}

test("resolveInRoot rejects escapes", () => {
  const root = seededRoot();
  for (const bad of ["../../etc/passwd", "..", "work/../../x", "/etc/passwd", "work\0"]) {
    assert.throws(() => resolveInRoot(root, bad), PathError, bad);
  }
  assert.equal(resolveInRoot(root, "work/../personal"), path.join(root, "personal"));
  assert.equal(resolveInRoot(root, ""), root);
});

test("resolveInRoot rejects symlinks that leave the root", () => {
  const root = seededRoot();
  fs.symlinkSync(os.tmpdir(), path.join(root, "work", "outside"));
  assert.throws(() => resolveInRoot(root, "work/outside"), PathError);
});

test("parseNode keeps broken files as nodes with errors", () => {
  assert.deepEqual(parseNode("no frontmatter", "dir").issues.map((i) => i.message), ["missing frontmatter"]);
  const bad = parseNode("---\ntitle: [unclosed\n---\nbody", "dir");
  assert.equal(bad.title, "dir");
  assert.equal(bad.issues[0].level, "error");
  const goal = parseNode("---\ntitle: X\n---\n## Goal\nShip it\nby Friday.\n\n## Context\nx", "dir");
  assert.equal(goal.goal, "Ship it by Friday.");
  const old = parseNode("---\ntitle: X\ngoal: Old place\n---\n", "dir");
  assert.equal(old.goal, "Old place");
  assert.equal(old.issues[0].level, "warning");
  const odd = parseNode("---\ntitle: X\nstatus: busy\nowner: me\n---\n", "dir");
  assert.deepEqual(odd.issues, []);
  assert.deepEqual(odd.extra, { owner: "me" });
});

test("init seeds a tree that passes check", () => {
  const root = seededRoot();
  const nodes = flatten(readTree(root));
  assert.equal(nodes.length, 9);
  assert.deepEqual(nodes.flatMap((n) => n.issues), []);
  execFileSync(CLI, ["check"], { env: { ...process.env, NODES_ROOT: root } });
});

test("new creates missing parents and refuses to overwrite", () => {
  const root = seededRoot();
  const env = { ...process.env, NODES_ROOT: root };
  execFileSync(CLI, ["new", "work/a/b", "--goal", "Ship: the thing"], { env });
  const tree = readTree(root);
  const b = flatten(tree).find((n) => n.path === "work/a/b");
  assert.equal(b?.goal, "Ship: the thing");
  assert.equal(flatten(tree).find((n) => n.path === "work/a")?.title, "a");
  assert.throws(() => execFileSync(CLI, ["new", "work/a/b"], { env, stdio: "pipe" }));
});

test("oversized organizational nodes get a warning", () => {
  const root = seededRoot();
  fs.appendFileSync(path.join(root, "work", "CLAUDE.md"), "line\n".repeat(41));
  const work = readTree(root).children.find((n) => n.path === "work");
  assert.equal(work?.issues[0].level, "warning");
});

test("findNodeDir matches inside the tree and by most specific repo", async () => {
  const { findNodeDir } = await import("../src/core/tree.ts");
  const root = fs.realpathSync(seededRoot());
  const work = path.join(root, "work", "CLAUDE.md");
  fs.writeFileSync(work, fs.readFileSync(work, "utf8").replace("title: Work", "title: Work\nrepo:\n  - /code/a\n  - /code/b"));
  // vmt-analyzer has repo ~/code/vmt-analyzer; give a nested one to test specificity.
  const vmt = path.join(root, "work", "vmt-analyzer", "CLAUDE.md");
  fs.writeFileSync(vmt, fs.readFileSync(vmt, "utf8").replace("repo: ~/code/vmt-analyzer", "repo: /code/a/vmt"));

  assert.equal(findNodeDir(root, "/code/b/src"), path.join(root, "work"));
  assert.equal(findNodeDir(root, "/code/a/other"), path.join(root, "work"));
  assert.equal(findNodeDir(root, "/code/a/vmt/src"), path.join(root, "work", "vmt-analyzer"));
  assert.equal(findNodeDir(root, "/code/ab"), undefined);
  assert.equal(findNodeDir(root, path.join(root, "home", "household", "notes")), path.join(root, "home", "household"));
});

test("installHooks adds and removes only orca's hooks", async () => {
  const { installHooks, hooksInstalled } = await import("../src/core/sessions.ts");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orca-")), "settings.json");
  const mine = { hooks: [{ type: "command", command: "echo mine" }] };
  fs.writeFileSync(file, JSON.stringify({ model: "x", hooks: { Stop: [mine] } }));
  installHooks(file);
  installHooks(file); // idempotent
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(hooksInstalled(file));
  assert.equal(after.hooks.Stop.length, 2);
  assert.equal(after.model, "x");
  installHooks(file, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { model: "x", hooks: { Stop: [mine] } });
});

test("hook writes state for a session whose cwd is in a repo, and nothing otherwise", () => {
  const root = fs.realpathSync(seededRoot());
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-repo-")));
  const vmt = path.join(root, "work", "vmt-analyzer");
  const file = path.join(vmt, "CLAUDE.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("repo: ~/code/vmt-analyzer", `repo: ${repo}`));
  const hook = (event: string, input: object) =>
    execFileSync(path.resolve(import.meta.dirname, "../bin/orca-hook.js"), [event], {
      input: JSON.stringify(input), env: { ...process.env, NODES_ROOT: root, TMUX_PANE: "" },
    });

  hook("UserPromptSubmit", { session_id: "s1", cwd: repo });
  const s = JSON.parse(fs.readFileSync(path.join(vmt, ".node", "sessions", "s1.json"), "utf8"));
  assert.equal(s.state, "working");
  assert.equal(s.cwd, repo);
  assert.ok(s.pid > 0);
  assert.equal(readTree(root).children.find((n) => n.path === "work")?.children[0].sessions.length, 1);

  hook("SessionEnd", { session_id: "s1", cwd: repo });
  assert.ok(!fs.existsSync(path.join(vmt, ".node", "sessions", "s1.json")));
  hook("UserPromptSubmit", { session_id: "s2", cwd: os.tmpdir() });
  assert.deepEqual(flatten(readTree(root)).flatMap((n) => n.sessions), []);
});

test("hook injects the node chain on SessionStart only outside the tree", () => {
  const root = fs.realpathSync(seededRoot());
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-repo-")));
  const file = path.join(root, "work", "vmt-analyzer", "CLAUDE.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("repo: ~/code/vmt-analyzer", `repo: ${repo}`));
  const start = (cwd: string) =>
    execFileSync(path.resolve(import.meta.dirname, "../bin/orca-hook.js"), ["SessionStart"], {
      input: JSON.stringify({ session_id: "s", cwd }), env: { ...process.env, NODES_ROOT: root, TMUX_PANE: "" }, encoding: "utf8",
    });
  const ctx = JSON.parse(start(repo)).hookSpecificOutput.additionalContext;
  assert.match(ctx, /# Node: \/ \(Nodes\)[\s\S]*# Node: work \(Work\)[\s\S]*# Node: work\/vmt-analyzer/);
  assert.match(ctx, /Status:/);
  assert.equal(start(path.join(root, "work")), "");
});

test("hook attaches a session in an unrelated folder to its claimed node", async () => {
  const { claim, findClaudePid } = await import("../src/core/claims.ts");
  const root = fs.realpathSync(seededRoot());
  // The hook runs as our child. It resolves "the Claude process" to a real Claude above us
  // (when tests run inside Claude Code), otherwise to this test process.
  const pid = findClaudePid(true) ?? process.pid;
  claim(root, path.join(root, "home", "household"), pid);
  execFileSync(path.resolve(import.meta.dirname, "../bin/orca-hook.js"), ["UserPromptSubmit"], {
    input: JSON.stringify({ session_id: "c1", cwd: os.tmpdir() }), env: { ...process.env, NODES_ROOT: root, TMUX_PANE: "" },
  });
  const s = JSON.parse(fs.readFileSync(path.join(root, "home", "household", ".node", "sessions", "c1.json"), "utf8"));
  assert.equal(s.pid, pid);
  assert.equal(s.state, "working");
});

test("worker sessions land on their launched node or a host-prefixed repo", async () => {
  const { attachWorkerSessions } = await import("../src/core/tree.ts");
  const root = seededRoot();
  const file = path.join(root, "work", "CLAUDE.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("title: Work", "title: Work\nrepo:\n  - box:~/code/w\n  - /code/local"));
  const s = (id: string, cwd: string, node?: string) => ({ sessionId: id, pid: 1, cwd, node, state: "ready" as const, updatedAt: "" });
  const tree = attachWorkerSessions(readTree(root), [{
    host: "100.1.2.3", name: "box", home: "/home/t",
    sessions: [s("a", "/home/t/code/w/src"), s("b", "/tmp/x", "home/household"), s("c", "/code/local"), s("d", "/home/t/other")],
  }]);
  const at = (p: string) => flatten(tree).find((n) => n.path === p)!.sessions.map((x) => x.sessionId);
  assert.deepEqual(at("work"), ["a"]);
  assert.deepEqual(at("home/household"), ["b"]);
  assert.deepEqual(flatten(tree).flatMap((n) => n.sessions).length, 2);
});
