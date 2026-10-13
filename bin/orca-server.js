#!/usr/bin/env node
// Plain JS entry, so launchd can run it with node.
import { existsSync } from "node:fs";
// A checkout runs the TypeScript source. The published package ships only dist.
await import(existsSync(new URL("../src", import.meta.url)) ? "../src/server/main.ts" : "../dist/server/main.js");
