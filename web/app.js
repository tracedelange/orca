const DURATION = 500;
const POLL_MS = 5000;
// Pack is laid out with no padding; drawing children slightly smaller leaves gaps that scale with zoom.
const SHRINK = 0.9;
// A node's state comes from the sessions in its subtree, most urgent first.
const STATES = ["needs", "new", "working", "ready", "idle"];
const STATE_LABEL = { needs: "needs you", new: "new result", working: "working", ready: "seen", idle: "idle" };
const STATE_MARK = { needs: "◆", new: "◉", working: "●", ready: "○", idle: "·" };

const svg = d3.select("#map");
const gRing = svg.append("g").attr("class", "ring");
const gNodes = svg.append("g");
const crumbs = document.getElementById("crumbs");
const panel = document.getElementById("panel");

let root = null;      // packed d3 hierarchy
let byPath = new Map();
let focus = null;
let view = null;      // [x, y, r] of the layout circle that fills the focus ring
let geo = null;       // screen centre and ring radius
let selected = null;  // path shown in the panel
let treeText = "";
let panelText = "";
let panelFile = "";
let term = null;      // open terminal: { xterm, ws, ro, name, path }
let lastTerm = null;  // { name, path, host } of the last terminal, for ⌘.
let workerList = [];  // [{ host, name, error }] from /api/workers
// A session is the open terminal when its tmux name and machine both match.
const isOpen = (s, t = term) => !!t && s.tmux === t.name && (s.host ?? null) === (t.host ?? null);
const termview = document.getElementById("termview");
let panelNode = null; // last node rendered in the panel
let editing = false;  // a form is open in the panel; polling must not redraw it
const lockButton = document.getElementById("lock");
const rail = document.getElementById("rail");
let seen = readSeen(); // sessionId -> finishedAt of the last result you looked at
let arcSeq = 0;

// ---- Data ----

async function load() {
  fetch("/api/workers").then((r) => r.json()).then((w) => (workerList = w)).catch(() => {});
  const res = await fetch("/api/tree");
  const text = await res.text();
  if (!res.ok) return (crumbs.textContent = JSON.parse(text).error);
  if (text !== treeText) {
    treeText = text;
    root = d3.pack().size([1000, 1000]).padding(0)(
      d3.hierarchy(JSON.parse(text))
        .sum((d) => (d.children.length ? 0 : 1))
        .sort((a, b) => b.value - a.value || a.data.path.localeCompare(b.data.path)),
    );
    byPath = new Map(root.descendants().map((d) => [d.data.path, d]));
    const target = nodeAt(pathFromHash());
    view = [target.x, target.y, target.r];
    show(target, 0);
  }
  if (term) markSeen(sessionsIn(root).filter((s) => isOpen(s)));
  pruneSeen();
  renderRail();
  if (selected !== null) refreshPanel();
}

// ---- Session state ----

function readSeen() {
  try { return JSON.parse(localStorage.getItem("orca.seen")) ?? {}; } catch { return {}; }
}
function writeSeen() {
  try { localStorage.setItem("orca.seen", JSON.stringify(seen)); } catch {}
}
function markSeen(sessions) {
  const fresh = sessions.filter(isNew);
  if (!fresh.length) return;
  for (const s of fresh) seen[s.sessionId] = s.finishedAt;
  writeSeen();
  renderRail();
  show(focus, 0);
  // The panel only redraws when server data changes, and "seen" is local, so force it.
  panelText = "";
  if (selected !== null) refreshPanel();
}
function pruneSeen() {
  const live = new Set(sessionsIn(root).map((s) => s.sessionId));
  const before = Object.keys(seen).length;
  seen = Object.fromEntries(Object.entries(seen).filter(([id]) => live.has(id)));
  if (Object.keys(seen).length !== before) writeSeen();
}

// A finished turn you have not opened since it finished.
const isNew = (s) => s.state === "ready" && !!s.finishedAt && s.finishedAt > (seen[s.sessionId] ?? "");
const sessionState = (s) => (s.state === "needs-input" ? "needs" : isNew(s) ? "new" : s.state);
const sessionsIn = (d) => d.descendants().flatMap((x) => x.data.sessions.map((s) => ({ ...s, path: x.data.path, title: x.data.title })));
const stateOf = (d) => STATES.find((st) => sessionsIn(d).some((s) => sessionState(s) === st)) ?? "idle";

