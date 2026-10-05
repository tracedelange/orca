// Starts Claude in a detached tmux session. Reads {dir, name, node, args} as JSON on stdin and
// prints the tmux session name. Arguments go to tmux as an array, so nothing passes through a shell.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { dir, name, node, args } = JSON.parse(fs.readFileSync(0, "utf8"));
const cwd = dir.replace(/^~(?=$|\/)/, os.homedir());
fs.mkdirSync(cwd, { recursive: true });

// The tmux server may not have a login PATH, so find claude ourselves.
const local = path.join(os.homedir(), ".local", "bin", "claude");
const claude = fs.existsSync(local) ? local : "claude";

let live = [];
try {
  live = execFileSync("tmux", ["list-sessions", "-F", "#{session_name}"], { encoding: "utf8", stdio: "pipe" }).split("\n");
} catch {}
let unique = name;
for (let i = 2; live.includes(unique); i++) unique = `${name}-${i}`;

execFileSync("tmux", ["new-session", "-d", "-s", unique, "-c", cwd, "-x", "200", "-y", "50", "-e", `ORCA_NODE=${node}`, claude, ...args]);
process.stdout.write(unique);
