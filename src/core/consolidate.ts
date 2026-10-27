import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { resolveInRoot } from "./paths.ts";
import { flatten, readTree } from "./tree.ts";
import { startSession } from "./workers.ts";

const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

// The node tree must be a git repo. Commits any uncommitted changes so a round can be rolled back.
// Returns the commit the round starts from.
export function snapshot(root: string, rel: string): string {
  try {
    git(root, "rev-parse", "--git-dir");
  } catch {
    throw new Error(`${root} is not a git repo; run "git -C ${root} init" first`);
  }
  if (git(root, "status", "--porcelain")) {
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", `snapshot: before consolidating ${rel || "/"}`);
  }
  return git(root, "rev-parse", "--short", "HEAD");
}

export function consolidate(root: string, rel: string, templateFile: string) {
  resolveInRoot(root, rel);
  const commit = snapshot(root, rel);
  const scope = rel.replace(/^\/+|\/+$/g, "");
  const live = flatten(readTree(root))
    .filter((n) => n.sessions.length && (!scope || n.path === scope || n.path.startsWith(`${scope}/`)))
    .map((n) => n.path || "/");
  const prompt = fs.readFileSync(templateFile, "utf8")
    .replaceAll("{{path}}", scope || "/")
    .replaceAll("{{live}}", live.length ? live.join(", ") : "none")
    .replaceAll("{{date}}", new Date().toISOString().slice(0, 10))
    .replaceAll("{{root}}", root);
  return { commit, live, ...startSession(root, scope, { prompt }) };
}