// Nearest existing node, walking up if the path was deleted. Never above the lock.
function nodeAt(p) {
  while (p && !byPath.has(p)) p = p.split("/").slice(0, -1).join("/");
  const d = byPath.get(p) ?? root;
  const lock = lockNode();
  return lock && !within(d.data.path, lock.data.path) ? lock : d;
}

const pathFromHash = () => decodeURIComponent(location.hash.replace(/^#\/?/, ""));
const hashFor = (p) => "#/" + p.split("/").map(encodeURIComponent).join("/");
const go = (d) => (location.hash = hashFor(d.data.path));
const up = () => focus?.parent && focus !== lockNode() && go(focus.parent);
const within = (p, base) => base === "" || p === base || p.startsWith(base + "/");

// ---- Map ----

function show(target, duration) {
  focus = target;
  // Keep the URL on the node actually shown, e.g. after clamping to the lock.
  if (location.hash !== hashFor(focus.data.path)) history.replaceState(null, "", hashFor(focus.data.path));
  const t = svg.transition("zoom").duration(duration).ease(d3.easeCubicInOut);

  gNodes.selectAll("g.node")
    .data(focus.children ?? [], (d) => d.data.path)
    .join(
      (enter) => enter.append("g").call(build).style("opacity", 0),
      (update) => update,
      (exit) => exit.classed("leaving", true).transition(t).style("opacity", 0).remove(),
    )
    .call(fill)
    .transition(t)
    .style("opacity", 1);

  gRing.attr("class", `ring a-${stateOf(focus)}`);
  gRing.select(".ring-label textPath").text([focus.data.title, rimText(focus)].filter(Boolean).join("  ·  ").toUpperCase());
  gRing.select(".sessions").datum(focus).call(drawDots);
  gRing.select(".empty").style("display", focus.children ? "none" : null);
  renderCrumbs();

  const i = d3.interpolateZoom(view, [focus.x, focus.y, focus.r]);
  position();
  t.tween("zoom", () => (k) => {
    view = i(k);
    position();
  });
}

function build(g) {
  g.attr("class", "node").each(function () {
    const n = d3.select(this);
    const id = `arc${arcSeq++}`;
    n.append("circle").attr("class", "rim");
    n.append("path").attr("class", "arc").attr("id", id);
    n.append("text").attr("class", "label").append("textPath").attr("href", `#${id}`).attr("startOffset", "50%");
    n.append("text").attr("class", "title");
    const badge = n.append("g").attr("class", "badge");
    badge.append("circle").attr("r", 10);
    badge.append("text").attr("dy", "0.35em");
    n.append("g").attr("class", "sessions");
    const info = n.append("g").attr("class", "info");
    info.append("circle").attr("r", 8);
    info.append("text").attr("dy", "0.35em").text("i");
  });
  g.on("click", (e, d) => {
    e.stopPropagation();
    d.children ? go(d) : select(d.data.path);
  });
  g.select(".info").on("click", function (e) {
    e.stopPropagation();
    select(d3.select(this.parentNode).datum().data.path);
  });
}

function fill(sel) {
  sel.attr("class", (d) => `node a-${stateOf(d)}${d.data.path === selected ? " selected" : ""}`);
  sel.select(".sessions").call(drawDots);
  sel.select(".label textPath").text((d) => rimText(d));
  sel.select(".title").each(function (d) { wrapTitle(d3.select(this), d.data.title); });
  sel.select(".badge").style("display", (d) => (d.children ? null : "none")).select("text").text((d) => d.data.childCount);
  sel.select(".info").style("display", (d) => (d.children ? null : "none"));
}

// Counts cover the whole subtree, because the map does not draw below the children.
function rimText(d) {
  const states = sessionsIn(d).map(sessionState);
  const count = (st) => states.filter((x) => x === st).length;
  return [
    count("needs") && "needs you",
    count("new") && `${count("new")} new`,
    count("working") && `${count("working")} working`,
    d.data.issues.length && `${d.data.issues.length} to check`,
  ].filter(Boolean).join("  ·  ").toUpperCase();
}

// One dot per session, spaced along the lower-left rim. Radius is set in position() / drawRing().
function drawDots(g) {
  g.selectAll("g.dot")
    .data((d) => d.data.sessions, (s) => s.sessionId)
    .join((enter) => {
      const dot = enter.append("g");
      dot.append("g").attr("class", "spin").append("circle");
      return dot;
    })
    .attr("class", (s) => `dot ${sessionState(s)}`)
    .attr("transform", (_, i) => `rotate(${135 + i * 12})`)
    .select("circle")
    .attr("r", (s) => (["needs", "new"].includes(sessionState(s)) ? 5 : 3.5));
}

function wrapTitle(text, title) {
  const lines = [];
  for (const word of title.split(/\s+/)) {
    const last = lines.at(-1);
    if (last && `${last} ${word}`.length <= 14) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  if (lines.length > 3) (lines.length = 3), (lines[2] += "…");
  text.selectAll("tspan").data(lines).join("tspan")
    .attr("x", 0)
    .attr("dy", (_, i) => (i ? "1.1em" : `${0.35 - (lines.length - 1) * 0.55}em`))
    .text((l) => l);
}

// Places every drawn node for the current view. Runs once per animation frame.
function position() {
  const k = geo.R / view[2];
  gNodes.selectAll("g.node").each(function (d) {
    const x = geo.cx + (d.x - view[0]) * k;
    const y = geo.cy + (d.y - view[1]) * k;
    const r = d.r * k * SHRINK;
    const ar = Math.max(r - 13, 1);
    const n = d3.select(this);
    n.select(".rim").attr("cx", x).attr("cy", y).attr("r", r);
    n.select(".arc").attr("d", `M${x - ar},${y}A${ar},${ar} 0 0 1 ${x + ar},${y}`);
    n.select(".label").style("display", r < 56 ? "none" : null);
    n.select(".title")
      .attr("transform", `translate(${x},${y})`)
      .style("font-size", `${Math.max(11, Math.min(26, r * 0.19))}px`)
      .style("display", r < 30 ? "none" : null);
    n.select(".badge").attr("transform", `translate(${x},${y + r})`);
    n.select(".sessions").attr("transform", `translate(${x},${y})`).selectAll("circle").attr("cx", r);
    n.select(".info").attr("transform", `translate(${x + r * Math.SQRT1_2},${y + r * Math.SQRT1_2})`);
  });
}

function buildRing() {
  gRing.append("circle").attr("class", "ring-line");
  gRing.append("g").attr("class", "ticks").selectAll("line").data(d3.range(120)).join("line")
    .classed("major", (i) => i % 10 === 0);
  gRing.append("path").attr("id", "ring-arc").attr("fill", "none");
  gRing.append("text").attr("class", "ring-label").append("textPath").attr("href", "#ring-arc").attr("startOffset", "50%");
  gRing.append("g").attr("class", "sessions");
  gRing.append("text").attr("class", "empty").attr("dy", "0.35em").text("NO CHILD NODES");
}

function drawRing() {
  const { cx, cy, R } = geo;
  const lr = R + 30;
  gRing.select(".ring-line").attr("cx", cx).attr("cy", cy).attr("r", R);
  gRing.select(".ticks").attr("transform", `translate(${cx},${cy})`).selectAll("line")
    .attr("y1", -R - 5)
    .attr("y2", (i) => -R - (i % 10 === 0 ? 15 : 9))
    .attr("transform", (i) => `rotate(${i * 3})`);
  gRing.select("#ring-arc").attr("d", `M${cx - lr},${cy}A${lr},${lr} 0 0 1 ${cx + lr},${cy}`);
  gRing.select(".empty").attr("x", cx).attr("y", cy);
  gRing.select(".sessions").attr("transform", `translate(${cx},${cy})`).selectAll("circle").attr("cx", R);
}

function measure() {
  const left = rail.hidden ? 0 : rail.offsetWidth;
  const w = innerWidth - left - (selected !== null ? panel.offsetWidth : 0);
  const h = innerHeight;
  return { cx: left + w / 2, cy: h / 2 + 16, R: Math.max(80, Math.min(w, h) / 2 - 84) };
}

// ---- Rail: every session under the lock, most urgent first ----

function renderRail() {
  const sessions = sessionsIn(lockNode() ?? root).sort(
    (a, b) => STATES.indexOf(sessionState(a)) - STATES.indexOf(sessionState(b)) || b.updatedAt.localeCompare(a.updatedAt),
  );
  const attention = sessions.filter((s) => ["needs", "new"].includes(sessionState(s))).length;
  document.title = attention ? `(${attention}) Orca` : "Orca";

  const wasHidden = rail.hidden;
  rail.hidden = !sessions.length;
  rail.querySelector("ol").innerHTML = sessions.map((s) => {
    const st = sessionState(s);
    return `<li><button type="button" class="end" data-end="${esc(s.sessionId)}" data-state="${st}" title="End this session">End</button><button type="button" class="a-${st}${isOpen(s) ? " open" : ""}" data-path="${esc(s.path)}" data-sid="${esc(s.sessionId)}">
      <span class="line"><span class="mark">${STATE_MARK[st]}</span><span class="name">${esc(s.title)}</span><span class="st">${STATE_LABEL[st]}</span></span>
      ${s.summary ? `<span class="sum">${esc(s.summary)}</span>` : ""}
      <span class="meta">${s.host ? `${esc(s.host)} · ` : ""}${esc(s.path || "/")} · ${ago(s.updatedAt)}</span>
    </button></li>`;
  }).join("");
  if (wasHidden !== rail.hidden) relayout(300);
}

rail.addEventListener("click", async (e) => {
  const endButton = e.target.closest("[data-end]");
  if (endButton) return endSession(endButton);
  const row = e.target.closest("button[data-sid]");
  if (!row) return;
  const s = sessionsIn(root).find((x) => x.sessionId === row.dataset.sid);
  const d = byPath.get(row.dataset.path);
  if (!s || !d) return;
  // In terminal mode, switch terminals without touching the map.
  if (term && s.tmux) return openTerminal(s.tmux, d.data.path, s.host);
  // Focus the parent so the node's circle is on screen.
  location.hash = hashFor((d.parent ?? d).data.path);
  await select(d.data.path);
  if (s.tmux) openTerminal(s.tmux, d.data.path, s.host);
  else markSeen([s]);
});

function relayout(duration) {
  termview.style.left = `${rail.hidden ? 0 : rail.offsetWidth}px`;
  const from = geo;
  const to = measure();
  if (!duration) {
    geo = to;
    drawRing();
    return view && position();
  }
  const i = d3.interpolateObject(from, to);
  svg.transition("geo").duration(duration).ease(d3.easeCubicInOut).tween("geo", () => (t) => {
    geo = i(t);
    drawRing();
    position();
  });
}

// The lock is per browser. The locked node is the top of the map: zooming out stops there.
function getLock() {
  try { return localStorage.getItem("orca.lock"); } catch { return null; }
}
function setLock(p) {
  try { p === null ? localStorage.removeItem("orca.lock") : localStorage.setItem("orca.lock", p); } catch {}
}
const lockNode = () => byPath.get(getLock()) ?? null;

function renderCrumbs() {
  const lock = lockNode();
  lockButton.textContent = lock ? "Unlock" : "Lock";
  lockButton.classList.toggle("on", !!lock);
  crumbs.replaceChildren();
  const trail = focus.ancestors().reverse();
  trail.slice(lock ? trail.indexOf(lock) : 0).forEach((d, i, all) => {
    if (i) crumbs.append(Object.assign(document.createElement("span"), { className: "sep", textContent: "/" }));
    const here = i === all.length - 1;
    const el = document.createElement(here ? "span" : "a");
    el.textContent = d.data.title;
    if (here) el.className = "here";
    else el.href = hashFor(d.data.path);
    if (d === lock) el.classList.add("locked");
    crumbs.append(el);
  });
}

// ---- Panel ----

async function select(p) {
  editing = false;
  selected = p;
  gNodes.selectAll("g.node").classed("selected", (d) => d.data.path === selected);
  panelText = "";
  await refreshPanel();
  if (panel.hidden) {
    panel.hidden = false;
    relayout(300);
  }
}

function closePanel() {
  editing = false;
  selected = null;
  panel.hidden = true;
  gNodes.selectAll("g.node").classed("selected", false);
  relayout(300);
}

async function refreshPanel() {
  if (editing) return;
  const p = selected;
  const res = await fetch(`/api/node?path=${encodeURIComponent(p)}`);
  if (p !== selected) return;
  if (!res.ok) return closePanel();
  const text = await res.text();
  if (text === panelText) return;
  panelText = text;
  renderPanel(JSON.parse(text));
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function renderPanel(n) {
  panelNode = n;
  panelFile = n.file;
  const rows = [
    ["repo", n.repos.join("\n") || null],
    ["branch", n.branch],
    ...Object.entries(n.extra).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]),
  ].filter(([, v]) => v != null);
  panel.innerHTML = `
    <div class="top"><span class="kicker">${esc(n.path || "/")}</span><button class="close" type="button">Close</button></div>
    <h1>${esc(n.title)}</h1>
    ${n.goal ? `<p class="goal">${esc(n.goal)}</p>` : ""}
    <dl>
      ${rows.map(([k, v, cls]) => `<dt>${esc(k)}</dt><dd class="${cls ?? ""}">${esc(v)}</dd>`).join("")}
      <dt>file</dt><dd class="file"><code>${esc(n.file)}</code><button class="copy" type="button">Copy</button></dd>
    </dl>
    <div class="actions">
      <button data-form="edit" type="button">Edit</button>
      <button data-form="child" type="button">Add child</button>
      ${n.path ? `<button data-form="move" type="button">Move</button><button data-form="remove" type="button">Delete</button>` : ""}
    </div>
    <form class="form" hidden></form>
    ${renderSessions(n.sessions)}
    ${n.issues.length ? `<ul class="issues">${n.issues.map((i) => `<li>${esc(i.level)}: ${esc(i.message)}</li>`).join("")}</ul>` : ""}
    <div class="md">${n.html}</div>`;
  // The goal already shows under the title; drop its body section.
  const h = [...panel.querySelectorAll(".md h2")].find((el) => el.textContent.trim().toLowerCase() === "goal");
  while (h?.nextElementSibling && !/^H[1-6]$/.test(h.nextElementSibling.tagName)) h.nextElementSibling.remove();
  h?.remove();
}

function renderSessions(sessions) {
  const items = sessions.map((s) => `
    <li class="a-${sessionState(s)}">
      <div class="meta"><span class="state">${STATE_MARK[sessionState(s)]} ${STATE_LABEL[sessionState(s)]}</span><code>${esc(s.host ? `${s.host} · ${s.tmux ?? "no tmux"}` : (s.tmux ?? "no tmux"))}</code><time>${ago(s.updatedAt)}</time></div>
      <div class="cwd"><code>${esc(s.cwd)}</code></div>
      ${s.summary ? `<p>${esc(s.summary)}</p>` : ""}
      <span class="row">
        ${s.tmux ? `<button class="attach" type="button" data-tmux="${esc(s.tmux)}" data-host="${esc(s.host ?? "")}">Terminal</button>` : ""}
        ${!s.tmux && !s.host ? `<button class="adopt" type="button" data-adopt="${esc(s.sessionId)}"${s.state === "ready" ? "" : ` disabled title="Wait until the turn finishes"`}>Move into orca</button>` : ""}
        <button class="end" type="button" data-end="${esc(s.sessionId)}" data-state="${sessionState(s)}">End</button>
      </span>
    </li>`);
  return `<section class="sessions">
    <div class="sec-head"><span>Sessions</span><span class="row">${whereSelect()}<button class="resume" type="button">Resume</button><button class="launch" type="button">Launch</button></span></div>
    ${items.length ? `<ul>${items.join("")}</ul>` : `<div class="none">No sessions</div>`}
  </section>`;
}


function ago(iso) {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Where new sessions run: this machine, or a worker. Hidden when there are no workers.
function whereSelect() {
  if (!workerList.length) return "";
  const opts = workerList.map((w) => `<option value="${esc(w.name)}"${w.error ? " disabled" : ""}>${esc(w.name)}${w.error ? " (offline)" : ""}</option>`);
  return `<select class="where" name="host" title="Where the session runs"><option value="">this machine</option>${opts.join("")}</select>`;
}

// Quits a session running in some other terminal and resumes its conversation in tmux, here.
async function adoptSession(button) {
  button.disabled = true;
  button.textContent = "Moving…";
  try {
    const a = await post("adopt", { session: button.dataset.adopt });
    await load();
    openTerminal(a.tmux, a.path);
  } catch (err) {
    alertInPanel(err.message);
    button.disabled = false;
    button.textContent = "Move into orca";
  }
}

async function launchSession(resume) {
  const host = panel.querySelector(".sessions .where")?.value ?? "";
  const q = `path=${encodeURIComponent(selected)}${resume ? "&resume=1" : ""}${host ? `&host=${encodeURIComponent(host)}` : ""}`;
  const res = await fetch(`/api/launch?${q}`, { method: "POST" });
  const body = await res.json();
  if (!res.ok) return alertInPanel(body.error);
  await load();
  openTerminal(body.tmux, selected, body.host);
}

// Ending quits Claude; the conversation stays on disk for Resume. A session that is still
// working or waiting on you needs a second click.
async function endSession(button) {
  const id = button.dataset.end;
  if (["working", "needs"].includes(button.dataset.state) && !button.classList.contains("armed")) {
    button.classList.add("armed");
    button.textContent = "Sure?";
    setTimeout(() => {
      button.classList.remove("armed");
      button.textContent = "End";
    }, 3000);
    return;
  }
  const s = sessionsIn(root).find((x) => x.sessionId === id);
  if (s && isOpen(s)) closeTerminal();
  try {
    await post("end", { session: id });
  } catch (err) {
    return alertInPanel(err.message);
  }
  await load();
  panelText = "";
  if (selected !== null) refreshPanel();
}

const alertInPanel = (msg) => panel.querySelector(".sessions .sec-head span").replaceChildren(`Sessions · ${msg}`);

// ---- Editing ----

const field = (label, html) => `<label><span>${label}</span>${html}</label>`;

const FORMS = {
  edit: (n) => `
    ${field("Title", `<input name="title" value="${esc(n.title)}" required>`)}
    ${field("Goal", `<textarea name="goal" rows="2">${esc(n.goal ?? "")}</textarea>`)}
    <div class="row"><button type="submit">Save</button><button class="cancel" type="button">Cancel</button></div>`,
  child: () => `
    ${field("Folder", `<input name="name" pattern="[^/.][^/]*" placeholder="data-pipeline" required>`)}
    ${field("Title", `<input name="title" placeholder="Same as folder">`)}
    ${field("Goal", `<textarea name="goal" rows="2"></textarea>`)}
    <div class="row"><button type="submit">Create</button><button class="cancel" type="button">Cancel</button></div>`,
  move: (n) => `
    ${field("New path", `<input name="to" value="${esc(n.path)}" required>`)}
    <p class="hint">Change the last part to rename. Change the rest to move it under another node.</p>
    <div class="row"><button type="submit">Move</button><button class="cancel" type="button">Cancel</button></div>`,
  dispatch: (n) => `
    ${field(`What needs doing under ${esc(n.title)}?`, `<textarea name="prompt" rows="6" required placeholder="Plain instructions. Orca files it into the tree and starts Claude on it."></textarea>`)}
    <div class="row"><button type="submit">Dispatch</button><button class="cancel" type="button">Cancel</button>${whereSelect()}<span class="hint">⌘↵</span></div>`,
  remove: (n) => `
    <p class="hint">Moves ${esc(n.path)} and everything under it to <code>.trash</code> in the node root.</p>
    <div class="row"><button class="danger" type="submit">Delete</button><button class="cancel" type="button">Cancel</button></div>`,
};

function openForm(kind) {
  const form = panel.querySelector(".form");
  form.dataset.kind = kind;
  form.innerHTML = FORMS[kind](panelNode) + `<p class="err" hidden></p>`;
  form.hidden = false;
  editing = true;
  form.querySelector("input, textarea, button[type=submit]").focus();
}

function closeForm() {
  editing = false;
  panelText = "";
  refreshPanel();
}

async function post(op, body) {
  const res = await fetch(`/api/nodes/${op}`, { method: "POST", body: JSON.stringify(body) });
  const out = await res.json();
  if (!res.ok) throw new Error(out.error);
  return out;
}

// Rewrites a path after the node at `from` moved to `to`.
const rebase = (p, from, to) => (within(p, from) ? to + p.slice(from.length) : p);

async function submitForm(form) {
  const n = panelNode;
  const v = Object.fromEntries(new FormData(form));
  const kind = form.dataset.kind;
  if (kind === "dispatch") return submitDispatch(form, n, v.prompt, v.host);
  try {
    if (kind === "edit") {
      await post("update", { path: n.path, ...v });
    } else if (kind === "child") {
      await post("create", { path: n.path ? `${n.path}/${v.name}` : v.name, title: v.title, goal: v.goal });
      location.hash = hashFor(n.path); // zoom into the parent so the new child shows
    } else if (kind === "move") {
      const to = (await post("move", { from: n.path, to: v.to.replace(/^\/+|\/+$/g, "") })).path;
      if (getLock() !== null) setLock(rebase(getLock(), n.path, to));
      selected = to;
      location.hash = hashFor(rebase(focus.data.path, n.path, to));
    } else if (kind === "remove") {
      await post("remove", { path: n.path });
      if (getLock() !== null && within(getLock(), n.path)) setLock(null);
      closePanel();
      const parent = n.path.split("/").slice(0, -1).join("/");
      if (within(focus.data.path, n.path)) location.hash = hashFor(parent);
    }
  } catch (err) {
    const el = form.querySelector(".err");
    el.textContent = err.message;
    el.hidden = false;
    return;
  }
  await load();
  if (selected !== null) closeForm();
}

// Placement takes a few seconds (a Haiku call), so the form shows progress, then the terminal opens.
async function submitDispatch(form, n, prompt, host) {
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  button.textContent = `Finding a place under ${n.title}…`;
  try {
    const d = await post("dispatch", { path: n.path, prompt, host });
    editing = false;
    await load();
    const target = byPath.get(d.path);
    if (target?.parent) location.hash = hashFor(target.parent.data.path);
    await select(d.path);
    openTerminal(d.tmux, d.path, d.host);
  } catch (err) {
    button.disabled = false;
    button.textContent = "Dispatch";
    const el = form.querySelector(".err");
    el.textContent = err.message;
    el.hidden = false;
  }
}

panel.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && e.target.form) e.target.form.requestSubmit();
});

