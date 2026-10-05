// Claude Code hook, installed for every session by `nodes install-hooks`. Records session state in
// <node>/.node/sessions/<session_id>.json when the session's folder belongs to a node. Never writes CLAUDE.md.
import fs from "node:fs";
import path from "node:path";
import { rootDir } from "../core/paths.ts";
import { sessionsDir, type Session } from "../core/sessions.ts";
import { claimedNodeDir, hasClaims } from "../core/claims.ts";
import { findClaudePid, nextSession } from "../remote/state.mjs";
import { findNodeDir, nodeContext } from "../core/tree.ts";

const event = process.argv[2];

// This hook runs in every Claude session on the machine, so it must never fail one.
try {
  run(JSON.parse(fs.readFileSync(0, "utf8")));
} catch {}

function run(input: { session_id?: string; cwd?: string; notification_type?: string; last_assistant_message?: string }) {
  const root = rootDir();
  if (!input.session_id || !input.cwd || !fs.existsSync(root)) return;
  const realRoot = fs.realpathSync(root);
  const cwd = fs.realpathSync(input.cwd);
  // Which node: the one orca launched this session for (ORCA_NODE), then a claim (from `nodes claim`),
  // then the folder. Only look up our pid when claims exist.
  const launched = process.env.ORCA_NODE !== undefined ? path.join(realRoot, process.env.ORCA_NODE) : undefined;
  const pid = hasClaims(realRoot) ? findClaudePid() : undefined;
  const nodeDir =
    (launched && fs.existsSync(path.join(launched, "CLAUDE.md")) ? launched : undefined) ||
    (pid && claimedNodeDir(realRoot, pid)) ||
    findNodeDir(realRoot, cwd);
  if (!nodeDir) return;
  // A session outside the tree does not load the tree's CLAUDE.md files, so hand it the same chain.
  if (event === "SessionStart" && !(cwd + path.sep).startsWith(realRoot + path.sep)) {
    const context = nodeContext(realRoot, nodeDir);
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }));
  }

  const dir = sessionsDir(nodeDir);
  const file = path.join(dir, `${input.session_id}.json`);
  if (event === "SessionEnd") return fs.rmSync(file, { force: true });

  const prev: Partial<Session> = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const session: Session = nextSession(prev, event, input, { pid });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(session, null, 2));
}
