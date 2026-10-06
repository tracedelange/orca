import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createNode, EditError } from "./edit.ts";
import { resolveInRoot } from "./paths.ts";
import { startSession } from "./workers.ts";
import { flatten, readTree } from "./tree.ts";

export type Placement = { path: string; title: string; goal: string };

const SCHEMA = {
  type: "object",
  properties: { path: { type: "string" }, title: { type: "string" }, goal: { type: "string" } },
  required: ["path", "title", "goal"],
};

const SYSTEM = `You file tasks into a tree of nodes. Each node is a folder; its path is its identity.
Pick where the task belongs, inside the given scope.
- If an existing node clearly is this task, return its path, title and goal unchanged.
- Otherwise return a new node: one new lowercase kebab-case folder, 1 to 4 words, under the existing node it fits best.
- title: 2 to 5 words. goal: one sentence saying what done looks like.`;

// Asks Haiku where a prompt belongs under `scope`.
export async function place(root: string, scope: string, prompt: string): Promise<Placement> {
  const nodes = flatten(readTree(root)).filter((n) => within(n.path, scope));
  const outline = nodes.map((n) => `${n.path || "/"} | ${n.title}${n.goal ? ` | ${n.goal}` : ""}`).join("\n");
  const ask = `Scope: ${scope || "/"}\n\nExisting nodes (path | title | goal):\n${outline}\n\nTask:\n${prompt}`;

  return askHaiku(SYSTEM, SCHEMA, ask);
}

// One Haiku call that must answer in `schema`. No tools, no user settings (so no hooks), no saved session.
export async function askHaiku(system: string, schema: object, prompt: string) {
  const { stdout } = await promisify(execFile)("claude", [
    "-p", prompt, "--model", "haiku", "--system-prompt", system, "--json-schema", JSON.stringify(schema),
    "--output-format", "json", "--tools", "", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence",
  ], { cwd: os.tmpdir(), timeout: 60_000 });
  const out = JSON.parse(stdout);
  if (out.is_error || !out.structured_output) throw new EditError(`Haiku call failed: ${out.result ?? "no answer"}`);
  return out.structured_output;
}

// Files the prompt into the tree and starts a session on it. Returns where it went.
export async function dispatch(root: string, scope: string, prompt: string, host?: string) {
  if (!prompt.trim()) throw new EditError("prompt is empty");
  resolveInRoot(root, scope);
  const p = await place(root, scope, prompt);
  const rel = p.path.replace(/^\/+|\/+$/g, "");
  if (!within(rel, scope)) throw new EditError(`placement ${rel} is outside ${scope || "/"}`);

  const created = fs.existsSync(path.join(resolveInRoot(root, rel), "CLAUDE.md"))
    ? []
    : createNode(root, rel, { title: p.title, goal: p.goal, context: `Started from this prompt:\n\n${quote(prompt)}` });
  return { path: rel, title: p.title, created, ...startSession(root, rel, { prompt, host }) };
}

const within = (p: string, scope: string) => scope === "" || p === scope || p.startsWith(scope + "/");
const quote = (s: string) => s.trim().split("\n").map((l) => `> ${l}`).join("\n");
