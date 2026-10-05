import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export class PathError extends Error {}

export const expandHome = (p: string) => p.replace(/^~(?=$|\/)/, os.homedir());

export function rootDir(): string {
  return path.resolve(expandHome(process.env.NODES_ROOT || "~/nodes"));
}

// The only security-sensitive code: every user-supplied node path goes through here.
export function resolveInRoot(root: string, rel: string): string {
  if (rel.includes("\0") || path.isAbsolute(rel)) throw new PathError(`invalid path: ${rel}`);
  const abs = path.resolve(root, rel);
  if (!isInside(root, abs)) throw new PathError(`path escapes root: ${rel}`);
  // Also follow symlinks, so a link inside the tree cannot point outside it.
  if (fs.existsSync(abs) && !isInside(fs.realpathSync(root), fs.realpathSync(abs))) {
    throw new PathError(`path escapes root: ${rel}`);
  }
  return abs;
}

function isInside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}
