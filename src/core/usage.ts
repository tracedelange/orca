import { execFileSync } from "node:child_process";
import fs from "node:fs";

// Plan usage from the endpoint Claude Code's /usage reads. The cache file is shared with
// the Hammerspoon panel in ~/.hammerspoon/init.lua, so the two together call it at most every 270s.
const CACHE = "/tmp/claude_usage.json";
const MAX_AGE_MS = 270_000;

type Window = { utilization: number; resets_at: string | null } | null;
export type Usage = { email: string | null; five_hour: Window; seven_day: Window } | { error: string };

export async function readUsage(): Promise<Usage> {
  let age = Infinity;
  try { age = Date.now() - fs.statSync(CACHE).mtimeMs; } catch {}
  if (age > MAX_AGE_MS) {
    const creds = execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { encoding: "utf8", stdio: "pipe" });
    const token = JSON.parse(creds).claudeAiOauth.accessToken;
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "user-agent": "claude-code/1.0.0" },
    });
    fs.writeFileSync(CACHE, await res.text());
  }
  const d = JSON.parse(fs.readFileSync(CACHE, "utf8"));
  if (d.error) return { error: "token expired" };
  return { email: authEmail(), five_hour: d.five_hour ?? null, seven_day: d.seven_day ?? null };
}

// The account Claude Code is logged in as, the same source as the panel's "Claude" row.
function authEmail(): string | null {
  try { return JSON.parse(execFileSync("claude", ["auth", "status"], { encoding: "utf8", stdio: "pipe" })).email ?? null; } catch { return null; }
}
