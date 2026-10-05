import fs from "node:fs";
import path from "node:path";
import { isAlive } from "../remote/state.mjs";

export { findClaudePid } from "../remote/state.mjs";

// A claim attaches a Claude process to a node regardless of its folder. Written by `nodes claim`,
// read by the hook, and gone once the process exits.
const claimsDir = (root: string) => path.join(root, ".orca", "claims");

export function claim(root: string, nodeDir: string, pid: number) {
  const dir = claimsDir(root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({ node: path.relative(root, nodeDir), at: new Date().toISOString() }));
}

// True when any live claim exists. Drops claims whose process has exited, so the hook stops
// looking up its pid once the last claimed session ends.
export function hasClaims(root: string): boolean {
  const dir = claimsDir(root);
  if (!fs.existsSync(dir)) return false;
  let live = 0;
  for (const name of fs.readdirSync(dir)) {
    if (isAlive(Number.parseInt(name))) live++;
    else fs.rmSync(path.join(dir, name), { force: true });
  }
  return live > 0;
}

// The claimed node for this process, if any.
export function claimedNodeDir(root: string, pid: number): string | undefined {
  const dir = claimsDir(root);
  const file = path.join(dir, `${pid}.json`);
  if (!fs.existsSync(file)) return undefined;
  const nodeDir = path.join(root, JSON.parse(fs.readFileSync(file, "utf8")).node);
  return fs.existsSync(path.join(nodeDir, "CLAUDE.md")) ? nodeDir : undefined;
}
