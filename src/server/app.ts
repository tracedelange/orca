import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
import pty from "node-pty";
import { WebSocketServer } from "ws";
import { chooseDispatch, dismissDispatch, listJobs, queueDispatch, retryDispatch } from "../core/dispatch.ts";
import { adoptSession, createNode, docsDir, EditError, endSession, moveNode, removeNode, uncommitted, updateNode } from "../core/edit.ts";
import { PathError } from "../core/paths.ts";
import { copyToObsidian, listVaults, readObsidian, setObsidian } from "../core/obsidian.ts";
import { addToQueue, runQueues } from "../core/queue.ts";
import { closeShell, launchShell, listShells, liveTmuxSessions } from "../core/sessions.ts";
import { markSeen, readParked, readSeen, setParked } from "../core/seen.ts";
import { readTailnet, switchTailnet } from "../core/tailscale.ts";
import { addTodo, allTodos, doneTodo, editTodo, nodeTodo, queueTodo, readTodos, undoTodo } from "../core/todo.ts";
import { readUsage } from "../core/usage.ts";
import { attachWorkerSessions, docPath, flatten, readDoc, readNodeDetail, readTree } from "../core/tree.ts";
import { attachArgs, findWorker, pollWorkers, remoteEnd, SAFE, startSession, type WorkerState } from "../core/workers.ts";

const file = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const JS = "text/javascript; charset=utf-8";
const CLI = file("../../bin/orca.js");
// Resolve through node, so the files are found whether npm nests or hoists the dependencies.
const dep = (pkg: string, p: string) => fileURLToPath(new URL(p, import.meta.resolve(pkg)));

// A fixed list of public files, so no request path ever reaches the filesystem directly.
const STATIC: Record<string, [string, string]> = {
  "/": [file("../../web/index.html"), "text/html; charset=utf-8"],
  "/app.js": [file("../../web/app.js"), JS],
  "/style.css": [file("../../web/style.css"), "text/css; charset=utf-8"],
  "/orca.svg": [file("../../web/orca.svg"), "image/svg+xml"],
  "/vendor/d3.js": [dep("d3", "../dist/d3.min.js"), JS],
  "/vendor/xterm.js": [dep("@xterm/xterm", "xterm.js"), JS],
  "/vendor/xterm.css": [dep("@xterm/xterm", "../css/xterm.css"), "text/css; charset=utf-8"],
  "/vendor/addon-fit.js": [dep("@xterm/addon-fit", "addon-fit.js"), JS],
  "/vendor/addon-web-links.js": [dep("@xterm/addon-web-links", "addon-web-links.js"), JS],
};

// Worker sessions, refreshed in the background so a slow or offline worker never delays a request.
let workers: WorkerState[] = [];
const workerSession = (id: string) => {
  for (const w of workers) for (const s of w.sessions) if (s.sessionId === id || s.tmux === id) return { w, s };
};

