import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

// launchd runs the server, like tailscaled: it starts at login and restarts after a crash.
const LABEL = "com.orca.server";
const PLIST = `${os.homedir()}/Library/LaunchAgents/${LABEL}.plist`;
const LOG = `${os.homedir()}/Library/Logs/orca.log`;
const SERVER = fileURLToPath(new URL("../../bin/orca-server.js", import.meta.url));
const TARGET = `gui/${process.getuid!()}/${LABEL}`;
const port = Number(process.env.PORT ?? 4317);
const url = `http://127.0.0.1:${port}`;

const launchctl = (...args: string[]) => execFileSync("launchctl", args, { encoding: "utf8", stdio: "pipe" });
const loaded = () => {
  try {
    return launchctl("print", TARGET);
  } catch {
    return null;
  }
};

const plist = () => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${process.execPath}</string><string>${SERVER}</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <!-- launchd's default PATH has no tmux, claude or git. -->
    <key>PATH</key><string>${process.env.PATH}</string>
    <!-- Without a UTF-8 locale, tmux attach draws non-ASCII characters as "_". -->
    <key>LANG</key><string>${process.env.LANG || "en_US.UTF-8"}</string>
    <key>PORT</key><string>${port}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict>
</plist>
`;

function start() {
  // Rewrite the plist each time, so it follows the current node binary, PATH and PORT.
  fs.writeFileSync(PLIST, plist());
  if (loaded()) launchctl("bootout", TARGET);
  // bootout returns before launchd has unloaded the job, and bootstrap fails until it has.
  while (loaded()) execFileSync("sleep", ["0.1"]);
  launchctl("bootstrap", `gui/${process.getuid!()}`, PLIST);
  console.log(`orca started on ${url}`);
}

// Stops the server and removes the plist, so it does not come back at login.
function stop() {
  if (loaded()) launchctl("bootout", TARGET);
  fs.rmSync(PLIST, { force: true });
  console.log("orca stopped");
}

function restart() {
  if (!loaded()) return start();
  launchctl("kickstart", "-k", TARGET);
  console.log("orca restarted");
}

async function status() {
  const info = loaded();
  if (!info) return console.log("orca: stopped");
  const pid = info.match(/\bpid = (\d+)/)?.[1];
  const up = await fetch(url).then((r) => r.ok, () => false);
  console.log(`orca: ${pid ? `running (pid ${pid})` : "loaded, not running"}`);
  console.log(`${url} ${up ? "responding" : "not responding"}`);
  console.log(`logs: ${LOG}`);
}

const open = () => void execFileSync("open", [url]);
const logs = () => void spawn("tail", ["-n", "50", "-f", LOG], { stdio: "inherit" });

export const daemon = { start, stop, restart, status, open, logs };
