import fs from "node:fs";
import path from "node:path";
import { createNode, EditError } from "./edit.ts";
import { resolveInRoot } from "./paths.ts";
import { addToQueue } from "./queue.ts";
import { flatten, readTree } from "./tree.ts";

// A node's TODO.md is a checklist of parked ideas. Nothing runs it, and sessions read it only when asked.
// Done items stay in the file. An item's number is its place among all items, done ones included;
// new items go at the end, so the numbers never change.
//
//   - [ ] open idea
//   - [x] done idea
//   - [x] idea that went to the queue → queued
//   - [x] idea that became a node → <child path>

const ITEM = /^- \[([ x])\] (.+?)(?: → (\S+))?$/;

type Todo = { n: number; done: boolean; text: string; to?: string };

function fileOf(root: string, rel: string) {
  const dir = resolveInRoot(root, rel);
  if (!fs.existsSync(path.join(dir, "CLAUDE.md"))) throw new EditError(`no node at ${rel}`);
  return path.join(dir, "TODO.md");
}

const readLines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n") : []);

export function readTodos(root: string, rel: string): Todo[] {
  return readLines(fileOf(root, rel)).map((l) => l.match(ITEM)).filter((m) => m !== null)
    .map((m, i) => ({ n: i + 1, done: m[1] === "x", text: m[2], to: m[3] }));
}

// Every node's items, for the global list.
export function allTodos(root: string) {
  return flatten(readTree(root))
    .map((n) => ({ path: n.path, title: n.title, items: readTodos(root, n.path) }))
    .filter((g) => g.items.length);
}

export function addTodo(root: string, rel: string, idea: string) {
  const text = idea.trim().replace(/\s+/g, " ");
  if (!text) throw new EditError("idea is empty");
  const file = fileOf(root, rel);
  const lines = readLines(file);
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  if (!lines.length) lines.push("# TODO", "");
  lines.push(`- [ ] ${text}`, "");
  fs.writeFileSync(file, lines.join("\n"));
}

// Rewrites the line of item `n` with `change`, which gets the item and returns its new line.
function rewrite(root: string, rel: string, n: number, change: (done: boolean, text: string, to?: string) => string) {
  const file = fileOf(root, rel);
  const lines = readLines(file);
  let seen = 0;
  const at = lines.findIndex((l) => ITEM.test(l) && ++seen === n);
  if (at === -1) throw new EditError(`no item ${n} in ${rel || "/"}`);
  const [, mark, text, to] = lines[at].match(ITEM)!;
  lines[at] = change(mark === "x", text, to);
  fs.writeFileSync(file, lines.join("\n"));
  return text;
}

// Checks off item `n`, noting where it went (`queued` or a child path). Returns the item's text.
export function doneTodo(root: string, rel: string, n: number, to?: string): string {
  return rewrite(root, rel, n, (done, text) => {
    if (done) throw new EditError(`item ${n} is already done`);
    return `- [x] ${text}${to ? ` → ${to}` : ""}`;
  });
}

// Opens item `n` again. A queue task or child node made from it stays.
export function undoTodo(root: string, rel: string, n: number) {
  rewrite(root, rel, n, (done, text) => {
    if (!done) throw new EditError(`item ${n} is not done`);
    return `- [ ] ${text}`;
  });
}

export function editTodo(root: string, rel: string, n: number, idea: string) {
  const text = idea.trim().replace(/\s+/g, " ");
  if (!text) throw new EditError("idea is empty");
  rewrite(root, rel, n, (done, _, to) => `- [${done ? "x" : " "}] ${text}${to ? ` → ${to}` : ""}`);
}

// Moves item `n` into the node's ## Queue, where a background worker picks it up.
export function queueTodo(root: string, rel: string, n: number) {
  const item = readTodos(root, rel).find((t) => t.n === n);
  if (!item || item.done) throw new EditError(`no open item ${n} in ${rel || "/"}`);
  addToQueue(root, rel, item.text);
  doneTodo(root, rel, n, "queued");
}

// Turns item `n` into a child node with the item as its title and goal. Returns the child's path.
export function nodeTodo(root: string, rel: string, n: number): string {
  const item = readTodos(root, rel).find((t) => t.n === n);
  if (!item || item.done) throw new EditError(`no open item ${n} in ${rel || "/"}`);
  const slug = item.text.toLowerCase().split(/\s+/).slice(0, 5).join("-").replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "idea";
  const base = rel ? `${rel}/${slug}` : slug;
  let child = base;
  for (let i = 2; fs.existsSync(path.join(root, child)); i++) child = `${base}-${i}`;
  createNode(root, child, { title: item.text, goal: item.text });
  doneTodo(root, rel, n, child);
  return child;
}
