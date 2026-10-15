import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { markSeen, readParked, readSeen, setParked } from "../src/core/seen.ts";

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "orca-seen-"));

test("seen marks are added, non-strings ignored, and ended sessions dropped", () => {
  const root = tmpRoot();
  assert.deepEqual(readSeen(root), {});
  markSeen(root, { a: "2026-10-15T10:00:00Z", b: "2026-10-15T11:00:00Z", c: 42 }, new Set(["a", "b", "c"]));
  assert.deepEqual(readSeen(root), { a: "2026-10-15T10:00:00Z", b: "2026-10-15T11:00:00Z" });
  markSeen(root, { a: "2026-10-15T12:00:00Z" }, new Set(["a"]));
  assert.deepEqual(readSeen(root), { a: "2026-10-15T12:00:00Z" });
});

test("parking records the time, unparking removes it, and ended sessions are dropped", () => {
  const root = tmpRoot();
  assert.deepEqual(readParked(root), {});
  const before = new Date().toISOString();
  setParked(root, "a", true, new Set(["a", "b"]));
  setParked(root, "b", true, new Set(["a", "b"]));
  assert.ok(readParked(root).a >= before);
  setParked(root, "b", false, new Set(["a", "b"]));
  assert.deepEqual(Object.keys(readParked(root)), ["a"]);
  setParked(root, "c", true, new Set(["c"]));
  assert.deepEqual(Object.keys(readParked(root)), ["c"]);
});
