// Session-state and hook-install logic shared by the laptop (src/) and the worker scripts (hook.mjs, install.mjs).
// Plain JavaScript so it also runs on a worker's older Node, which cannot run TypeScript.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Notification", "Stop", "SessionEnd"];

// working: Claude is running. needs-input: blocked on a permission or question. ready: turn finished.
export function nextState(event, notification, prev = "ready") {
  if (event === "UserPromptSubmit" || event === "PostToolUse") return "working";
  if (event === "Notification") {
    // idle_prompt fires a while after Stop; the turn is already "ready".
    return ["permission_prompt", "elicitation_dialog", "agent_needs_input"].includes(notification ?? "") ? "needs-input" : prev;
  }
  return "ready"; // SessionStart, Stop
}

// Agents are asked (root CLAUDE.md) to end each reply with "Status: <one sentence>", or "Done: <one sentence>"
// once the node's goal is met. Take the last line with the given label.
export function statusLine(message, label = "status") {
  const matches = [...message.matchAll(new RegExp(`^[*_\\s]*${label}[*_\\s]*:[*_\\s]*(.+?)[*_\\s]*$`, "gim"))];
  return matches.at(-1)?.[1];
}

const SHELLS = ["sh", "bash", "zsh", "dash", "fish"];

// The Claude Code process above this one. Hooks and the Bash tool both run through a shell.
// With strict, returns undefined unless an ancestor is actually named claude.
export function findClaudePid(strict = false) {
  let firstNonShell;
  let pid = process.ppid;
  for (let i = 0; i < 8 && pid > 1; i++) {
    const out = execFileSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8" }).trim();
    const [ppid, ...comm] = out.split(/\s+/);
    const name = path.basename(comm.join(" ")).replace(/^-/, "");
    if (name === "claude") return pid;
    if (firstNonShell === undefined && !SHELLS.includes(name)) firstNonShell = pid;
    pid = Number(ppid);
  }
  return strict ? undefined : (firstNonShell ?? process.ppid);
}

export function tmuxSession() {
  if (!process.env.TMUX_PANE) return undefined;
  return execFileSync("tmux", ["display-message", "-p", "-t", process.env.TMUX_PANE, "#S"], { encoding: "utf8" }).trim();
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// The next session state, given the previous one and a hook event.
export function nextSession(prev, event, input, extra) {
  return {
    sessionId: input.session_id,
    pid: prev.pid ?? extra.pid ?? findClaudePid(),
    cwd: input.cwd,
    tmux: prev.tmux ?? tmuxSession(),
    ...extra.fields,
    state: nextState(event, input.notification_type, prev.state),
    summary: event === "Stop" ? (statusLine(input.last_assistant_message ?? "") ?? statusLine(input.last_assistant_message ?? "", "done")) : prev.summary,
    // Set when the last turn ended with "Done:"; the viewer then offers End + archive.
    done: event === "Stop" ? !!statusLine(input.last_assistant_message ?? "", "done") || undefined : event === "UserPromptSubmit" ? undefined : prev.done,
    prompt: event === "UserPromptSubmit" ? input.prompt?.trim().split("\n")[0].slice(0, 200) : prev.prompt,
    finishedAt: event === "Stop" ? new Date().toISOString() : prev.finishedAt,
    updatedAt: new Date().toISOString(),
  };
}

const isOrcaHook = (h) => !!h.command?.includes("orca-hook.js") || !!h.command?.includes(".orca/bin/hook.mjs");

const readSettings = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {});

export function hooksInstalled(file) {
  const { hooks } = readSettings(file);
  return HOOK_EVENTS.every((e) => hooks?.[e]?.some((g) => g.hooks.some(isOrcaHook)));
}

// Adds (or with remove, deletes) orca's hook groups in parsed Claude settings. Other hooks are untouched.
function mergeHooks(settings, commandFor, remove = false) {
  const hooks = (settings.hooks ??= {});
  for (const event of HOOK_EVENTS) {
    const groups = (hooks[event] ?? []).filter((g) => !g.hooks.some(isOrcaHook));
    if (!remove) groups.push({ hooks: [{ type: "command", command: commandFor(event) }] });
    if (groups.length) hooks[event] = groups;
    else delete hooks[event];
  }
  return settings;
}

// Merges orca's hooks into a Claude settings file, keeping a backup of the old one.
export function writeHooks(file, commandFor, remove = false) {
  const settings = mergeHooks(readSettings(file), commandFor, remove);
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.orca-backup`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
}
