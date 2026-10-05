import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createServer } from "../src/server/app.ts";

const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orca-")), "nodes");
execFileSync(path.resolve(import.meta.dirname, "../bin/nodes.js"), ["init"], { env: { ...process.env, NODES_ROOT: root } });
const server = createServer(root);
let base = "";

before(() => new Promise<void>((done) => server.listen(0, "127.0.0.1", () => {
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  done();
})));
after(() => server.close());

test("GET /api/tree returns the tree without bodies", async () => {
  const tree = await (await fetch(`${base}/api/tree`)).json();
  assert.equal(tree.title, "Nodes");
  assert.equal(tree.descendantCount, 8);
  assert.equal(tree.body, undefined);
});

test("GET /api/node returns body and html", async () => {
  const node = await (await fetch(`${base}/api/node?path=work/vmt-analyzer`)).json();
  assert.equal(node.title, "VMT Analyzer");
  assert.match(node.html, /<h2>Context<\/h2>/);
});

test("GET /api/node rejects paths that escape the root", async () => {
  for (const p of ["../../etc/passwd", "%2e%2e/%2e%2e/etc/passwd", "/etc/passwd", "work/../../../etc"]) {
    const res = await fetch(`${base}/api/node?path=${p}`);
    assert.equal(res.status, 400, p);
  }
});

test("unknown nodes and files are 404", async () => {
  assert.equal((await fetch(`${base}/api/node?path=nope`)).status, 404);
  assert.equal((await fetch(`${base}/../package.json`)).status, 404);
});

test("POST /api/launch refuses other origins and GET", async () => {
  const evil = await fetch(`${base}/api/launch?path=work`, { method: "POST", headers: { origin: "https://evil.example" } });
  assert.equal(evil.status, 403);
  const noOrigin = await fetch(`${base}/api/launch?path=work`, { method: "POST" });
  assert.equal(noOrigin.status, 403);
  const get = await fetch(`${base}/api/launch?path=work`, { headers: { origin: base } });
  assert.equal(get.status, 403);
});

test("POST /api/launch rejects paths that escape the root", async () => {
  const res = await fetch(`${base}/api/launch?path=../../tmp`, { method: "POST", headers: { origin: base } });
  assert.equal(res.status, 400);
});

test("terminal upgrade refuses other origins and unknown sessions", async () => {
  const status = (headers: Record<string, string>, session: string) =>
    new Promise<string>((done) => {
      const req = http.request(`${base}/api/term?session=${session}`, {
        headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", ...headers },
      });
      req.on("upgrade", () => done("upgraded"));
      req.on("response", (res) => done(String(res.statusCode)));
      req.on("error", () => done("closed"));
      req.end();
    });
  assert.notEqual(await status({ origin: "https://evil.example" }, "anything"), "upgraded");
  assert.notEqual(await status({ origin: base }, "orca-no-such-session"), "upgraded");
});

test("edit endpoints refuse other origins and GET, and report conflicts", async () => {
  const post = (op: string, body: unknown, origin?: string) =>
    fetch(`${base}/api/nodes/${op}`, { method: "POST", body: JSON.stringify(body), headers: origin ? { origin } : {} });
  assert.equal((await post("remove", { path: "home" }, "https://evil.example")).status, 403);
  assert.equal((await post("remove", { path: "home" })).status, 403);
  assert.equal((await fetch(`${base}/api/nodes/remove`, { headers: { origin: base } })).status, 403);
  assert.equal((await post("toString", {}, base)).status, 404);
  assert.equal((await post("create", { path: "../../x" }, base)).status, 400);
  assert.equal((await post("create", { path: "work" }, base)).status, 409);
  assert.equal((await post("update", { path: "work", title: "Work!" }, base)).status, 200);
});
