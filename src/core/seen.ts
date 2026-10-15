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

// When you parked each session, by session id. A session that acts after that wakes up (the viewer compares updatedAt).
const parkedFile = (root: string) => path.join(root, ".orca", "parked.json");

export function readParked(root: string): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(parkedFile(root), "utf8"));
  } catch {
    return {};
  }
}

// Parks or unparks one session and drops sessions that are no longer live.
export function setParked(root: string, id: string, park: boolean, live: Set<string>) {
  const parked = { ...readParked(root) };
  if (park) parked[id] = new Date().toISOString();
  else delete parked[id];
  const kept = Object.fromEntries(Object.entries(parked).filter(([p]) => live.has(p)));
  fs.mkdirSync(path.dirname(parkedFile(root)), { recursive: true });
  fs.writeFileSync(parkedFile(root), JSON.stringify(kept));
}
