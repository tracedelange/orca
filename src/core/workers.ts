import { execFile, execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseNode } from "./node.ts";
import { resolveInRoot } from "./paths.ts";
import { launch, splitRepo, type Session } from "./sessions.ts";
import { nodeContext } from "./tree.ts";

// A worker is another machine that runs Claude sessions. The laptop reaches it only through
// `ssh <host>` (Tailscale SSH), so the orca server never listens beyond 127.0.0.1.

export type Worker = { host: string; name: string };
export type WorkerState = Worker & { home?: string; sessions: Session[]; error?: string };

const REMOTE_SRC = fileURLToPath(new URL("../remote/", import.meta.url));
const BIN = "~/.orca/bin";
// One persistent connection per worker keeps each 5-second poll cheap.
export const SSH_OPTS = [
  "-o", "BatchMode=yes", "-o", "ConnectTimeout=5",
  "-o", "ControlMaster=auto", "-o", `ControlPath=${path.join(os.homedir(), ".ssh", "orca-%C")}`, "-o", "ControlPersist=10m",
];
// tmux names and hosts reach a remote shell, so only allow plain characters.
export const SAFE = /^[A-Za-z0-9_.-]+$/;

const workersFile = (root: string) => path.join(root, ".orca", "workers.json");

export function readWorkers(root: string): Worker[] {
  const file = workersFile(root);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
}

function writeWorkers(root: string, workers: Worker[]) {
  fs.mkdirSync(path.dirname(workersFile(root)), { recursive: true });
  fs.writeFileSync(workersFile(root), JSON.stringify(workers, null, 2) + "\n");
}

export function findWorker(root: string, hostOrName: string): Worker | undefined {
  return readWorkers(root).find((w) => w.host === hostOrName || w.name === hostOrName);
}

function ssh(host: string, command: string, input?: string | Buffer): string {
  if (!SAFE.test(host)) throw new Error(`bad host ${host}`);
  return execFileSync("ssh", [...SSH_OPTS, host, command], { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });
}

// Copies the worker scripts to ~/.orca/bin, installs the hook, and records the worker.
export function addWorker(root: string, host: string): Worker {
  const tar = spawnSync("tar", ["-C", REMOTE_SRC, "-cf", "-", "."]);
  ssh(host, `mkdir -p ${BIN} && tar -C ${BIN} -xf -`, tar.stdout);
  const name = ssh(host, `node ${BIN}/install.mjs`).trim();
  const worker = { host, name };
  writeWorkers(root, [...readWorkers(root).filter((w) => w.host !== host), worker]);
  return worker;
}

export function removeWorker(root: string, host: string) {
  const w = findWorker(root, host);
  if (!w) throw new Error(`no worker ${host}`);
  ssh(w.host, `node ${BIN}/install.mjs --remove`);
  writeWorkers(root, readWorkers(root).filter((x) => x.host !== w.host));
}

// Live sessions on every worker. An unreachable worker reports an error and no sessions.
export async function pollWorkers(root: string): Promise<WorkerState[]> {
  return Promise.all(readWorkers(root).map(async (w) => {
    try {
      const { stdout } = await promisify(execFile)("ssh", [...SSH_OPTS, w.host, `node ${BIN}/list.mjs`], { timeout: 10_000 });
      const out = JSON.parse(stdout);
      return { ...w, home: out.home, sessions: out.sessions.map((s: Session) => ({ ...s, host: w.name })) };
    } catch (err) {
      return { ...w, sessions: [], error: String((err as Error).message).split("\n")[0] };
    }
  }));
}

export type StartOptions = { prompt?: string; resume?: boolean; host?: string };

// Starts Claude for a node, here or on a worker. Returns the tmux name and, for a worker, its name.
export function startSession(root: string, rel: string, opts: StartOptions = {}): { tmux: string; host?: string } {
  if (!opts.host) return { tmux: launch(root, rel, opts) };
  const w = findWorker(root, opts.host);
  if (!w) throw new Error(`no worker ${opts.host}`);
  const dir = resolveInRoot(root, rel);
  const node = parseNode(fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), path.basename(dir));

  // The worker has no node folders: run in the node's repo there, else a working folder named after the node.
  const repo = node.repos.map(splitRepo).find((r) => r.host === w.name || r.host === w.host);
  const relPath = path.relative(root, dir);
  // The worker has no CLAUDE.md chain either, so pass it as system prompt.
  const args = ["-n", node.title, "--append-system-prompt", nodeContext(root, dir, true)];
  if (opts.resume) args.push("--continue");
  if (opts.prompt) args.push("--", opts.prompt);
  const spec = {
    dir: repo?.path ?? `~/orca/${relPath || "root"}`,
    name: "orca-" + (relPath || "root").replace(/[^A-Za-z0-9_-]/g, "-"),
    node: relPath.split(path.sep).join("/"),
    args,
  };
  return { tmux: ssh(w.host, `node ${BIN}/launch.mjs`, JSON.stringify(spec)).trim(), host: w.name };
}

export function remoteEnd(w: Worker, s: Session) {
  if (s.tmux) {
    if (!SAFE.test(s.tmux)) throw new Error(`bad tmux name ${s.tmux}`);
    ssh(w.host, `tmux kill-session -t '=${s.tmux}'`);
  } else {
    ssh(w.host, `kill ${Number(s.pid)}`);
  }
}

// `ssh -t host tmux attach` for the terminal bridge.
// The target is quoted because a leading "=" means something else to zsh, a common login shell.
export const attachArgs = (w: Worker, tmux: string) => [...SSH_OPTS, "-t", w.host, `tmux attach-session -t '=${tmux}'`];
