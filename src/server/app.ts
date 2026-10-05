import fs from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
import pty from "node-pty";
import { WebSocketServer } from "ws";
import { dispatch } from "../core/dispatch.ts";
import { adoptSession, createNode, EditError, endSession, moveNode, removeNode, updateNode } from "../core/edit.ts";
import { PathError } from "../core/paths.ts";
import { liveTmuxSessions } from "../core/sessions.ts";
import { readUsage } from "../core/usage.ts";
import { attachWorkerSessions, readNodeDetail, readTree } from "../core/tree.ts";
import { attachArgs, findWorker, pollWorkers, remoteEnd, startSession, type WorkerState } from "../core/workers.ts";

const file = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const JS = "text/javascript; charset=utf-8";

// A fixed list of public files, so no request path ever reaches the filesystem directly.
const STATIC: Record<string, [string, string]> = {
  "/": [file("../../web/index.html"), "text/html; charset=utf-8"],
  "/app.js": [file("../../web/app.js"), JS],
  "/style.css": [file("../../web/style.css"), "text/css; charset=utf-8"],
  "/vendor/d3.js": [file("../../node_modules/d3/dist/d3.min.js"), JS],
  "/vendor/xterm.js": [file("../../node_modules/@xterm/xterm/lib/xterm.js"), JS],
  "/vendor/xterm.css": [file("../../node_modules/@xterm/xterm/css/xterm.css"), "text/css; charset=utf-8"],
  "/vendor/addon-fit.js": [file("../../node_modules/@xterm/addon-fit/lib/addon-fit.js"), JS],
};

// Write endpoints. Each takes a JSON body and returns JSON.
// Worker sessions, refreshed in the background so a slow or offline worker never delays a request.
let workers: WorkerState[] = [];
const workerSession = (id: string) => {
  for (const w of workers) for (const s of w.sessions) if (s.sessionId === id || s.tmux === id) return { w, s };
};

const EDITS: Record<string, (root: string, b: any) => unknown> = {
  create: (root, b) => ({ created: createNode(root, b.path, b) }),
  move: (root, b) => ({ path: moveNode(root, b.from, b.to) }),
  remove: (root, b) => ({ trashed: removeNode(root, b.path) }),
  update: (root, b) => (updateNode(root, b.path, b), {}),
  end: (root, b) => {
    const remote = workerSession(String(b.session ?? ""));
    if (!remote) return { path: endSession(root, String(b.session ?? "")) };
    remoteEnd(remote.w, remote.s);
    remote.w.sessions = remote.w.sessions.filter((s) => s !== remote.s);
    return { path: remote.s.node };
  },
  adopt: (root, b) => adoptSession(root, String(b.session ?? "")),
  dispatch: (root, b) => dispatch(root, b.path, String(b.prompt ?? ""), b.host || undefined),
};

export function createServer(root: string) {
  const poll = async () => {
    workers = await pollWorkers(root);
    setTimeout(poll, 5000).unref();
  };
  poll();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/api/tree") return json(res, 200, attachWorkerSessions(readTree(root), workers));
      if (url.pathname === "/api/workers") return json(res, 200, workers.map(({ host, name, error }) => ({ host, name, error })));
      if (url.pathname === "/api/usage") return json(res, 200, await readUsage().catch(() => ({ error: "unavailable" })));
      if (url.pathname === "/api/node") return json(res, 200, readNodeDetail(root, url.searchParams.get("path") ?? ""));
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
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return json(res, 404, { error: "no such node" });
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
    // A worker session must be one we polled; a local one must be a live tmux session here.
    const worker = host ? findWorker(root, host) : undefined;
    const known = host
      ? !!worker && workers.some((w) => w.host === worker.host && w.sessions.some((s) => s.tmux === name))
      : liveTmuxSessions().has(name);
    if (url.pathname !== "/api/term" || !sameOrigin(req) || !known) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      // "=" makes tmux match the name exactly rather than by prefix.
      const [cmd, args] = worker ? ["ssh", attachArgs(worker, name)] : ["tmux", ["attach-session", "-t", `=${name}`]];
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
        if (typeof msg.i === "string") term.write(msg.i);
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
