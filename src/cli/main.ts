import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { consolidate } from "../core/consolidate.ts";
import { dispatch, place } from "../core/dispatch.ts";
import { adoptSession, createNode, endSession, moveNode, removeNode, updateNode } from "../core/edit.ts";
import { hooksInstalled, installHooks, installSkill, USER_SETTINGS, USER_SKILL } from "../core/install.ts";
import { resolveInRoot, rootDir } from "../core/paths.ts";
import { addToQueue, queueItems } from "../core/queue.ts";
import { addTodo, allTodos, doneTodo, editTodo, readTodos, undoTodo } from "../core/todo.ts";
import { claim, claimedNodeDir, findClaudePid } from "../core/claims.ts";
import { dropSession, liveTmuxSessions, readSessions, tmuxBase } from "../core/sessions.ts";
import { addWorker, pollWorkers, readWorkers, remoteEnd, removeWorker, startSession } from "../core/workers.ts";
import { flatten, nodeContext, readTree, type TreeNode } from "../core/tree.ts";
import { daemon } from "./daemon.ts";

const root = rootDir();
const TEMPLATES = fileURLToPath(new URL("../../templates/", import.meta.url));
const MARKS: Record<string, string> = { "needs-input": "◆", working: "●", ready: "○" };
// `orca new` and `orca set` take the same fields.
const FIELDS = { title: { type: "string" }, goal: { type: "string" } } as const;

const commands: Record<string, (args: string[]) => void | Promise<void>> = {
  new: newNode, mv: move, rm: remove, set, tree: printTree, check, init, launch: launchSession,
  "install-hooks": hooks,
  dispatch: dispatchPrompt,
  consolidate: consolidateNode,
  end,
  claim: claimSession,
  adopt,
  worker,
  queue,
  todo,
  wait,
  send,
  ...daemon,
  up,
  down: daemon.stop,
  status,
  uninstall,
  help: () => console.log(HELP),
};
const HELP = `usage: orca <command>

server:  up | down | status | restart | open | logs | uninstall
nodes:   new | mv | rm | set | tree | check | init | queue | todo
claude:  launch | dispatch | consolidate | end | claim | adopt | worker | install-hooks
child:   wait | send

Sub-nodes: a session that runs \`orca dispatch\` or \`orca launch\` becomes the parent of that node.
The child stays off the viewer's rail, and the parent answers its questions:
  orca wait <path>           blocks until the child finishes or asks; prints its status and screen.
                             It can take longer than a Bash timeout, so run it in the background.
  orca send <path> "reply"   types the reply into the child's session
If the parent cannot answer, it asks the user in its own session.`;
const [cmd = "help", ...args] = process.argv.slice(2);

try {
  if (!commands[cmd]) throw new Error(HELP);
  await commands[cmd](args);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

function newNode(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: FIELDS });
  if (positionals.length !== 1) throw new Error('usage: orca new <path> [--title "..."] [--goal "..."]');
  requireRoot();
  for (const p of createNode(root, positionals[0], values)) console.log(`created ${p}`);
}

// Adds a task to a node's queue, or lists the queue. The orca server runs the queue.
function queue(argv: string[]) {
  if (argv.length < 1) throw new Error('usage: orca queue <path> ["task"]');
  requireRoot();
  const [rel, ...task] = argv;
  if (task.length) return addToQueue(root, rel, task.join(" "));
  const file = path.join(resolveInRoot(root, rel), "CLAUDE.md");
  for (const i of queueItems(fs.readFileSync(file, "utf8"))) console.log(`[${i.mark}] ${i.text}${i.child ? ` → ${i.child}` : ""}`);
}

// Parked ideas in a node's TODO.md: adds, edits, checks off or reopens one, or lists the open ones. "." is the root.
function todo(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { done: { type: "string" }, undo: { type: "string" }, edit: { type: "string" }, all: { type: "boolean" } },
  });
  requireRoot();
  const print = (items: ReturnType<typeof readTodos>) => items.filter((t) => !t.done).forEach((t) => console.log(`${t.n}. ${t.text}`));
  if (values.all) {
    for (const g of allTodos(root).filter((g) => g.items.some((t) => !t.done))) console.log(g.path || "/"), print(g.items);
    return;
  }
  if (!positionals.length) throw new Error('usage: orca todo <path> ["idea"] | orca todo <path> --done|--undo <n> | orca todo <path> --edit <n> "idea" | orca todo --all');
  const [first, ...idea] = positionals;
  const rel = first === "." ? "" : first.replace(/^\/+|\/+$/g, "");
  if (values.done) return console.log(`done: ${doneTodo(root, rel, Number(values.done))}`);
  if (values.undo) return undoTodo(root, rel, Number(values.undo));
  if (values.edit) return editTodo(root, rel, Number(values.edit), idea.join(" "));
  if (idea.length) return addTodo(root, rel, idea.join(" "));
  print(readTodos(root, rel));
}

