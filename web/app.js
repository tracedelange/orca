const POLL_MS = 5000;
// A node's state comes from its sessions, most urgent first. A packed node also counts what it hides.
const STATES = ["needs", "new", "working", "ready", "idle"];
const STATE_LABEL = { needs: "needs you", new: "new result", working: "working", ready: "seen", idle: "idle" };
const STATE_MARK = { needs: "◆", new: "◉", working: "●", ready: "○", idle: "·" };

const svg = d3.select("#map");
const gView = svg.append("g");                       // pan and zoom apply here
const gLinks = gView.append("g").attr("class", "links");
const gNodes = gView.append("g");
const crumbs = document.getElementById("crumbs");
const panel = document.getElementById("panel");

let tree = null;      // d3 hierarchy of the whole node tree
let byPath = new Map();
let graphRoot = null;       // the root of the graph; any node can be it
let expanded = readSet("orca.expanded"); // unpacked nodes, per browser
const pos = new Map(); // path -> simulation node, so positions survive each poll
let shownKey = "";    // visible paths; the layout reheats only when this changes
let center = { cx: 0, cy: 0 };
let selected = null;  // path shown in the panel
let treeText = "";
let panelText = "";
let panelFile = "";
let term = null;      // open terminal: { xterm, ws, ro, name, path, host }
let lastTerm = null;  // { name, path, host } of the last terminal, for ⌘.
let workerList = [];  // [{ host, name, error }] from /api/workers
// A session is the open terminal when its tmux name and machine both match.
const isOpen = (s, t = term) => !!t && s.tmux === t.name && (s.host ?? null) === (t.host ?? null);
const termview = document.getElementById("termview");
let panelNode = null; // last node rendered in the panel
let editing = false;  // a form is open in the panel; polling must not redraw it
const rail = document.getElementById("rail");
let seen = readSeen(); // sessionId -> finishedAt of the last result you looked at
const revealed = new Set(); // sessionIds whose node has been unpacked onto the map once
let showArchived = readFlag("orca.showArchived");
const archivedButton = document.getElementById("archived");
archivedButton.classList.toggle("on", showArchived);

// ---- Data ----

async function load() {
  fetch("/api/workers").then((r) => r.json()).then((w) => (workerList = w)).catch(() => {});
  const res = await fetch("/api/tree");
  const text = await res.text();
  if (!res.ok) return (crumbs.textContent = JSON.parse(text).error);
  if (text !== treeText) {
    treeText = text;
    tree = d3.hierarchy(JSON.parse(text), shownChildren).sort((a, b) => a.data.path.localeCompare(b.data.path));
    byPath = new Map(tree.descendants().map((d) => [d.data.path, d]));
    graphRoot = nodeAt(pathFromHash());
    render();
  }
  if (term) markSeen(sessionsIn(tree).filter((s) => isOpen(s)));
  pruneSeen();
  revealActive();
  renderRail();
  if (selected !== null) refreshPanel();
}

// Archived nodes leave the tree unless shown, or unless a session is still live inside them.
const hasSessions = (n) => n.sessions.length > 0 || n.children.some(hasSessions);
const shownChildren = (n) => n.children.filter((c) => showArchived || !c.archived || hasSessions(c));

function readFlag(key) {
  try { return localStorage.getItem(key) === "1"; } catch { return false; }
}
archivedButton.addEventListener("click", () => {
  showArchived = !showArchived;
  archivedButton.classList.toggle("on", showArchived);
  try { localStorage.setItem("orca.showArchived", showArchived ? "1" : "0"); } catch {}
  treeText = ""; // rebuild the hierarchy with the new filter
  load();
});

async function setArchived(path, archived) {
  await post("update", { path, archived });
  panelText = "";
  await load();
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
  render();
  // The panel only redraws when server data changes, and "seen" is local, so force it.
  panelText = "";
  if (selected !== null) refreshPanel();
}
function pruneSeen() {
  const live = new Set(sessionsIn(tree).map((s) => s.sessionId));
  const before = Object.keys(seen).length;
  seen = Object.fromEntries(Object.entries(seen).filter(([id]) => live.has(id)));
  if (Object.keys(seen).length !== before) writeSeen();
}

