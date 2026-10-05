// Adds (or with --remove, deletes) the worker hook in ~/.claude/settings.json and prints the hostname.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mergeHooks } from "./state.mjs";

const file = path.join(os.homedir(), ".claude", "settings.json");
const hook = path.join(os.homedir(), ".orca", "bin", "hook.mjs");
const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
mergeHooks(settings, (event) => `"${process.execPath}" "${hook}" ${event}`, process.argv.includes("--remove"));
if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.orca-backup`);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
process.stdout.write(os.hostname());
