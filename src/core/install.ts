import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hooksInstalled as installedIn, writeHooks } from "../remote/state.mjs";

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

function hookCommand(event: string): string {
  // The node on PATH, not process.execPath: Homebrew's versioned path breaks on upgrade.
  const node = execFileSync("sh", ["-c", "command -v node"], { encoding: "utf8" }).trim();
  const env = process.env.NODES_ROOT ? `NODES_ROOT="${process.env.NODES_ROOT}" ` : "";
  return `${env}"${node}" "${HOOK}" ${event}`;
}

export const hooksInstalled = (file = USER_SETTINGS): boolean => installedIn(file);

// Adds (or with remove, deletes) orca's hook groups in a Claude settings file. Other hooks are untouched.
export const installHooks = (file = USER_SETTINGS, remove = false) => writeHooks(file, hookCommand, remove);