panel.addEventListener("submit", (e) => {
  e.preventDefault();
  submitForm(e.target);
});

// ---- Terminal ----

// Terminal mode is the detailed view; the map is the default. Esc always leads back to the map.
async function openTerminal(name, path = selected ?? focus.data.path, host = undefined) {
  await document.fonts.load("13px 'Azeret Mono'");
  if (term) stopTerminal();
  document.body.classList.add("mode-term");
  termview.hidden = false;
  const d = byPath.get(path);
  termview.querySelector(".kicker").textContent = [d?.data.title ?? path, path || "/", host, name].filter(Boolean).join("  ·  ");
  relayout(0);

  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  const xterm = new Terminal({
    fontFamily: "'Azeret Mono', monospace",
    fontSize: 13,
    cursorBlink: true,
    theme: { background: v("--paper-2"), foreground: v("--ink"), cursor: v("--ink"), selectionBackground: v("--ink-3") },
  });
  const fit = new FitAddon.FitAddon();
  xterm.loadAddon(fit);
  const el = document.getElementById("term");
  xterm.open(el);
  // These keys belong to orca, not Claude; stop them so the page handlers do not act on them twice.
  xterm.attachCustomKeyEventHandler((e) => {
    if (e.key === "Escape" || (e.key === "." && e.metaKey)) e.stopPropagation();
    if (e.key === "Escape") {
      if (e.type === "keydown") e.shiftKey ? send("\x1b") : closeTerminal();
      return false;
    }
    if (e.key === "." && e.metaKey) {
      if (e.type === "keydown") closeTerminal();
      return false;
    }
    return true;
  });

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/api/term?session=${encodeURIComponent(name)}${host ? `&host=${encodeURIComponent(host)}` : ""}`);
  const resize = () => {
    fit.fit();
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ r: [xterm.cols, xterm.rows] }));
  };
  ws.onopen = resize;
  ws.onmessage = (e) => xterm.write(e.data);
  ws.onclose = () => xterm.write("\r\n[disconnected]\r\n");
  const send = (d) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ i: d }));
  xterm.onData(send);
  const ro = new ResizeObserver(resize);
  ro.observe(el);
  term = { xterm, ws, ro, name, path, host };
  lastTerm = { name, path, host };
  markSeen(sessionsIn(root).filter((s) => isOpen(s)));
  renderRail();
  xterm.focus();
}

function stopTerminal() {
  term.ro.disconnect();
  term.ws.close();
  term.xterm.dispose();
  term = null;
}

// Back to the map. By default it focuses the session's node with its details open.
function closeTerminal(toSession = true) {
  const { path } = term;
  stopTerminal();
  document.body.classList.remove("mode-term");
  termview.hidden = true;
  renderRail();
  const d = byPath.get(path);
  if (d && toSession) {
    location.hash = hashFor((d.parent ?? d).data.path);
    select(path);
  }
  relayout(0);
}

function toggleTerminal() {
  if (term) return closeTerminal();
  if (lastTerm && sessionsIn(root).some((s) => isOpen(s, lastTerm))) openTerminal(lastTerm.name, lastTerm.path, lastTerm.host);
}

panel.addEventListener("click", (e) => {
  if (e.target.closest(".close")) closePanel();
  if (e.target.closest(".cancel")) closeForm();
  const open = e.target.closest("[data-form]");
  if (open) openForm(open.dataset.form);
  if (e.target.closest(".launch")) launchSession(false);
  if (e.target.closest(".resume")) launchSession(true);
  const endButton = e.target.closest("[data-end]");
  if (endButton) endSession(endButton);
  const adopt = e.target.closest("[data-adopt]");
  if (adopt) adoptSession(adopt);
  const attach = e.target.closest(".attach");
  if (attach) openTerminal(attach.dataset.tmux, selected, attach.dataset.host || undefined);
  const copy = e.target.closest(".copy");
  if (copy) navigator.clipboard.writeText(panelFile).then(() => (copy.textContent = "Copied"));
});

// ---- Wiring ----

document.getElementById("about").addEventListener("click", () => focus && select(focus.data.path));
// Header forms act on the node you are in.
async function openFocusForm(kind) {
  if (!focus) return;
  await select(focus.data.path);
  openForm(kind);
}
document.getElementById("new").addEventListener("click", () => openFocusForm("child"));
document.getElementById("dispatch").addEventListener("click", () => openFocusForm("dispatch"));
svg.on("click", up);
addEventListener("hashchange", () => {
  if (!root) return;
  if (term) closeTerminal(false); // a breadcrumb click in terminal mode goes where it points
  show(nodeAt(pathFromHash()), DURATION);
});
document.getElementById("mapbtn").addEventListener("click", () => term && closeTerminal());
addEventListener("resize", () => relayout(0));
lockButton.addEventListener("click", () => {
  setLock(lockNode() ? null : focus.data.path);
  renderCrumbs();
});
addEventListener("keydown", (e) => {
  if (e.key === "." && e.metaKey) {
    e.preventDefault();
    return toggleTerminal();
  }
  if (e.key === "Escape" && term) return closeTerminal(); // terminal not focused
  const typing = e.target.closest?.("input, textarea, select, .xterm");
  if (e.key === "/" && !typing && !term) {
    e.preventDefault();
    return openFocusForm("dispatch");
  }
  if (e.key !== "Escape" || term) return;
  if (editing) return closeForm();
  selected !== null ? closePanel() : up();
});

// ---- Plan usage ----

// Same windows as the Hammerspoon panel: 5h counts down to its reset, the week names the reset day.
async function loadUsage() {
  const el = document.getElementById("usage");
  const u = await fetch("/api/usage").then((r) => r.json()).catch(() => ({ error: "unavailable" }));
  if (u.error) return (el.textContent = `usage ${u.error}`);
  const left = (t) => {
    const m = Math.max(0, Math.round((new Date(t) - Date.now()) / 60000));
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
  };
  const day = (t) => new Date(t).toLocaleString([], { weekday: "short", hour: "numeric" });
  const who = Object.assign(document.createElement("span"), { className: "who", textContent: u.email ?? "not logged in" });
  el.replaceChildren(who, ...[["5h", u.five_hour, left], ["wk", u.seven_day, day]].filter(([, w]) => w).map(([label, w, when]) => {
    const pct = Math.round(w.utilization);
    const row = document.createElement("span");
    row.className = pct >= 80 ? "hot" : "";
    row.innerHTML = `<b>${label}</b><i style="--pct:${pct}%"></i>${pct}%${w.resets_at ? ` · ${when(w.resets_at)}` : ""}`;
    return row;
  }));
}

// The bare URL opens the locked node.
if (!location.hash && getLock() !== null) history.replaceState(null, "", hashFor(getLock()));
buildRing();
relayout(0);
load();
setInterval(load, POLL_MS);
loadUsage();
setInterval(loadUsage, 60_000);
