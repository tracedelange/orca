import { parse } from "yaml";

export type Issue = { level: "error" | "warning"; message: string };

export type NodeFields = {
  title: string;
  goal?: string;
  repos: string[]; // `repo` may be one path or a list
  branch?: string;
  background?: boolean; // a queue worker: shown on the map, kept off the rail
  extra: Record<string, unknown>;
  issues: Issue[];
};

// "status" is no longer used (state comes from sessions); old lines are ignored rather than shown.
const KNOWN = new Set(["title", "goal", "status", "repo", "branch", "background"]);

export function parseNode(text: string, fallbackTitle: string): NodeFields & { body: string } {
  const issues: Issue[] = [];
  let data: Record<string, unknown> = {};
  let body = text;

  const lines = text.split(/\r?\n/);
  const end = lines[0]?.trim() === "---" ? lines.findIndex((l, i) => i > 0 && l.trim() === "---") : -1;
  if (end === -1) {
    issues.push({ level: "error", message: "missing frontmatter" });
  } else {
    body = lines.slice(end + 1).join("\n");
    try {
      const parsed: unknown = parse(lines.slice(1, end).join("\n"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
      else if (parsed != null) issues.push({ level: "error", message: "frontmatter is not a key/value map" });
    } catch (err) {
      issues.push({ level: "error", message: `frontmatter: ${(err as Error).message.split("\n")[0]}` });
    }
  }

  const title = scalar(data.title);
  // A broken frontmatter block already explains the missing title.
  if (!title && issues.length === 0) issues.push({ level: "error", message: "missing title" });
  // The goal lives in the body because Claude Code strips frontmatter before agents see it.
  const goal = goalSection(body);
  if (scalar(data.goal)) {
    issues.push({ level: "warning", message: "goal is in frontmatter, which agents never see; move it to a ## Goal section" });
  }

  return {
    title: title ?? fallbackTitle,
    goal: goal ?? scalar(data.goal),
    repos: (Array.isArray(data.repo) ? data.repo : [data.repo]).map(scalar).filter((r): r is string => !!r),
    branch: scalar(data.branch),
    background: data.background === true || undefined,
    extra: Object.fromEntries(Object.entries(data).filter(([k]) => !KNOWN.has(k))),
    issues,
    body,
  };
}

// Text under "## Goal", up to the next heading, as one line.
function goalSection(body: string): string | undefined {
  const m = body.match(/^##\s+Goal\s*$([\s\S]*?)(?=^#{1,6}\s|(?![\s\S]))/im);
  return m?.[1].trim().replace(/\s+/g, " ") || undefined;
}

function scalar(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}
