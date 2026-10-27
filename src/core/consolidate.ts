import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EditError, endSession } from "./edit.ts";
import { resolveInRoot } from "./paths.ts";
import { flatten, readTree, type TreeNode } from "./tree.ts";
import { startSession } from "./workers.ts";

const TEMPLATE = fileURLToPath(new URL("../../templates/consolidate.md", import.meta.url));
const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

// Open rounds by node path. A round locks its subtree in the viewer until you accept or reject it.
export type Round = { tmux: string; commit: string; startedAt: string };
const roundsFile = (root: string) => path.join(root, ".orca", "consolidations.json");
const clean = (rel: string) => rel.replace(/^\/+|\/+$/g, "");
const inside = (p: string, scope: string) => !scope || p === scope || p.startsWith(`${scope}/`);

export function readRounds(root: string): Record<string, Round> {
  try {
    return JSON.parse(fs.readFileSync(roundsFile(root), "utf8"));
  } catch {
    return {};
  }
}

function writeRounds(root: string, rounds: Record<string, Round>) {
  fs.mkdirSync(path.dirname(roundsFile(root)), { recursive: true });
  fs.writeFileSync(roundsFile(root), JSON.stringify(rounds));
}

// The viewer's edits call this. The round's own session edits through the CLI, which does not.
export function assertUnlocked(root: string, ...rels: string[]) {
  for (const scope of Object.keys(readRounds(root))) {
    const p = rels.map(clean).find((rel) => inside(rel, scope));
    if (p !== undefined) throw new EditError(`${p || "/"} is locked while ${scope || "/"} is consolidating`);
  }
}

// Marks locked nodes for the viewer: `lock` on every node in a round, `round` on the round's node.
export function attachRounds(root: string, tree: TreeNode) {
  const rounds = Object.entries(readRounds(root));
  if (!rounds.length) return tree;
  for (const n of flatten(tree)) {
    const hit = rounds.find(([scope]) => inside(n.path, scope));
    if (!hit) continue;
    n.lock = hit[0];
    if (n.path === hit[0]) n.round = { ...hit[1], changed: changedFiles(root, hit[0]).length };
  }
  return tree;
}

const changedFiles = (root: string, scope: string) =>
  git(root, "status", "--porcelain", "--", scope || ".").split("\n").filter(Boolean);

// The node tree must be a git repo. Commits any uncommitted changes so a round can be rolled back.
// Returns the commit the round starts from.
export function snapshot(root: string, rel: string): string {
  try {
    git(root, "rev-parse", "--git-dir");
  } catch {
    throw new EditError(`${root} is not a git repo; run "git -C ${root} init" first`);
  }
  if (git(root, "status", "--porcelain")) {
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", `snapshot: before consolidating ${rel || "/"}`);
  }
  return git(root, "rev-parse", "--short", "HEAD");
}

export function consolidate(root: string, rel: string) {
  resolveInRoot(root, rel);
  const scope = clean(rel);
  const rounds = readRounds(root);
  const overlap = Object.keys(rounds).find((r) => inside(scope, r) || inside(r, scope));
  if (overlap !== undefined) throw new EditError(`${overlap || "/"} is already consolidating`);
  const commit = snapshot(root, scope);
  const live = flatten(readTree(root))
    .filter((n) => n.sessions.length && inside(n.path, scope))
    .map((n) => n.path || "/");
  const prompt = fs.readFileSync(TEMPLATE, "utf8")
    .replaceAll("{{path}}", scope || "/")
    .replaceAll("{{live}}", live.length ? live.join(", ") : "none")
    .replaceAll("{{date}}", new Date().toISOString().slice(0, 10));
  const s = startSession(root, scope, { prompt });
  writeRounds(root, { ...rounds, [scope]: { tmux: s.tmux, commit, startedAt: new Date().toISOString() } });
  return { commit, live, ...s };
}

// Accept commits the subtree's changes. Reject puts the subtree back as it was at the last commit.
// Either way the round's session ends first, so it cannot write after, and the lock goes.
export function finishRound(root: string, rel: string, accept: boolean) {
  const scope = clean(rel);
  const rounds = readRounds(root);
  const round = rounds[scope];
  if (!round) throw new EditError(`${scope || "/"} is not consolidating`);
  try {
    endSession(root, round.tmux);
  } catch {} // the session already ended
  const target = scope || ".";
  if (accept && changedFiles(root, scope).length) {
    git(root, "add", "-A", "--", target);
    git(root, "commit", "-q", "-m", `consolidate: ${scope || "/"}`, "--", target);
  }
  if (!accept) {
    git(root, "checkout", "--", target);
    git(root, "clean", "-fdq", "--", target);
  }
  delete rounds[scope];
  writeRounds(root, rounds);
}
