// Worker hook: records every Claude session's state in ~/.orca/sessions/<session_id>.json.
// The laptop reads these over SSH and decides which node each session belongs to.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nextSession } from "./state.mjs";

const DIR = path.join(os.homedir(), ".orca", "sessions");
const event = process.argv[2];

// This hook runs in every Claude session on the machine, so it must never fail one.
try {
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  if (input.session_id) {
    const file = path.join(DIR, `${input.session_id}.json`);
    if (event === "SessionEnd") fs.rmSync(file, { force: true });
    else {
      const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
      // ORCA_NODE is set when the laptop launched this session for a node.
      const node = prev.node ?? process.env.ORCA_NODE;
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(nextSession(prev, event, input, { fields: node === undefined ? {} : { node } })));
    }
  }
} catch {}
