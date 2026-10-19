import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { hooksInstalled } from "./install.ts";
import { parseNode } from "./node.ts";
import { expandHome, resolveInRoot } from "./paths.ts";
import { isAlive } from "../remote/state.mjs";

// working: Claude is running. needs-input: blocked on a permission or question. ready: turn finished.
export type SessionState = "working" | "needs-input" | "ready";

export type Session = {
  sessionId: string;
  pid: number;   // the Claude Code process; the session is gone when it exits
  cwd: string;
  tmux?: string; // set when the session runs in tmux, so the viewer can attach
  host?: string; // worker name for sessions on another machine
  node?: string; // node path, for worker sessions the laptop launched
  state: SessionState;
  summary?: string;
  prompt?: string; // first line of the user's last prompt
  finishedAt?: string; // when the last turn ended; the viewer shows results newer than you have seen as new
  updatedAt: string;
};

// A repo entry is a local path, or "<worker>:<path>" for a path on a worker.
export function splitRepo(repo: string): { host?: string; path: string } {
  const m = repo.match(/^([A-Za-z0-9_.-]+):(.+)$/);
  return m ? { host: m[1], path: m[2] } : { path: repo };
}

export const sessionsDir = (nodeDir: string) => path.join(nodeDir, ".node", "sessions");
// Deletes a session's state file, so the node stops showing it.
export const dropSession = (nodeDir: string, sessionId: string) =>
  fs.rmSync(path.join(sessionsDir(nodeDir), `${sessionId}.json`), { force: true });
// The node's latest conversation and the folder it ran in. It outlives the session, so Resume can find it.
export const lastSessionFile = (nodeDir: string) => path.join(nodeDir, ".node", "last.json");

function readLastSession(nodeDir: string): { sessionId: string; cwd: string } | undefined {
  try {
    const last = JSON.parse(fs.readFileSync(lastSessionFile(nodeDir), "utf8"));
    return fs.existsSync(last.cwd) ? last : undefined;
  } catch {
    return undefined;
  }
}

export function liveTmuxSessions(): Set<string> {
  try {
    const out = execFileSync("tmux", ["list-sessions", "-F", "#{session_name}"], { encoding: "utf8", stdio: "pipe" });
    return new Set(out.split("\n").filter(Boolean));
  } catch {
    return new Set(); // no tmux server running means no sessions
  }
}

export { isAlive };

// Reads a node's session files, deleting any whose Claude process is gone.
export function readSessions(nodeDir: string): Session[] {
  const dir = sessionsDir(nodeDir);
  if (!fs.existsSync(dir)) return [];
  const sessions: Session[] = [];
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".json"))) {
    const file = path.join(dir, name);
    const s: Session = JSON.parse(fs.readFileSync(file, "utf8"));
    if (s.pid && isAlive(s.pid)) sessions.push(s);
    else fs.rmSync(file, { force: true });
  }
  return sessions.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
}

// ---- Launch ----

export type LaunchOptions = {
  prompt?: string;   // Claude starts on it straight away
  resume?: boolean;  // reopen the node's last conversation
  resumeId?: string; // reopen this conversation; needs the folder it ran in as cwd
  cwd?: string;      // defaults to the node folder
  model?: string;
  permissionMode?: string;
  allowedTools?: string[];
};

// tmux names follow the node path; tmux forbids "." and ":" in names.
export const tmuxBase = (root: string, dir: string) => "orca-" + (path.relative(root, dir) || "root").replace(/[^A-Za-z0-9_-]/g, "-");

export function launch(root: string, rel: string, opts: LaunchOptions = {}): string {
  const dir = resolveInRoot(root, rel);
  if (!hooksInstalled()) throw new Error('orca hooks are not installed; run "orca install-hooks"');
  const node = parseNode(fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), path.basename(dir));
  // --continue finds only conversations that started in the node folder. A claimed session runs
  // elsewhere, so reopen the latest conversation by id, in its own folder.
  const last = opts.resume && !opts.resumeId ? readLastSession(dir) : undefined;
  if (last) opts = { ...opts, resumeId: last.sessionId, cwd: last.cwd };

  const base = tmuxBase(root, dir);
  const live = liveTmuxSessions();
  let name = base;
  for (let i = 2; live.has(name); i++) name = `${base}-${i}`;

  const claude = ["claude", "-n", node.title];
  for (const repo of node.repos) if (!splitRepo(repo).host) claude.push("--add-dir", expandHome(repo));
  if (opts.cwd) claude.push("--add-dir", dir); // so a session running elsewhere can still edit its node
  if (opts.model) claude.push("--model", opts.model);
  if (opts.permissionMode) claude.push("--permission-mode", opts.permissionMode);
  for (const tool of opts.allowedTools ?? []) claude.push("--allowedTools", tool);
  if (opts.resumeId) claude.push("--resume", opts.resumeId);
  else if (opts.resume) claude.push("--continue");
  if (opts.prompt) claude.push("--", opts.prompt);

  // Passing the command as separate arguments makes tmux exec it directly, with no shell quoting.
  // ORCA_NODE tells the hook which node this is, whatever folder the session runs in.
  // A custom root must reach the hook, which otherwise assumes ~/nodes.
  const env = ["-e", `ORCA_NODE=${path.relative(root, dir)}`];
  if (process.env.NODES_ROOT) env.push("-e", `NODES_ROOT=${root}`);
  execFileSync("tmux", ["new-session", "-d", "-s", name, "-c", opts.cwd ?? dir, "-x", "200", "-y", "50", ...env, ...claude]);
  return name;
}

// ---- Shells ----

// A plain shell in tmux, started in a node folder. The @orca_shell option marks it as a shell, and
// @orca_node records its node. It ends when you exit the shell or close it.
export type Shell = { tmux: string; path: string; cwd: string; created: string };

export function launchShell(root: string, rel: string): string {
  const dir = resolveInRoot(root, rel);
  const base = tmuxBase(root, dir).replace(/^orca-/, "orca-sh-");
  const live = liveTmuxSessions();
  let name = base;
  for (let i = 2; live.has(name); i++) name = `${base}-${i}`;
  execFileSync("tmux", ["new-session", "-d", "-s", name, "-c", dir, "-x", "200", "-y", "50",
    ";", "set-option", "@orca_shell", "1", ";", "set-option", "@orca_node", path.relative(root, dir)]);
  return name;
}

export function listShells(): Shell[] {
  try {
    const out = execFileSync("tmux", ["list-sessions", "-F", "#{@orca_shell}\t#{session_name}\t#{@orca_node}\t#{pane_current_path}\t#{session_created}"], { encoding: "utf8", stdio: "pipe" });
    return out.split("\n").map((l) => l.split("\t")).filter((f) => f[0] === "1")
      .map(([, tmux, p, cwd, created]) => ({ tmux, path: p, cwd, created: new Date(Number(created) * 1000).toISOString() }));
  } catch {
    return []; // no tmux server running means no shells
  }
}

export function closeShell(name: string) {
  if (!listShells().some((s) => s.tmux === name)) throw new Error(`no shell ${name}`);
  execFileSync("tmux", ["kill-session", "-t", `=${name}`]);
}