function move(argv: string[]) {
  if (argv.length !== 2) throw new Error("usage: orca mv <from> <to>");
  requireRoot();
  console.log(`moved to ${moveNode(root, argv[0], argv[1])}`);
}

function remove(argv: string[]) {
  if (argv.length !== 1) throw new Error("usage: orca rm <path>");
  requireRoot();
  console.log(`moved to ${removeNode(root, argv[0])}`);
}

function set(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { ...FIELDS, archived: { type: "boolean" } } });
  if (positionals.length !== 1) throw new Error('usage: orca set <path> [--title "..."] [--goal "..."] [--archived]');
  requireRoot();
  updateNode(root, positionals[0], values);
}

function launchSession(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { resume: { type: "boolean" }, host: { type: "string" } },
  });
  if (positionals.length !== 1) throw new Error("usage: orca launch <path> [--resume] [--host <worker>]");
  requireRoot();
  setParent(positionals[0]);
  const s = startSession(root, positionals[0], values);
  console.log(`started ${s.tmux}${s.host ? ` on ${s.host}` : ""}; attach with: ${attachCommand(s)}`);
}

function attachCommand(s: { tmux: string; host?: string }) {
  const host = s.host && readWorkers(root).find((w) => w.name === s.host)?.host;
  return host ? `ssh -t ${host} tmux attach -t ${s.tmux}` : `tmux attach -t ${s.tmux}`;
}

function worker(argv: string[]) {
  const [sub, host] = argv;
  requireRoot();
  if (sub === "add" && host) {
    const w = addWorker(root, host);
    return console.log(`added worker ${w.name} (${w.host}); its Claude sessions now report to this machine`);
  }
  if (sub === "rm" && host) return removeWorker(root, host), console.log(`removed worker ${host}`);
  if (sub === "ls") return readWorkers(root).forEach((w) => console.log(`${w.name}  ${w.host}`));
  throw new Error("usage: orca worker <add|rm> <host> | orca worker ls");
}

async function dispatchPrompt(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { host: { type: "string" } } });
  if (positionals.length !== 2) throw new Error('usage: orca dispatch <scope> "<prompt>" [--host <worker>]');
  requireRoot();
  const d = await dispatch(root, positionals[0], positionals[1], values.host, callerNode());
  for (const p of d.created) console.log(`created ${p}`);
  console.log(`dispatched to ${d.path}${d.host ? ` on ${d.host}` : ""}; attach with: ${attachCommand(d)}`);
}

// Commits the node tree, then starts a session that proposes and applies a consolidation of the subtree.
function consolidateNode(argv: string[]) {
  if (argv.length !== 1) throw new Error("usage: orca consolidate <path>");
  requireRoot();
  const c = consolidate(root, argv[0], path.join(TEMPLATES, "consolidate.md"));
  console.log(`snapshot ${c.commit}; skipping live nodes: ${c.live.join(", ") || "none"}`);
  console.log(`started ${c.tmux}; attach with: ${attachCommand(c)}`);
}

// The node of the Claude session that ran this command, if any.
function callerNode(): string | undefined {
  const pid = findClaudePid(true);
  if (!pid) return undefined;
  const n = flatten(readTree(root)).find((n) => n.sessions.some((s) => s.pid === pid && !s.host));
  if (n) return n.path;
  const claimed = claimedNodeDir(root, pid);
  return claimed && path.relative(root, claimed);
}

function setParent(rel: string) {
  const parent = callerNode();
  if (parent !== undefined && parent !== rel.replace(/^\/+|\/+$/g, "")) updateNode(root, rel, { parent });
}

