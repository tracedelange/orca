import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseNode } from "./node.ts";
import { expandHome, resolveInRoot } from "./paths.ts";
import { hooksInstalled as sharedHooksInstalled, isAlive, mergeHooks } from "../remote/state.mjs";

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
  finishedAt?: string; // when the last turn ended; the viewer shows results newer than you have seen as new
  updatedAt: string;
};

const HOOK = fileURLToPath(new URL("../../bin/orca-hook.js", import.meta.url));
export const USER_SETTINGS = path.join(os.homedir(), ".claude", "settings.json");
const SKILL_SRC = fileURLToPath(new URL("../../templates/skill/SKILL.md", import.meta.url));
export const USER_SKILL = path.join(os.homedir(), ".claude", "skills", "orca", "SKILL.md");

// The /orca skill lets a session anywhere register itself with `orca claim`.
export function installSkill(file = USER_SKILL, remove = false) {
  if (remove) return fs.rmSync(path.dirname(file), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(SKILL_SRC, file);
}

// A repo entry is a local path, or "<worker>:<path>" for a path on a worker.
export function splitRepo(repo: string): { host?: string; path: string } {
  const m = repo.match(/^([A-Za-z0-9_.-]+):(.+)$/);
  return m ? { host: m[1], path: m[2] } : { path: repo };
}

export const sessionsDir = (nodeDir: string) => path.join(nodeDir, ".node", "sessions");

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

// ---- Hook install ----

function hookCommand(event: string): string {
  // The node on PATH, not process.execPath: Homebrew's versioned path breaks on upgrade.
  const node = execFileSync("sh", ["-c", "command -v node"], { encoding: "utf8" }).trim();
  const env = process.env.NODES_ROOT ? `NODES_ROOT="${process.env.NODES_ROOT}" ` : "";
  return `${env}"${node}" "${HOOK}" ${event}`;
}

function readSettings(file: string) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

export const hooksInstalled = (file = USER_SETTINGS): boolean => sharedHooksInstalled(readSettings(file));

// Adds (or with remove, deletes) orca's hook groups in a Claude settings file. Other hooks are untouched.
export function installHooks(file = USER_SETTINGS, remove = false) {
  const settings = mergeHooks(readSettings(file), hookCommand, remove);
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.orca-backup`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
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
