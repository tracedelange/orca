import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { dispatch } from "../core/dispatch.ts";
import { adoptSession, createNode, endSession, moveNode, removeNode, updateNode } from "../core/edit.ts";
import { rootDir } from "../core/paths.ts";
import { addToQueue, queueItems } from "../core/queue.ts";
import { claim, findClaudePid } from "../core/claims.ts";
import { place } from "../core/dispatch.ts";
import { installHooks, installSkill, sessionsDir, USER_SETTINGS, USER_SKILL } from "../core/sessions.ts";
import { addWorker, pollWorkers, readWorkers, remoteEnd, removeWorker, startSession } from "../core/workers.ts";
import { flatten, nodeContext, readTree, type TreeNode } from "../core/tree.ts";

const root = rootDir();
const TEMPLATES = fileURLToPath(new URL("../../templates/", import.meta.url));
// The "sv" locale formats dates as YYYY-MM-DD in local time.
const today = new Date().toLocaleDateString("sv");
const MARKS: Record<string, string> = { "needs-input": "◆", working: "●", ready: "○" };

const commands: Record<string, (args: string[]) => void | Promise<void>> = {
  new: newNode, mv: move, rm: remove, set, tree: printTree, check, init, launch: launchSession,
  "install-hooks": hooks,
  dispatch: dispatchPrompt,
  end: end,
  claim: claimSession,
  adopt,
  worker,
  queue,
};
const [cmd = "", ...args] = process.argv.slice(2);

try {
  if (!commands[cmd]) throw new Error("usage: nodes <new|mv|rm|set|tree|check|init|launch|dispatch|queue|end|claim|adopt|worker|install-hooks>");
  await commands[cmd](args);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

function newNode(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { title: { type: "string" }, goal: { type: "string" } },
  });
  if (positionals.length !== 1) throw new Error('usage: nodes new <path> [--title "..."] [--goal "..."]');
  requireRoot();
  for (const p of createNode(root, positionals[0], values)) console.log(`created ${p}`);
}

// Adds a task to a node's queue, or lists the queue. The orca server runs the queue.
function queue(argv: string[]) {
  if (argv.length < 1) throw new Error('usage: nodes queue <path> ["task"]');
  requireRoot();
  const [rel, ...task] = argv;
  if (task.length) return addToQueue(root, rel, task.join(" "));
  const file = path.join(root, rel, "CLAUDE.md");
  for (const i of queueItems(fs.readFileSync(file, "utf8"))) console.log(`[${i.mark}] ${i.text}${i.child ? ` → ${i.child}` : ""}`);
}

function move(argv: string[]) {
  if (argv.length !== 2) throw new Error("usage: nodes mv <from> <to>");
  requireRoot();
  console.log(`moved to ${moveNode(root, argv[0], argv[1])}`);
}

function remove(argv: string[]) {
  if (argv.length !== 1) throw new Error("usage: nodes rm <path>");
  requireRoot();
  console.log(`moved to ${removeNode(root, argv[0])}`);
}

function set(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { title: { type: "string" }, goal: { type: "string" } },
  });
  if (positionals.length !== 1) throw new Error('usage: nodes set <path> [--title "..."] [--goal "..."]');
  requireRoot();
  updateNode(root, positionals[0], values);
}

function launchSession(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { resume: { type: "boolean" }, host: { type: "string" } },
  });
  if (positionals.length !== 1) throw new Error("usage: nodes launch <path> [--resume] [--host <worker>]");
  requireRoot();
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
  throw new Error("usage: nodes worker <add|rm> <host> | nodes worker ls");
}

async function dispatchPrompt(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { host: { type: "string" } } });
  if (positionals.length !== 2) throw new Error('usage: nodes dispatch <scope> "<prompt>" [--host <worker>]');
  requireRoot();
  const d = await dispatch(root, positionals[0], positionals[1], values.host);
  for (const p of d.created) console.log(`created ${p}`);
  console.log(`dispatched to ${d.path}${d.host ? ` on ${d.host}` : ""}; attach with: ${attachCommand(d)}`);
}

function adopt(argv: string[]) {
  if (argv.length !== 1) throw new Error("usage: nodes adopt <session id>");
  requireRoot();
  const a = adoptSession(root, argv[0]);
  console.log(`moved into tmux on ${a.path}; attach with: tmux attach -t ${a.tmux}`);
}

async function end(argv: string[]) {
  if (argv.length !== 1) throw new Error("usage: nodes end <tmux name or session id>");
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
  if (positionals.length !== 1 && !values.auto) throw new Error('usage: nodes claim <path> | nodes claim --auto "<what this session does>" [--scope <path>]');
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
    for (const s of n.sessions.filter((s) => s.pid === pid)) fs.rmSync(path.join(sessionsDir(path.join(root, n.path)), `${s.sessionId}.json`));
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
  copySeed(path.join(TEMPLATES, "seed"), root);
  console.log(`created ${root}`);
}

function copySeed(from: string, to: string) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) copySeed(src, dst);
    else fs.writeFileSync(dst, fs.readFileSync(src, "utf8").replaceAll("{{date}}", today));
  }
}

function requireRoot() {
  if (!fs.existsSync(path.join(root, "CLAUDE.md"))) throw new Error(`no node root at ${root}; run "nodes init"`);
}
