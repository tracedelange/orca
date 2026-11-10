import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expandHome, resolveInRoot } from "./paths.ts";
import { splitRepo } from "./sessions.ts";
import { flatten, readTree } from "./tree.ts";

// Raw facts about recent work under a node, for a person or a later LLM pass to interpret.
// Per node: its dated Log lines and the docs it changed. Per local repo: its commits. A repo that
// several nodes name is listed once, with every node that names it.
export type Summary = {
  path: string;
  since: string; // YYYY-MM-DD of the cutoff, inclusive
  nodes: { path: string; title: string; log: string[]; docs: string[] }[];
  repos: { repo: string; nodes: string[]; commits: string[] }[];
};

const LOG_LINE = /^- (\d{4}-\d{2}-\d{2}): (.+)$/;

// With hours, the last N hours. Otherwise from local midnight `days - 1` days back: 1 means today.
export function cutoff({ days = 1, hours }: { days?: number; hours?: number }): Date {
  if (hours) return new Date(Date.now() - hours * 3_600_000);
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (days - 1));
  return d;
}

// Log lines carry only a date, so they count from the cutoff's whole day.
export function summarize(root: string, rel: string, from: Date): Summary {
  const dir = resolveInRoot(root, rel);
  const start = flatten(readTree(root)).find((n) => path.join(root, n.path) === dir);
  if (!start) throw new Error(`no node at ${rel}`);
  const since = ymd(from);

  const nodes = [];
  const repos = new Map<string, string[]>();
  for (const n of flatten(start).filter((n) => !n.archived)) {
    const nodeDir = path.join(root, n.path);
    const log = logSection(fs.readFileSync(path.join(nodeDir, "CLAUDE.md"), "utf8"))
      .map((l) => l.match(LOG_LINE))
      .filter((m) => m !== null && m[1] >= since)
      .map((m) => `${m![1]}: ${m![2]}`);
    const docs = changedDocs(nodeDir, from);
    if (log.length || docs.length) nodes.push({ path: n.path, title: n.title, log, docs });
    for (const r of n.repos.filter((r) => !splitRepo(r).host)) repos.set(r, [...(repos.get(r) ?? []), n.path]);
  }

  return {
    path: start.path,
    since,
    nodes,
    repos: [...repos].map(([repo, names]) => ({ repo, nodes: names, commits: commits(repo, from) }))
      .filter((r) => r.commits.length),
  };
}

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// Lines under "## Log", up to the next heading.
function logSection(text: string): string[] {
  const m = text.match(/^##\s+Log\s*$([\s\S]*?)(?=^#{1,6}\s|(?![\s\S]))/im);
  return m ? m[1].split("\n").map((l) => l.trim()) : [];
}

// Files in docs/ modified since the cutoff. The node tree is often uncommitted, so this uses mtime, not git.
function changedDocs(nodeDir: string, cutoff: Date): string[] {
  const docs = path.join(nodeDir, "docs");
  if (!fs.existsSync(docs)) return [];
  return fs.readdirSync(docs).filter((f) => fs.statSync(path.join(docs, f)).mtime >= cutoff).sort();
}

// Commits on any branch since the cutoff, newest first, as "<hash> <date> <subject>".
// A missing folder or one that is not a git repo gives none.
function commits(repo: string, cutoff: Date): string[] {
  try {
    return execFileSync("git", ["-C", expandHome(repo), "log", "--all", `--since=${cutoff.toISOString()}`, "--format=%h %ad %s", "--date=short"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export function summaryMarkdown(s: Summary): string {
  const out = [`# Summary of ${s.path || "/"} since ${s.since}`];
  if (!s.nodes.length && !s.repos.length) out.push("", "Nothing recorded.");
  for (const n of s.nodes) {
    out.push("", `## ${n.title} (${n.path || "/"})`);
    for (const l of n.log) out.push(`- ${l}`);
    if (n.docs.length) out.push(`- Docs changed: ${n.docs.join(", ")}`);
  }
  for (const r of s.repos) {
    out.push("", `## Repo ${r.repo}`, `Named by: ${r.nodes.map((p) => p || "/").join(", ")}`, "");
    for (const c of r.commits) out.push(`- ${c}`);
  }
  return out.join("\n") + "\n";
}