// A finished turn you have not opened since it finished.
const isNew = (s) => s.state === "ready" && !!s.finishedAt && s.finishedAt > (seen[s.sessionId] ?? "");
const sessionState = (s) => (s.state === "needs-input" ? "needs" : isNew(s) ? "new" : s.state);
const withNode = (x) => x.data.sessions.map((s) => ({ ...s, path: x.data.path, title: x.data.title, background: x.data.background }));
const sessionsIn = (d) => d.descendants().flatMap(withNode);
const mostUrgent = (sessions) => STATES.find((st) => sessions.some((s) => sessionState(s) === st)) ?? "idle";

// ---- Root and unpacked nodes ----

function readSet(key) {
  try { return new Set(JSON.parse(localStorage.getItem(key)) ?? []); } catch { return new Set(); }
}
function writeExpanded() {
  try { localStorage.setItem("orca.expanded", JSON.stringify([...expanded])); } catch {}
}
function storedRoot() {
  try { return localStorage.getItem("orca.root") ?? localStorage.getItem("orca.lock"); } catch { return null; }
}

// Nearest existing node, walking up if the path was deleted.
function nodeAt(p) {
  while (p && !byPath.has(p)) p = p.split("/").slice(0, -1).join("/");
  return byPath.get(p) ?? tree;
}

