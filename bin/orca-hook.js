#!/usr/bin/env node
import { existsSync } from "node:fs";
// A checkout runs the TypeScript source. The published package ships only dist.
await import(existsSync(new URL("../src", import.meta.url)) ? "../src/hook/main.ts" : "../dist/hook/main.js");
