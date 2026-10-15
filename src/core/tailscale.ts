import { execFile } from "node:child_process";
import { promisify } from "node:util";

// The tailnet this Mac is on and the account it is logged in as, from the Tailscale CLI.
export async function readTailnet() {
  const { stdout } = await promisify(execFile)("tailscale", ["status", "--json"]);
  const s = JSON.parse(stdout);
  if (s.BackendState !== "Running") return { state: s.BackendState };
  return { state: s.BackendState, tailnet: s.CurrentTailnet?.Name, login: s.User?.[s.Self?.UserID]?.LoginName };
}
