import { execFile } from "node:child_process";
import { promisify } from "node:util";

const tailscale = async (...args: string[]) => (await promisify(execFile)("tailscale", args)).stdout;

// The tailnet this Mac is on, the account it is logged in as, and the other accounts Tailscale can switch to.
export async function readTailnet() {
  const [status, list] = await Promise.all([tailscale("status", "--json"), tailscale("switch", "--list", "--json").catch(() => "[]")]);
  const s = JSON.parse(status);
  const profiles = JSON.parse(list).map((p: { id: string; tailnet: string; account: string; selected: boolean }) =>
    ({ id: p.id, tailnet: p.tailnet, account: p.account, selected: p.selected }));
  if (s.BackendState !== "Running") return { state: s.BackendState, profiles };
  return { state: s.BackendState, tailnet: s.CurrentTailnet?.Name, login: s.User?.[s.Self?.UserID]?.LoginName, profiles };
}

export async function switchTailnet(id: string) {
  await tailscale("switch", id);
}
