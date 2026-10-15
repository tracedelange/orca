import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createServer } from "../src/server/app.ts";

const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orca-")), "nodes");
fs.cpSync(path.resolve(import.meta.dirname, "seed"), root, { recursive: true });
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

test("GET /api/file renders markdown in the tree and node repos, and nothing else", async () => {
  const docs = path.join(root, "work", "vmt-analyzer", "docs");
  fs.mkdirSync(docs, { recursive: true });
  fs.writeFileSync(path.join(docs, "plan.md"), "# Plan\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))\n");
  fs.writeFileSync(path.join(docs, "notes.txt"), "not markdown");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "orca-out-"));
  fs.writeFileSync(path.join(outside, "secret.md"), "# Secret");
  fs.symlinkSync(path.join(outside, "secret.md"), path.join(docs, "link.md"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "orca-repo-"));
  fs.writeFileSync(path.join(repo, "README.md"), "# Repo");
  fs.mkdirSync(path.join(root, "work", "repo-node"));
  fs.writeFileSync(path.join(root, "work", "repo-node", "CLAUDE.md"), `---\ntitle: Repo\nrepo: ${repo}\n---\n`);
  const get = (p: string, cwd?: string) =>
    fetch(`${base}/api/file?path=${encodeURIComponent(p)}${cwd ? `&cwd=${encodeURIComponent(cwd)}` : ""}`);

  const doc = await (await get(path.join(docs, "plan.md"))).json();
  assert.match(doc.html, /<h1>Plan<\/h1>/);
  assert.match(doc.html, /&#60;img/);
  assert.match(doc.html, /<a href="#">x<\/a>/);
  assert.equal((await get("docs/plan.md", path.dirname(docs))).status, 200);
  assert.match((await (await get("README.md", repo)).json()).html, /Repo/);
  assert.equal((await get(path.join(outside, "secret.md"))).status, 400);
  assert.equal((await get(path.join(docs, "link.md"))).status, 400);
  assert.equal((await get(path.join(docs, "notes.txt"))).status, 400);
  assert.equal((await get(path.join(docs, "missing.md"))).status, 404);
  // Only check refusals: a successful open would launch an app.
  const open = (p: string) => fetch(`${base}/api/nodes/open`, { method: "POST", body: JSON.stringify({ path: p }), headers: { origin: base } });
  assert.equal((await open(path.join(outside, "secret.md"))).status, 400);
  assert.equal((await open(path.join(docs, "notes.txt"))).status, 400);
  const reveal = (p: string) => fetch(`${base}/api/nodes/reveal`, { method: "POST", body: JSON.stringify({ path: p }), headers: { origin: base } });
  assert.equal((await reveal(path.join(outside, "secret.md"))).status, 400);
  const finder = (p: string) => fetch(`${base}/api/nodes/finder`, { method: "POST", body: JSON.stringify({ path: p }), headers: { origin: base } });
  assert.equal((await finder("../outside")).status, 400);
  assert.equal((await finder("no/such/node")).status, 409);
  // No vault is set in the test root, so a copy is refused before anything is written.
  const copy = await fetch(`${base}/api/nodes/copy`, { method: "POST", body: JSON.stringify({ path: path.join(docs, "plan.md") }), headers: { origin: base } });
  assert.equal(copy.status, 409);
  const node = await (await fetch(`${base}/api/node?path=work/vmt-analyzer`)).json();
  assert.deepEqual(node.docs.map((d: any) => d.name).sort(), ["link.md", "plan.md"]);
  fs.rmSync(path.join(root, "work", "repo-node"), { recursive: true });
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

test("dispatch returns at once and keeps a failed job for retry until dismissed", async () => {
  const post = async (op: string, body: unknown) =>
    (await fetch(`${base}/api/nodes/${op}`, { method: "POST", body: JSON.stringify(body), headers: { origin: base } })).json();
  const jobs = async () => (await fetch(`${base}/api/dispatches`)).json();
  // A scope outside the root fails before any Haiku call.
  const job = await post("dispatch", { path: "../../tmp", prompt: "do a thing" });
  assert.equal(job.prompt, "do a thing");
  await new Promise((r) => setTimeout(r, 50));
  assert.match((await jobs()).find((j: any) => j.id === job.id).error, /\S/);
  await post("retry", { id: job.id });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok((await jobs()).find((j: any) => j.id === job.id).error);
  // Only a job waiting on a choice can be chosen.
  assert.match((await post("choose", { id: job.id, index: 0 })).error, /no such choice/);
  await post("dismiss", { id: job.id });
  assert.equal((await jobs()).length, 0);
});