// Write endpoints. Each takes a JSON body and returns JSON.
const EDITS: Record<string, (root: string, b: any) => unknown> = {
  create: (root, b) => ({ created: createNode(root, b.path, b) }),
  move: (root, b) => ({ path: moveNode(root, b.from, b.to) }),
  remove: (root, b) => ({ trashed: removeNode(root, b.path) }),
  update: (root, b) => (updateNode(root, b.path, b), {}),
  // With archive, also archives the node: the End + archive button on a session that said "Done:".
  end: (root, b) => {
    const remote = workerSession(String(b.session ?? ""));
    let p: string | undefined;
    if (remote) {
      remoteEnd(remote.w, remote.s);
      remote.w.sessions = remote.w.sessions.filter((s) => s !== remote.s);
      p = remote.s.node;
    } else p = endSession(root, String(b.session ?? ""));
    if (b.archive && p) updateNode(root, p, { archived: true });
    return { path: p };
  },
  adopt: (root, b) => adoptSession(root, String(b.session ?? "")),
  dispatch: (root, b) => queueDispatch(root, b.path, String(b.prompt ?? ""), b.host || undefined),
  retry: (root, b) => (retryDispatch(root, String(b.id ?? "")), {}),
  choose: (root, b) => chooseDispatch(root, String(b.id ?? ""), Number(b.index)),
  dismiss: (root, b) => (dismissDispatch(String(b.id ?? "")), {}),
  queue: (root, b) => (addToQueue(root, b.path, String(b.task ?? "")), {}),
  todo: (root, b) => (addTodo(root, b.path, String(b.idea ?? "")), {}),
  tododone: (root, b) => (doneTodo(root, b.path, Number(b.n)), {}),
  todoundo: (root, b) => (undoTodo(root, b.path, Number(b.n)), {}),
  todoedit: (root, b) => (editTodo(root, b.path, Number(b.n), String(b.idea ?? "")), {}),
  todoqueue: (root, b) => (queueTodo(root, b.path, Number(b.n)), {}),
  todonode: (root, b) => ({ path: nodeTodo(root, b.path, Number(b.n)) }),
  // Opens a document in the Mac's default app for its type.
  open: (root, b) => (execFileSync("open", [docPath(root, String(b.path ?? ""))]), {}),
  // Selects the document in a Finder window.
  reveal: (root, b) => (execFileSync("open", ["-R", docPath(root, String(b.path ?? ""))]), {}),
  // Opens the node's docs folder in Finder.
  finder: (root, b) => (execFileSync("open", [docsDir(root, String(b.path ?? ""))]), {}),
  copy: (root, b) => ({ copied: copyToObsidian(root, docPath(root, String(b.path ?? ""))) }),
  obsidian: (root, b) => ({ obsidian: setObsidian(root, String(b.vault ?? ""), String(b.folder ?? "")) ?? null }),
  seen: (root, b) => (markSeen(root, b.seen ?? {}, liveSessionIds(root)), {}),
  shell: (root, b) => ({ tmux: launchShell(root, String(b.path ?? "")) }),
  closeshell: (root, b) => (closeShell(String(b.tmux ?? "")), {}),
  park: (root, b) => (setParked(root, String(b.session ?? ""), !!b.park, liveSessionIds(root)), {}),
};
const liveSessionIds = (root: string) =>
  new Set(flatten(attachWorkerSessions(readTree(root), workers)).flatMap((n) => n.sessions.map((s) => s.sessionId)));

