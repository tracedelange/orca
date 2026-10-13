// Adds (or with --remove, deletes) the worker hook in ~/.claude/settings.json and prints the hostname.
import os from "node:os";
import path from "node:path";
import { writeHooks } from "./state.mjs";

const file = path.join(os.homedir(), ".claude", "settings.json");
const hook = path.join(os.homedir(), ".orca", "bin", "hook.mjs");
writeHooks(file, (event) => `"${process.execPath}" "${hook}" ${event}`, process.argv.includes("--remove"));
process.stdout.write(os.hostname());