const pathFromHash = () => decodeURIComponent(location.hash.replace(/^#\/?/, ""));
const hashFor = (p) => "#/" + p.split("/").map(encodeURIComponent).join("/");
const within = (p, base) => base === "" || p === base || p.startsWith(base + "/");

// The URL holds the root, and the browser remembers it, so the bare URL opens the last root.
function setRoot(p) {
  location.hash = hashFor(p);
}
function applyRoot() {
  graphRoot = nodeAt(pathFromHash());
  try { localStorage.setItem("orca.root", graphRoot.data.path); } catch {}
  pos.clear();
  centerView(0);
  fitWhenSettled = true;
  render();
  renderRail();
}

const isUnpacked = (d) => d === graphRoot || expanded.has(d.data.path);

function toggle(d) {
  if (expanded.has(d.data.path)) {
    // Packing a node packs everything inside it, and its children forget their places.
    for (const x of d.descendants()) {
      expanded.delete(x.data.path);
      if (x !== d) pos.delete(x.data.path);
    }
  } else expanded.add(d.data.path);
  writeExpanded();
  render();
}

// Unpacks every node between the root and `path`, so its circle is on screen.
function reveal(path) {
  let d = byPath.get(path);
  if (!d) return;
  if (!within(path, graphRoot.data.path)) return setRoot("");
  for (let a = d.parent; a && a !== graphRoot; a = a.parent) expanded.add(a.data.path);
  writeExpanded();
  render();
}

// A session new to the rail unpacks the nodes above it, once, so packing it again sticks.
function revealActive() {
  if (!graphRoot) return;
  const fresh = railSessions().filter((s) => !revealed.has(s.sessionId));
  if (!fresh.length) return;
  for (const s of fresh) {
    revealed.add(s.sessionId);
    for (let a = byPath.get(s.path)?.parent; a && a !== graphRoot; a = a.parent) expanded.add(a.data.path);
  }
  writeExpanded();
  render();
}

// ---- Graph ----

const EASE = d3.easeCubicOut;
const GROW_MS = 420;

// Size follows the number of direct children. A packed parent is larger than an unpacked hub.
const radius = (d) => {
  const c = d.children?.length ?? 0;
  if (d === graphRoot) return 15 + 3 * Math.sqrt(c);
  if (!c) return 10;
  return isUnpacked(d) ? 10 + 3 * Math.sqrt(c) : 13 + 6 * Math.sqrt(c);
};

// Collision covers the circle and the title under it (about 7px per character at 13px), plus a margin.
const space = (n) => Math.max(n.r + 34, n.d.data.title.length * 3.7 + 18);
// Each depth below the root sits on its own ring, so branches take separate sectors instead of interleaving.
const RING = 165;
const sim = d3.forceSimulation()
  .force("link", d3.forceLink().id((n) => n.path).distance((l) => l.source.r + l.target.r + 100).strength(0.4))
  .force("charge", d3.forceManyBody().strength((n) => -380 - n.r * 14).distanceMax(700))
  .force("collide", d3.forceCollide(space).strength(0.9))
  .force("radial", d3.forceRadial((n) => n.depth * RING, 0, 0).strength(0.35))
  .velocityDecay(0.55) // more friction: nodes ease into place instead of overshooting
  .alphaDecay(0.035)
  .on("tick", ticked)
  .on("end", () => {
    if (fitWhenSettled) fitView(600);
    fitWhenSettled = false;
  });

let fitWhenSettled = true; // fit once the first layout settles, and after each root change

// Zooms and pans so every visible node and its title fit between the rail and the panel.
function fitView(duration) {
  const ns = sim.nodes();
  if (!ns.length) return;
  const x0 = d3.min(ns, (n) => n.x - space(n)), x1 = d3.max(ns, (n) => n.x + space(n));
  const y0 = d3.min(ns, (n) => n.y - n.r - 12), y1 = d3.max(ns, (n) => n.y + n.r + 40);
  const left = rail.hidden ? 0 : rail.offsetWidth;
  const right = selected !== null && !panel.hidden ? panel.offsetWidth : 0;
  const w = innerWidth - left - right - 48, h = innerHeight - 120;
  const k = Math.max(0.2, Math.min(1.4, w / (x1 - x0), h / (y1 - y0)));
  const t = d3.zoomIdentity
    .translate(left + 24 + w / 2, 72 + h / 2)
    .scale(k)
    .translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
  center = measure();
  stopGlide();
  (duration ? svg.transition().duration(duration).ease(EASE) : svg).call(zoom.transform, t);
}

// ---- Pan and zoom, with momentum ----

// d3.zoom handles drag-to-pan. Wheel and trackpad input are handled below, so they can be smooth.
const zoom = d3.zoom()
  .scaleExtent([0.2, 3])
  .filter((e) => e.type !== "wheel" && e.type !== "dblclick" && !e.button)
  .on("start", (e) => {
    if (e.sourceEvent) stopGlide();
    samples = [];
  })
  .on("zoom", (e) => {
    gView.attr("transform", e.transform);
    if (e.sourceEvent?.type?.endsWith("move")) samples.push({ t: e.sourceEvent.timeStamp, x: e.transform.x, y: e.transform.y });
  })
  .on("end", (e) => e.sourceEvent && glide());
svg.call(zoom);

let samples = [];  // recent pan positions, to measure release speed
let glider = null; // d3.timer for the coast after a pan
let zoomer = null; // d3.timer that eases toward targetK
let targetK = 1;
let anchor = [0, 0];

function stopGlide() {
  glider?.stop();
  glider = null;
}

// After a drag, keep moving at the release speed and slow down smoothly.
function glide() {
  const recent = samples.filter((p) => samples.at(-1).t - p.t < 80);
  if (recent.length < 2) return;
  const a = recent[0], b = recent.at(-1);
  const dt = b.t - a.t || 1;
  let vx = (b.x - a.x) / dt, vy = (b.y - a.y) / dt; // px per ms
  if (Math.hypot(vx, vy) < 0.05) return;
  let last = 0;
  glider = d3.timer((elapsed) => {
    const step = elapsed - last;
    last = elapsed;
    const decay = Math.exp(-step / 260);
    vx *= decay;
    vy *= decay;
    const k = d3.zoomTransform(svg.node()).k;
    svg.call(zoom.translateBy, (vx * step) / k, (vy * step) / k);
    if (Math.hypot(vx, vy) < 0.01) stopGlide();
  });
}

// Pinch (ctrlKey) and mouse wheels zoom; trackpad scrolling pans, with the system's own momentum.
svg.node().addEventListener("wheel", (e) => {
  e.preventDefault();
  stopGlide();
  const mouseWheel = e.deltaMode !== 0 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 50);
  if (!e.ctrlKey && !mouseWheel) {
    const k = d3.zoomTransform(svg.node()).k;
    return svg.call(zoom.translateBy, -e.deltaX / k, -e.deltaY / k);
  }
  if (!zoomer) targetK = d3.zoomTransform(svg.node()).k;
  targetK = Math.max(0.2, Math.min(3, targetK * Math.pow(2, -e.deltaY * (e.ctrlKey ? 0.012 : 0.0025))));
  anchor = d3.pointer(e, svg.node());
  zoomer ??= d3.timer(() => {
    const k = d3.zoomTransform(svg.node()).k;
    const next = k + (targetK - k) * 0.22;
    svg.call(zoom.scaleTo, next, anchor);
    if (Math.abs(targetK - next) < 0.001) {
      zoomer.stop();
      zoomer = null;
    }
  });
}, { passive: false });

// ---- Nodes ----

// The root and every unpacked node's children; nothing inside a packed node.
function visibleNodes() {
  const out = [];
  const walk = (d) => {
    out.push(d);
    if (isUnpacked(d)) for (const c of d.children ?? []) walk(c);
  };
  walk(graphRoot);
  return out;
}

// Where a new child starts: on an arc around its parent, facing away from the grandparent.
function fanOut(d) {
  const p = pos.get(d.parent.data.path);
  const g = d.parent.parent && pos.get(d.parent.parent.data.path);
  const siblings = d.parent.children;
  const i = siblings.indexOf(d);
  let angle;
  if (!g || d.parent === graphRoot) angle = (i / siblings.length) * 2 * Math.PI - Math.PI / 2;
  else {
    const away = Math.atan2(p.y - g.y, p.x - g.x);
    const spread = Math.min(Math.PI * 1.2, siblings.length * 0.55);
    angle = away + (siblings.length > 1 ? (i / (siblings.length - 1) - 0.5) * spread : 0);
  }
  const dist = radius(d.parent) + radius(d) + 100;
  return { x: p.x + Math.cos(angle) * dist, y: p.y + Math.sin(angle) * dist };
}

function render() {
  if (!graphRoot) return;
  const shown = visibleNodes();
  const nodes = shown.map((d) => {
    let n = pos.get(d.data.path);
    if (!n) {
      n = { path: d.data.path, ...(d.parent && pos.has(d.parent.data.path) ? fanOut(d) : { x: 0, y: 0 }) };
      pos.set(d.data.path, n);
    }
    n.d = d;
    n.r = radius(d);
    n.depth = d.depth - graphRoot.depth;
    // The root is pinned at the centre; everything else moves freely.
    n.fx = n.fy = d === graphRoot ? 0 : null;
    return n;
  });
  const links = shown.filter((d) => d !== graphRoot).map((d) => ({ source: d.parent.data.path, target: d.data.path }));
  sim.nodes(nodes);
  sim.force("link").links(links);
  const key = nodes.map((n) => n.path).join("|");
  if (key !== shownKey) {
    // A gentle nudge: new nodes already start near their place, so the rest barely moves.
    sim.alpha(shownKey ? 0.3 : 1).restart();
    shownKey = key;
  }

  const t = d3.transition().duration(GROW_MS).ease(EASE);
  gLinks.selectAll("line")
    .data(links, (l) => l.target.path)
    .join(
      (enter) => enter.append("line").style("opacity", 0).call((e) => e.transition(t).style("opacity", 1)),
      (update) => update,
      // Packed links shrink into the parent with their nodes.
      (exit) => exit.classed("leaving", true).transition(t)
        .attr("x2", (l) => l.source.x).attr("y2", (l) => l.source.y).style("opacity", 0).remove(),
    );
  gNodes.selectAll("g.node")
    .data(nodes, (n) => n.path)
    .join(
      (enter) => enter.append("g").call(build).style("opacity", 0)
        .call((e) => e.select(".body").attr("transform", "scale(0.25)"))
        .call((e) => e.transition(t).style("opacity", 1).select(".body").attr("transform", "scale(1)")),
      (update) => update,
      // Packed nodes move back into their parent and shrink before they go.
      (exit) => exit.classed("leaving", true).call((x) => x.transition(t)
        .attr("transform", (n) => {
          const p = pos.get(n.path.split("/").slice(0, -1).join("/"));
          return `translate(${p?.x ?? n.x},${p?.y ?? n.y})`;
        })
        .style("opacity", 0)
        .remove()
        .select(".body").attr("transform", "scale(0.25)")),
    )
    .call(fill, t);
  ticked();
  renderCrumbs();
}

function build(g) {
  g.attr("class", "node").each(function () {
    const body = d3.select(this).append("g").attr("class", "body");
    body.append("circle").attr("class", "pulse");
    body.append("circle").attr("class", "halo");
    body.append("circle").attr("class", "rim");
    body.append("circle").attr("class", "inner");
    body.append("text").attr("class", "count").attr("dy", "0.35em");
    body.append("text").attr("class", "title");
    body.append("text").attr("class", "label");
    body.append("g").attr("class", "sessions");
    const info = body.append("g").attr("class", "info");
    info.append("circle").attr("r", 7);
    info.append("text").attr("dy", "0.35em").text("i");
  });
  g.on("click", (e, n) => {
    e.stopPropagation();
    if (!n.d.children || n.d === graphRoot) select(n.path);
    else toggle(n.d);
  });
  g.select(".info").on("click", function (e) {
    e.stopPropagation();
    select(d3.select(this.parentNode.parentNode).datum().path);
  });
  g.call(d3.drag()
    .on("start", (e, n) => {
      if (!e.active) sim.alphaTarget(0.12).restart();
      n.fx = n.x;
      n.fy = n.y;
    })
    .on("drag", (e, n) => {
      n.fx = e.x;
      n.fy = e.y;
    })
    .on("end", (e, n) => {
      if (!e.active) sim.alphaTarget(0);
      if (n.d !== graphRoot) n.fx = n.fy = null;
    }));
}

// A packed node shows the most urgent state of everything it hides; an unpacked one, only its own.
const nodeSessions = (d) => (isUnpacked(d) ? withNode(d) : sessionsIn(d));
const kindOf = (d) => (d === graphRoot ? "is-root" : !d.children ? "leaf" : isUnpacked(d) ? "open" : "packed");

// Sizes animate, so a node grows or shrinks smoothly when it is packed or unpacked.
function fill(sel, t = d3.transition().duration(0)) {
  sel.attr("class", (n) => `node ${kindOf(n.d)} a-${mostUrgent(nodeSessions(n.d))}${n.d.data.archived ? " archived" : ""}${n.path === selected ? " selected" : ""}`);
  sel.select(".halo").transition(t).attr("r", (n) => (n.d === graphRoot ? n.r + 6 : 0));
  sel.select(".rim").transition(t).attr("r", (n) => n.r);
  sel.select(".pulse").transition(t).attr("r", (n) => n.r);
  sel.select(".inner").transition(t).attr("r", (n) => (n.d.children && n.d !== graphRoot ? n.r * 0.6 : 0));
  sel.select(".count").text((n) => (!n.d.children || n.d === graphRoot ? "" : isUnpacked(n.d) ? "–" : `+${n.d.children.length}`));
  sel.select(".title").text((n) => n.d.data.title).transition(t).attr("y", (n) => n.r + (n.d === graphRoot ? 24 : 16));
  sel.select(".label").text((n) => rimText(n.d)).transition(t).attr("y", (n) => n.r + (n.d === graphRoot ? 37 : 29));
  sel.select(".info").style("display", (n) => (n.d.children && n.d !== graphRoot ? null : "none"))
    .transition(t).attr("transform", (n) => `translate(${n.r * Math.SQRT1_2},${-n.r * Math.SQRT1_2})`);
  sel.select(".sessions").each(function (n) { drawDots(d3.select(this), n); });
}

function rimText(d) {
  const states = nodeSessions(d).map(sessionState);
  const count = (st) => states.filter((x) => x === st).length;
  return [
    count("needs") && "needs you",
    count("new") && `${count("new")} new`,
    count("working") && `${count("working")} working`,
    d.data.issues.length && `${d.data.issues.length} to check`,
  ].filter(Boolean).join("  ·  ").toUpperCase();
}

// One dot per session of the node itself, spaced along the lower-left rim.
function drawDots(g, n) {
  g.selectAll("g.dot")
    .data(n.d.data.sessions, (s) => s.sessionId)
    .join((enter) => {
      const dot = enter.append("g");
      dot.append("g").attr("class", "spin").append("circle");
      return dot;
    })
    .attr("class", (s) => `dot ${sessionState(s)}`)
    .attr("transform", (_, i) => `rotate(${135 + i * 18})`)
    .select("circle")
    .attr("cx", n.r)
    .attr("r", (s) => (["needs", "new"].includes(sessionState(s)) ? 4.5 : 3));
}

function ticked() {
  gNodes.selectAll("g.node:not(.leaving)").attr("transform", (n) => `translate(${n.x},${n.y})`);
  gLinks.selectAll("line:not(.leaving)")
    .attr("x1", (l) => l.source.x).attr("y1", (l) => l.source.y)
    .attr("x2", (l) => l.target.x).attr("y2", (l) => l.target.y);
}

// The free space between the rail and the panel.
function measure() {
  const left = rail.hidden ? 0 : rail.offsetWidth;
  const right = selected !== null && !panel.hidden ? panel.offsetWidth : 0;
  return { cx: left + (innerWidth - left - right) / 2, cy: innerHeight / 2 + 20 };
}

// Puts the root at the centre of the free space, keeping the zoom level.
function centerView(duration) {
  center = measure();
  const k = d3.zoomTransform(svg.node()).k;
  const t = d3.zoomIdentity.translate(center.cx, center.cy).scale(k);
  (duration ? svg.transition().duration(duration) : svg).call(zoom.transform, t);
}

// When the rail or the panel opens or closes, shift the view by the change in free space.
function relayout(duration) {
  termview.style.left = `${rail.hidden ? 0 : rail.offsetWidth}px`;
  const next = measure();
  const k = d3.zoomTransform(svg.node()).k;
  const dx = (next.cx - center.cx) / k;
  const dy = (next.cy - center.cy) / k;
  center = next;
  if (dx || dy) (duration ? svg.transition().duration(duration) : svg).call(zoom.translateBy, dx, dy);
}

// ---- Rail: every session under the root, most urgent first ----

// Queue workers stay off the rail unless they are blocked on you.
const railSessions = () => sessionsIn(graphRoot).filter((s) => !s.background || sessionState(s) === "needs");

function renderRail() {
  if (!graphRoot) return;
  const sessions = railSessions().sort(
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
  const s = sessionsIn(tree).find((x) => x.sessionId === row.dataset.sid);
  if (!s || !byPath.has(row.dataset.path)) return;
  // In terminal mode, switch terminals without touching the map.
  if (term && s.tmux) return openTerminal(s.tmux, s.path, s.host);
  reveal(s.path);
  await select(s.path);
  if (s.tmux) openTerminal(s.tmux, s.path, s.host);
  else markSeen([s]);
});

// The trail from the top of the tree to the root. Click a step to make it the root.
function renderCrumbs() {
  crumbs.replaceChildren();
  graphRoot.ancestors().reverse().forEach((d, i, all) => {
    if (i) crumbs.append(Object.assign(document.createElement("span"), { className: "sep", textContent: "/" }));
    const here = i === all.length - 1;
    const el = document.createElement(here ? "span" : "a");
    el.textContent = d.data.title;
    if (here) el.className = "here";
    else el.href = hashFor(d.data.path);
    crumbs.append(el);
  });
}

// ---- Panel ----

async function select(p) {
  editing = false;
  selected = p;
  gNodes.selectAll("g.node").classed("selected", (n) => n.path === selected);
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
      <button data-form="queue" type="button">Queue</button>
      ${n.path ? `<button data-form="move" type="button">Move</button><button data-archive="${n.archived ? "" : "1"}" type="button">${n.archived ? "Unarchive" : "Archive"}</button><button data-form="remove" type="button">Delete</button>` : ""}
      ${byPath.get(n.path)?.children && n.path !== graphRoot.data.path ? `<button data-root="${esc(n.path)}" type="button">Set as root</button>` : ""}
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
  const s = sessionsIn(tree).find((x) => x.sessionId === id);
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
  queue: (n) => `
    ${field(`Tasks for ${esc(n.title)}, one per line`, `<textarea name="tasks" rows="6" required placeholder="Each line becomes a background worker. Orca merges its work and checks it off in the ## Queue section."></textarea>`)}
    <div class="row"><button type="submit">Queue</button><button class="cancel" type="button">Cancel</button><span class="hint">⌘↵</span></div>`,
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
      if (n.path !== graphRoot.data.path) expanded.add(n.path); // unpack the parent so the new child shows
      writeExpanded();
    } else if (kind === "queue") {
      for (const task of v.tasks.split("\n").filter((t) => t.trim())) await post("queue", { path: n.path, task });
    } else if (kind === "move") {
      const to = (await post("move", { from: n.path, to: v.to.replace(/^\/+|\/+$/g, "") })).path;
      expanded = new Set([...expanded].map((p) => rebase(p, n.path, to)));
      writeExpanded();
      selected = to;
      if (within(graphRoot.data.path, n.path)) setRoot(rebase(graphRoot.data.path, n.path, to));
      else reveal(to);
    } else if (kind === "remove") {
      await post("remove", { path: n.path });
      closePanel();
      const parent = n.path.split("/").slice(0, -1).join("/");
      if (within(graphRoot.data.path, n.path)) setRoot(parent);
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
    reveal(d.path);
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
async function openTerminal(name, path = selected ?? graphRoot.data.path, host = undefined) {
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
  markSeen(sessionsIn(tree).filter((s) => isOpen(s)));
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
  if (byPath.has(path) && toSession) {
    reveal(path);
    select(path);
  }
  relayout(0);
}

function toggleTerminal() {
  if (term) return closeTerminal();
  if (lastTerm && sessionsIn(tree).some((s) => isOpen(s, lastTerm))) openTerminal(lastTerm.name, lastTerm.path, lastTerm.host);
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
  const archive = e.target.closest("[data-archive]");
  if (archive) setArchived(selected, !!archive.dataset.archive);
  const rootButton = e.target.closest("[data-root]");
  if (rootButton) setRoot(rootButton.dataset.root);
  const copy = e.target.closest(".copy");
  if (copy) navigator.clipboard.writeText(panelFile).then(() => (copy.textContent = "Copied"));
});

// ---- Wiring ----

document.getElementById("about").addEventListener("click", () => graphRoot && select(graphRoot.data.path));
// Header forms act on the root of the graph.
async function openFocusForm(kind) {
  if (!graphRoot) return;
  await select(graphRoot.data.path);
  openForm(kind);
}
document.getElementById("new").addEventListener("click", () => openFocusForm("child"));
document.getElementById("dispatch").addEventListener("click", () => openFocusForm("dispatch"));
svg.on("click", () => selected !== null && closePanel());
addEventListener("hashchange", () => {
  if (!tree) return;
  if (term) closeTerminal(false); // a breadcrumb click in terminal mode goes where it points
  applyRoot();
});
document.getElementById("mapbtn").addEventListener("click", () => term && closeTerminal());
addEventListener("resize", () => relayout(0));
addEventListener("keydown", (e) => {
  if (e.key === "." && e.metaKey) {
    e.preventDefault();
    return toggleTerminal();
  }
  if (e.key === "Escape" && term) return closeTerminal(); // terminal not focused
  const typing = e.target.closest?.("input, textarea, select, .xterm");
  if (e.key === "f" && !typing && !term && !e.metaKey && !e.ctrlKey) return fitView(500);
  if (e.key === "/" && !typing && !term) {
    e.preventDefault();
    return openFocusForm("dispatch");
  }
  if (e.key !== "Escape" || term) return;
  if (editing) return closeForm();
  if (selected !== null) closePanel();
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

// The bare URL opens the last root.
if (!location.hash && storedRoot() !== null) history.replaceState(null, "", hashFor(storedRoot()));
centerView(0);
load();
setInterval(load, POLL_MS);
loadUsage();
setInterval(loadUsage, 60_000);