export function createServer(root: string) {
  const poll = async () => {
    workers = await pollWorkers(root);
    setTimeout(poll, 5000).unref();
  };
  poll();
  // The queue manager: one pass every 5 seconds, never two at once.
  const manage = async () => {
    await runQueues(root).catch((err) => console.error(`queue: ${err.message}`));
    setTimeout(manage, 5000).unref();
  };
  manage();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/api/tree") return json(res, 200, attachWorkerSessions(readTree(root), workers));
      if (url.pathname === "/api/seen") return json(res, 200, readSeen(root));
      if (url.pathname === "/api/shells") return json(res, 200, listShells());
      if (url.pathname === "/api/parked") return json(res, 200, readParked(root));
      if (url.pathname === "/api/obsidian") return json(res, 200, { vaults: listVaults(), obsidian: readObsidian(root) ?? null });
      if (url.pathname === "/api/dispatches") return json(res, 200, listJobs());
      if (url.pathname === "/api/workers") return json(res, 200, workers.map(({ host, name, error }) => ({ host, name, error })));
      if (url.pathname === "/api/tailnet/switch") {
        if (req.method !== "POST" || !sameOrigin(req)) return json(res, 403, { error: "forbidden" });
        await switchTailnet(url.searchParams.get("id") ?? "");
        return json(res, 200, { ok: true });
      }
      // `orca restart` kills this process, so it runs detached, after the reply goes out.
      if (url.pathname === "/api/restart") {
        if (req.method !== "POST" || !sameOrigin(req)) return json(res, 403, { error: "forbidden" });
        res.on("finish", () => spawn(process.execPath, [CLI, "restart"], { detached: true, stdio: "ignore" }).unref());
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/api/tailnet") return json(res, 200, await readTailnet().catch(() => ({ state: "unavailable" })));
      if (url.pathname === "/api/usage") return json(res, 200, await readUsage().catch(() => ({ error: "unavailable" })));
      if (url.pathname === "/api/uncommitted") {
        const id = url.searchParams.get("session") ?? "";
        return json(res, 200, { count: workerSession(id) ? 0 : uncommitted(root, id) });
      }
      if (url.pathname === "/api/node") return json(res, 200, readNodeDetail(root, url.searchParams.get("path") ?? ""));
      // One node's parked ideas, or with no path, every node's.
      if (url.pathname === "/api/todos") {
        const p = url.searchParams.get("path");
        return json(res, 200, p === null ? allTodos(root) : [{ path: p, items: readTodos(root, p) }]);
      }
      if (url.pathname === "/api/file")return json(res, 200, readDoc(root, url.searchParams.get("path") ?? "", url.searchParams.get("cwd") || undefined));
      if (url.pathname === "/api/launch") {
        if (req.method !== "POST" || !sameOrigin(req)) return json(res, 403, { error: "forbidden" });
        const resume = url.searchParams.get("resume") === "1";
        const host = url.searchParams.get("host") || undefined;
        return json(res, 200, startSession(root, url.searchParams.get("path") ?? "", { resume, host }));
      }
      const op = url.pathname.match(/^\/api\/nodes\/(\w+)$/)?.[1];
      if (op) {
        if (!Object.hasOwn(EDITS, op)) return json(res, 404, { error: "not found" });
        if (req.method !== "POST" || !sameOrigin(req)) return json(res, 403, { error: "forbidden" });
        return json(res, 200, await EDITS[op](root, JSON.parse(await readBody(req))));
      }
      const asset = STATIC[url.pathname];
      if (!asset) return json(res, 404, { error: "not found" });
      res.writeHead(200, { "content-type": asset[1] });
      res.end(fs.readFileSync(asset[0]));
    } catch (err) {
      if (err instanceof PathError || err instanceof SyntaxError) return json(res, 400, { error: err.message });
      if (err instanceof EditError) return json(res, 409, { error: err.message });
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return json(res, 404, { error: url.pathname === "/api/file" ? "no such file" : "no such node" });
      json(res, 500, { error: String(err) });
    }
  });

  // Terminal: a WebSocket bridged to `tmux attach` through a pty.
  // Client sends JSON: {"i": "<keystrokes>"} or {"r": [cols, rows]}. Server sends raw terminal output.
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const name = url.searchParams.get("session") ?? "";
    const host = url.searchParams.get("host");
    // Watching a child: read-only, and its window keeps the size its parent reads with `orca wait`.
    const watch = url.searchParams.get("watch") === "1";
    const flags = watch ? ["-f", "read-only,ignore-size"] : [];
    // A worker session needs only a safe name: a new one sits at Claude's folder-trust prompt,
    // before any hook reports it. A local one must be a live tmux session here.
    const worker = host ? findWorker(root, host) : undefined;
    const known = host ? !!worker && SAFE.test(name) : liveTmuxSessions().has(name);
    if (url.pathname !== "/api/term" || !sameOrigin(req) || !known) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      // "=" makes tmux match the name exactly rather than by prefix.
      const [cmd, args] = worker ? ["ssh", attachArgs(worker, name, flags)] : ["tmux", ["attach-session", ...flags, "-t", `=${name}`]];
      const term = pty.spawn(cmd as string, args as string[], {
        name: "xterm-256color",
        cols: 100,
        rows: 30,
        env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
      });
      term.onData((d) => ws.send(d));
      term.onExit(() => ws.close());
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw));
        if (typeof msg.i === "string" && !watch) term.write(msg.i);
        if (Array.isArray(msg.r)) term.resize(msg.r[0], msg.r[1]);
      });
      ws.on("close", () => term.kill());
    });
  });

  return server;
}

// The terminal and launch endpoints run commands, so only pages served by this server may call them.
// Behind `tailscale serve` the original host may arrive as X-Forwarded-Host.
function sameOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  const host = new URL(origin).host;
  return host === req.headers.host || host === req.headers["x-forwarded-host"];
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64_000) throw new EditError("request too large");
  }
  return body;
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
