import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createNode, EditError, updateNode } from "./edit.ts";
import { resolveInRoot } from "./paths.ts";
import { startSession } from "./workers.ts";
import { flatten, readTree } from "./tree.ts";

export type Placement = { path: string; title: string; goal: string };
export type Suggestion = { sure: boolean; choices: Placement[] };

const PLACEMENT = {
  type: "object",
  properties: { path: { type: "string" }, title: { type: "string" }, goal: { type: "string" } },
  required: ["path", "title", "goal"],
};
const SCHEMA = {
  type: "object",
  properties: { sure: { type: "boolean" }, choices: { type: "array", items: PLACEMENT, minItems: 1, maxItems: 3 } },
  required: ["sure", "choices"],
};

const SYSTEM = `You file tasks into a tree of nodes. Each node is a folder; its path is its identity.
Pick where the task belongs, inside the given scope.
- If an existing node clearly is this task, return its path, title and goal unchanged.
- Otherwise return a new node: one new lowercase kebab-case folder, 1 to 4 words, under the existing node it fits best.
- title: 2 to 5 words. goal: one sentence saying what done looks like.
- sure: true only when one place clearly fits. If the task could belong under more than one node (for example it names a "map", "settings" or "viewer" that several projects could own), set sure to false.
- choices: when sure, one placement. When not sure, 2 or 3 placements under different existing nodes, best first. Every choice follows the rules above: an existing node that is this task, or a new folder under one.`;

// Asks Haiku where a prompt belongs under `scope`. Choices outside the scope are dropped.
export async function suggest(root: string, scope: string, prompt: string): Promise<Suggestion> {
  const nodes = flatten(readTree(root)).filter((n) => within(n.path, scope));
  const outline = nodes.map((n) => `${n.path || "/"} | ${n.title}${n.goal ? ` | ${n.goal}` : ""}`).join("\n");
  const ask = `Scope: ${scope || "/"}\n\nExisting nodes (path | title | goal):\n${outline}\n\nTask:\n${prompt}`;

  const s: Suggestion = await askHaiku(SYSTEM, SCHEMA, ask);
  const choices = s.choices.map((c) => ({ ...c, path: c.path.replace(/^\/+|\/+$/g, "") })).filter((c) => within(c.path, scope));
  if (!choices.length) throw new EditError(`placement is outside ${scope || "/"}`);
  const sure = s.sure || choices.length === 1;
  return { sure, choices: sure ? choices.slice(0, 1) : choices };
}

// Haiku's best guess, for callers that cannot ask.
export const place = async (root: string, scope: string, prompt: string) => (await suggest(root, scope, prompt)).choices[0];

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
// Throws with the choices when Haiku is not sure; the viewer asks instead (see queueDispatch).
export async function dispatch(root: string, scope: string, prompt: string, host?: string, parent?: string) {
  if (!prompt.trim()) throw new EditError("prompt is empty");
  resolveInRoot(root, scope);
  const { sure, choices } = await suggest(root, scope, prompt);
  if (!sure) throw new EditError(`not sure where this goes: ${choices.map((c) => c.path || "/").join(", ")}. Dispatch again with a narrower scope.`);
  return file(root, choices[0], prompt, host, parent);
}

function file(root: string, p: Placement, prompt: string, host?: string, parent?: string) {
  const created = fs.existsSync(path.join(resolveInRoot(root, p.path), "CLAUDE.md"))
    ? []
    : createNode(root, p.path, { title: p.title, goal: p.goal, context: `Started from this prompt:\n\n${quote(prompt)}` });
  // Set before the session starts, so the child never shows on the rail.
  if (parent !== undefined && parent !== p.path) updateNode(root, p.path, { parent });
  return { path: p.path, title: p.title, created, ...startSession(root, p.path, { prompt, host }) };
}

const within = (p: string, scope: string) => scope === "" || p === scope || p.startsWith(scope + "/");
const quote = (s: string) => s.trim().split("\n").map((l) => `> ${l}`).join("\n");

// Dispatches in flight, so the viewer can show them while Haiku places them. In memory: a restart drops them.
// A job with choices waits for the user to pick one (chooseDispatch).
export type Job = { id: string; prompt: string; scope: string; host?: string; startedAt: string; error?: string; choices?: Placement[] };
const jobs = new Map<string, Job>();
let nextId = 0;

export const listJobs = () => [...jobs.values()];

// Starts a dispatch in the background and returns its job at once.
// On success the job leaves the list and the new session takes its place; on failure it stays with the error.
export function queueDispatch(root: string, scope: string, prompt: string, host?: string): Job {
  if (!prompt.trim()) throw new EditError("prompt is empty");
  const job: Job = { id: String(++nextId), prompt, scope, host, startedAt: new Date().toISOString() };
  jobs.set(job.id, job);
  run(root, job);
  return job;
}

export function retryDispatch(root: string, id: string) {
  const job = jobs.get(id);
  if (!job) throw new EditError("no such dispatch");
  delete job.error;
  delete job.choices;
  job.startedAt = new Date().toISOString();
  run(root, job);
}

// Files a waiting job at the choice the user picked.
export function chooseDispatch(root: string, id: string, index: number) {
  const job = jobs.get(id);
  const choice = job?.choices?.[index];
  if (!job || !choice) throw new EditError("no such choice");
  const filed = file(root, choice, job.prompt, job.host);
  jobs.delete(id);
  return filed;
}

export const dismissDispatch = (id: string) => jobs.delete(id);

async function run(root: string, job: Job) {
  try {
    resolveInRoot(root, job.scope);
    const { sure, choices } = await suggest(root, job.scope, job.prompt);
    if (!sure) return void (job.choices = choices);
    file(root, choices[0], job.prompt, job.host);
    jobs.delete(job.id);
  } catch (err) {
    job.error = (err as Error).message;
  }
}
