import fs from "node:fs";
import path from "node:path";

// The finishedAt of the last result you looked at, by session id. One file, so every device agrees.
const seenFile = (root: string) => path.join(root, ".orca", "seen.json");

export function readSeen(root: string): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(seenFile(root), "utf8"));
  } catch {
    return {};
  }
}

// Adds the marks and drops sessions that are no longer live.
export function markSeen(root: string, marks: Record<string, unknown>, live: Set<string>) {
  const seen = { ...readSeen(root) };
  for (const [id, at] of Object.entries(marks)) if (typeof at === "string") seen[id] = at;
  const kept = Object.fromEntries(Object.entries(seen).filter(([id]) => live.has(id)));
  fs.mkdirSync(path.dirname(seenFile(root)), { recursive: true });
  fs.writeFileSync(seenFile(root), JSON.stringify(kept));
}
