import fs from "node:fs";
import path from "node:path";
import { marked } from "marked";
import { parseNode, type NodeFields } from "./node.ts";
import { expandHome, resolveInRoot } from "./paths.ts";
import { readSessions, splitRepo, type Session } from "./sessions.ts";
import type { WorkerState } from "./workers.ts";

export type TreeNode = NodeFields & {
  path: string;
  childCount: number;
  descendantCount: number;
  sessions: Session[];
  children: TreeNode[];
};

const ORG_MAX_LINES = 40;

export function readTree(root: string): TreeNode {
  return readNode(root, "");
}

export function flatten(node: TreeNode): TreeNode[] {
  return [node, ...node.children.flatMap(flatten)];
}

export function readNodeDetail(root: string, rel: string) {
  const dir = resolveInRoot(root, rel);
  const { body, ...fields } = load(dir).node;
  return {
    path: path.relative(root, dir).split(path.sep).join("/"),
    file: path.join(dir, "CLAUDE.md"),
    ...fields,
    sessions: readSessions(dir),
    body,
    html: marked.parse(body, { async: false }),
  };
}

function readNode(root: string, rel: string): TreeNode {
  const dir = path.join(root, rel);
  const { node, childNames } = load(dir);
  const { body, ...fields } = node;
  const children = childNames.map((name) => readNode(root, rel ? `${rel}/${name}` : name));
  return {
    path: rel,
    ...fields,
    childCount: children.length,
    descendantCount: children.reduce((n, c) => n + 1 + c.descendantCount, 0),
    sessions: readSessions(dir),
    children,
  };
}

// The node a Claude session in `cwd` belongs to: the nearest node above it inside the tree,
// otherwise the node whose repo path contains it most specifically.
export function findNodeDir(root: string, cwd: string): string | undefined {
  const inside = (p: string, base: string) => p === base || p.startsWith(base + path.sep);
  if (inside(cwd, root)) {
    for (let d = cwd; inside(d, root); d = path.dirname(d)) {
      if (fs.existsSync(path.join(d, "CLAUDE.md"))) return d;
    }
    return undefined;
  }
  let best: { dir: string; len: number } | undefined;
  for (const n of flatten(readTree(root))) {
    for (const repo of n.repos.filter((r) => !splitRepo(r).host).map((r) => path.resolve(expandHome(r)))) {
      if (inside(cwd, repo) && repo.length > (best?.len ?? -1)) best = { dir: path.join(root, n.path), len: repo.length };
    }
  }
  return best?.dir;
}

// Puts each worker session on its node: the node the laptop launched it for, else the node whose
// "<worker>:<path>" repo contains its folder most specifically. Sessions that match nothing are left out.
export function attachWorkerSessions(tree: TreeNode, workers: WorkerState[]) {
  const nodes = flatten(tree);
  const byPath = new Map(nodes.map((n) => [n.path, n]));
  for (const w of workers) {
    for (const s of w.sessions) {
      let target = s.node !== undefined ? byPath.get(s.node) : undefined;
      let best = -1;
      for (const n of target ? [] : nodes) {
        for (const r of n.repos.map(splitRepo)) {
          if (r.host !== w.name && r.host !== w.host) continue;
          const repo = r.path.replace(/^~(?=$|\/)/, w.home ?? "~").replace(/\/+$/, "");
          if ((s.cwd === repo || s.cwd.startsWith(repo + "/")) && repo.length > best) (target = n), (best = repo.length);
        }
      }
      target?.sessions.push(s);
    }
  }
  return tree;
}

// Every CLAUDE.md body from the root down to a node: what a session inside the tree would load.
// With onWorker, the session runs on another machine, which has none of these files.
export function nodeContext(root: string, nodeDir: string, onWorker = false): string {
  const chain: string[] = [];
  for (let d = nodeDir; ; d = path.dirname(d)) {
    chain.unshift(d);
    if (d === root || d === path.dirname(d)) break;
  }
  const parts = chain.map((d) => {
    const node = parseNode(fs.readFileSync(path.join(d, "CLAUDE.md"), "utf8"), path.basename(d));
    return `# Node: ${path.relative(root, d) || "/"} (${node.title})\n${node.body.trim()}`;
  });
  const intro = onWorker
    ? `This session belongs to the orca node "${path.relative(root, nodeDir) || "/"}". The node's files live on the orca hub machine, not on this one: work in the current folder. These are the node's CLAUDE.md files, root first.`
    : `This session belongs to the orca node at ${nodeDir}. These are its CLAUDE.md files, root first.`;
  return [intro, ...parts].join("\n\n");
}

function load(dir: string) {
  const node = parseNode(fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), path.basename(dir));
  const childNames = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
    .filter((e) => fs.existsSync(path.join(dir, e.name, "CLAUDE.md")))
    .map((e) => e.name)
    .sort();
  if (childNames.length && node.body.trim().split("\n").length > ORG_MAX_LINES) {
    node.issues.push({
      level: "warning",
      message: `body is over ${ORG_MAX_LINES} lines; every session below this node loads it in full`,
    });
  }
  return { node, childNames };
}
