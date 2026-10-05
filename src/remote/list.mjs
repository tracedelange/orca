// Prints {home, sessions} for the laptop: every live session on this worker. Drops dead ones.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isAlive } from "./state.mjs";

const DIR = path.join(os.homedir(), ".orca", "sessions");
const sessions = [];
for (const name of fs.existsSync(DIR) ? fs.readdirSync(DIR) : []) {
  const file = path.join(DIR, name);
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    if (s.pid && isAlive(s.pid)) sessions.push(s);
    else fs.rmSync(file, { force: true });
  } catch {}
}
process.stdout.write(JSON.stringify({ home: os.homedir(), sessions }));
