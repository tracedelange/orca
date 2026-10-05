import { rootDir } from "../core/paths.ts";
import { createServer } from "./app.ts";

const root = rootDir();
const port = Number(process.env.PORT ?? 4317);

// Loopback only; `tailscale serve` exposes it to the tailnet.
createServer(root).listen(port, "127.0.0.1", () => {
  console.log(`orca on http://127.0.0.1:${port}, root ${root}`);
});