// Blocks until the child's session finishes its turn or asks something, then prints what it shows.
async function wait(argv: string[]) {
  if (argv.length !== 1) throw new Error("usage: orca wait <path>");
  requireRoot();
  const dir = resolveInRoot(root, argv[0]);
  const tmux = tmuxBase(root, dir);
  for (;;) {
    const sessions = readSessions(dir);
    // No session file yet right after a dispatch: wait while its tmux session is alive.
    if (!sessions.length && !liveTmuxSessions().has(tmux)) return console.log("no live session");
    const s = sessions.find((s) => s.state !== "working");
    if (sessions.length && s) {
      console.log(`${s.state}: ${s.summary ?? ""}`);
      if (s.tmux) console.log(execFileSync("tmux", ["capture-pane", "-p", "-t", `=${s.tmux}:`], { encoding: "utf8" }).trimEnd());
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function send(argv: string[]) {
  if (argv.length !== 2) throw new Error('usage: orca send <path> "message"');
  requireRoot();
  const s = readSessions(resolveInRoot(root, argv[0])).find((s) => s.tmux);
  if (!s) throw new Error(`no session in tmux on ${argv[0]}`);
  execFileSync("tmux", ["send-keys", "-t", `=${s.tmux}:`, "-l", argv[1]]);
  execFileSync("tmux", ["send-keys", "-t", `=${s.tmux}:`, "Enter"]);
  console.log(`sent to ${s.tmux}`);
}

function adopt(argv: string[]) {
  if (argv.length !== 1) throw new Error("usage: orca adopt <session id>");
  requireRoot();
  const a = adoptSession(root, argv[0]);
  console.log(`moved into tmux on ${a.path}; attach with: tmux attach -t ${a.tmux}`);
}

async function end(argv: string[]) {
  if (argv.length !== 1) throw new Error("usage: orca end <tmux name or session id>");
  requireRoot();
  const id = argv[0];
  for (const w of await pollWorkers(root)) {
    const s = w.sessions.find((x) => x.sessionId === id || x.tmux === id);
    if (s) return remoteEnd(w, s), console.log(`ended ${id} on ${w.name}`);
  }
  console.log(`ended session on ${endSession(root, id) || "/"}`);
}

// Run from inside a Claude session (the /orca skill does this): attaches the session to a node.
async function claimSession(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { auto: { type: "string" }, scope: { type: "string", default: "" } },
  });
  if (positionals.length !== 1 && !values.auto) throw new Error('usage: orca claim <path> | orca claim --auto "<what this session does>" [--scope <path>]');
  requireRoot();
  const pid = findClaudePid(true);
  if (!pid) throw new Error("run this from inside a Claude Code session");

  let rel = positionals[0]?.replace(/^\/+|\/+$/g, "");
  let fields: { title?: string; goal?: string; context?: string } = {};
  if (!rel) {
    const p = await place(root, values.scope, values.auto!);
    rel = p.path.replace(/^\/+|\/+$/g, "");
    fields = { title: p.title, goal: p.goal, context: `Claimed by a session working on:\n\n> ${values.auto!.trim()}` };
  }
  if (!fs.existsSync(path.join(root, rel, "CLAUDE.md"))) {
    for (const p of createNode(root, rel, fields)) console.log(`created ${p}`);
  }
  // Drop this session's state from any node it showed on before; the hook rewrites it on the claimed node.
  for (const n of flatten(readTree(root))) {
    for (const s of n.sessions.filter((s) => s.pid === pid)) dropSession(path.join(root, n.path), s.sessionId);
  }
  claim(root, path.join(root, rel), pid);
  console.log(`attached this session to ${rel}\n`);
  console.log(nodeContext(root, path.join(root, rel)));
}

function hooks(argv: string[]) {
  const remove = argv.includes("--remove");
  installHooks(USER_SETTINGS, remove);
  installSkill(USER_SKILL, remove);
  console.log(`${remove ? "removed orca hooks from" : "installed orca hooks in"} ${USER_SETTINGS} (backup: ${USER_SETTINGS}.orca-backup)`);
  console.log(`${remove ? "removed" : "installed"} the /orca skill at ${USER_SKILL}`);
}

function printTree() {
  requireRoot();
  const walk = (n: TreeNode, depth: number) => {
    const flag = n.issues.length ? `  (${n.issues.length} to check)` : "";
    const sessions = n.sessions.map((s) => `  ${MARKS[s.state]} ${s.tmux ?? s.cwd}: ${s.state}`).join("");
    console.log(`${"  ".repeat(depth)}${n.title}${flag}${sessions}`);
    for (const c of n.children) walk(c, depth + 1);
  };
  walk(readTree(root), 0);
}

function check() {
  requireRoot();
  let errors = 0;
  let warnings = 0;
  for (const n of flatten(readTree(root))) {
    for (const issue of n.issues) {
      if (issue.level === "error") errors++;
      else warnings++;
      console.log(`${issue.level.padEnd(7)}  ${n.path || "/"}  ${issue.message}`);
    }
  }
  console.log(`${errors} error(s), ${warnings} warning(s)`);
  if (errors) process.exitCode = 1;
}

function init() {
  if (fs.existsSync(root)) throw new Error(`${root} already exists`);
  fs.mkdirSync(root, { recursive: true });
  fs.copyFileSync(path.join(TEMPLATES, "root.md"), path.join(root, "CLAUDE.md"));
  console.log(`created ${root}`);
}

// Safe to run again. A rerun also rewrites the hook path, which moves when the Node version changes.
function up() {
  hooks([]);
  if (!fs.existsSync(path.join(root, "CLAUDE.md"))) init();
  daemon.start();
}

async function status() {
  await daemon.status();
  console.log(`hooks: ${hooksInstalled() ? "installed" : "not installed"}`);
  console.log(`root: ${root}`);
}

// Never deletes the node tree: it holds the user's notes.
function uninstall() {
  daemon.stop();
  hooks(["--remove"]);
  console.log(`your nodes are still at ${root}. Delete that folder if you no longer want them.`);
}

function requireRoot() {
  if (!fs.existsSync(path.join(root, "CLAUDE.md"))) throw new Error(`no node root at ${root}; run "orca init"`);
}
