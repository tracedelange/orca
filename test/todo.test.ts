import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { EditError } from "../src/core/edit.ts";
import { queueItems } from "../src/core/queue.ts";
import { addTodo, allTodos, doneTodo, nodeTodo, queueTodo, readTodos } from "../src/core/todo.ts";

function seededRoot(): string {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orca-")), "nodes");
  fs.cpSync(path.resolve(import.meta.dirname, "seed"), root, { recursive: true });
  return root;
}

test("addTodo creates TODO.md and appends; doneTodo keeps the item and its number", () => {
  const root = seededRoot();
  addTodo(root, "work", "  first   idea ");
  addTodo(root, "work", "second idea");
  assert.equal(fs.readFileSync(path.join(root, "work/TODO.md"), "utf8"), "# TODO\n\n- [ ] first idea\n- [ ] second idea\n");
  assert.equal(doneTodo(root, "work", 1), "first idea");
  addTodo(root, "work", "third idea");
  assert.deepEqual(readTodos(root, "work").map((t) => [t.n, t.done, t.text]), [[1, true, "first idea"], [2, false, "second idea"], [3, false, "third idea"]]);
  assert.throws(() => doneTodo(root, "work", 1), /already done/);
  assert.throws(() => doneTodo(root, "work", 9), /no item 9/);
  assert.throws(() => addTodo(root, "work", " "), EditError);
  assert.throws(() => addTodo(root, "nowhere", "x"), /no node at nowhere/);
});

test("queueTodo moves an item to the queue; nodeTodo makes a child node", () => {
  const root = seededRoot();
  addTodo(root, "work", "Add dark mode");
  addTodo(root, "work", "Rewrite the parser");
  queueTodo(root, "work", 1);
  assert.equal(queueItems(fs.readFileSync(path.join(root, "work/CLAUDE.md"), "utf8")).at(-1)?.text, "Add dark mode");
  assert.equal(nodeTodo(root, "work", 2), "work/rewrite-the-parser");
  assert.match(fs.readFileSync(path.join(root, "work/rewrite-the-parser/CLAUDE.md"), "utf8"), /title: Rewrite the parser/);
  assert.deepEqual(readTodos(root, "work").map((t) => t.to), ["queued", "work/rewrite-the-parser"]);
  assert.throws(() => queueTodo(root, "work", 1), /no open item 1/);
});

test("allTodos groups items by node, root included", () => {
  const root = seededRoot();
  addTodo(root, "", "unplaced");
  addTodo(root, "work", "placed");
  assert.deepEqual(allTodos(root).map((g) => [g.path, g.items.length]), [["", 1], ["work", 1]]);
});
