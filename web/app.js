const POLL_MS = 5000;
// A node's state comes from its sessions, most urgent first. A packed node also counts what it hides.
const STATES = ["needs", "new", "working", "ready", "idle"];
const STATE_LABEL = { needs: "needs you", new: "new result", working: "working", ready: "seen", idle: "idle" };
const STATE_MARK = { needs: "◆", new: "◉", working: "●", ready: "○", idle: "·" };

const svg = d3.select("#map");
const gView = svg.append("g");                       // pan and zoom apply here
const gLinks = gView.append("g").attr("class", "links");
const gFlow = gView.append("g").attr("class", "flow");     // dots running down links to sessions
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
let editing = false;  // a form or document is open in the panel; polling must not redraw it
const rail = document.getElementById("rail");
let seen = {}; // sessionId -> finishedAt of the last result you looked at; the server keeps it for every device
let seenText = "";
let parked = {}; // sessionId -> when you parked it; the server keeps it for every device
let parkedText = "";
let jobs = []; // dispatches still being placed, or failed: [{ id, prompt, host, startedAt, error }]
const revealed = new Set(); // sessionIds whose node has been unpacked onto the map once
let showArchived = readFlag("orca.showArchived");
let obsidian = null; // { vault, folder } once the user opts in to copying documents there
let idleMinutes = 30; // children quiet for longer than this share one "others" node
let motion = !readFlag("orca.still"); // starfield and link flow on the map
document.body.classList.toggle("still", !motion);
// Map motion knobs, as multiples of the defaults. Saved in this browser.
const knobs = {};
const readKnobs = () => {
  Object.assign(knobs, { density: 1, parallax: 1, flow: 1, orbit: 1 });
  try { Object.assign(knobs, JSON.parse(localStorage.getItem("orca.motionKnobs"))); } catch {}
};
readKnobs();
document.body.style.setProperty("--flow-speed", knobs.flow);
try { idleMinutes = Number(localStorage.getItem("orca.idleMinutes")) || 30; } catch {}
const opened = new Set(); // parents whose "others" node was clicked; packing the parent groups them again
const archivedButton = document.getElementById("archived");
archivedButton.classList.toggle("on", showArchived);

// ---- Data ----

async function load() {
  fetch("/api/workers").then((r) => r.json()).then((w) => (workerList = w)).catch(() => {});
  const [res, seenRes, jobsRes, parkedRes] = await Promise.all([fetch("/api/tree"), fetch("/api/seen"), fetch("/api/dispatches"), fetch("/api/parked")]);
  jobs = await jobsRes.json();
  const text = await res.text();
  if (!res.ok) return (crumbs.textContent = JSON.parse(text).error);
  const nextParked = await parkedRes.text();
  const nextSeen = await seenRes.text();
  if (nextSeen !== seenText || nextParked !== parkedText) {
    parkedText = nextParked;
    parked = JSON.parse(nextParked);
    seenText = nextSeen;
    seen = JSON.parse(nextSeen);
    panelText = ""; // another device may have marked a session in the open panel
    if (tree) render();
  }
  if (text !== treeText) {
    treeText = text;
    tree = d3.hierarchy(JSON.parse(text), shownChildren).sort((a, b) => a.data.path.localeCompare(b.data.path));
    byPath = new Map(tree.descendants().map((d) => [d.data.path, d]));
    graphRoot = nodeAt(pathFromHash());
    render();
  }
  // Nodes go idle without any change to the data, so check whether the grouping moved.
  else if (graphRoot && visibleNodes().map((d) => d.data.path).join("|") !== shownKey) render();
  if (term) markSeen(sessionsIn(tree).filter((s) => isOpen(s)));
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

function markSeen(sessions) {
  const fresh = sessions.filter(isNew);
  if (!fresh.length) return;
  const marks = Object.fromEntries(fresh.map((s) => [s.sessionId, s.finishedAt]));
  Object.assign(seen, marks);
  post("seen", { seen: marks }).catch(() => {});
  renderRail();
  render();
  // The panel only redraws when server data changes, and "seen" is not part of it, so force it.
  panelText = "";
  if (selected !== null) refreshPanel();
}

// A finished turn you have not opened since it finished.
const isNew = (s) => s.state === "ready" && !!s.finishedAt && s.finishedAt > (seen[s.sessionId] ?? "");
// A parked session stays parked until it acts again. It reads as idle everywhere, so it does not call for you.
const isParked = (s) => !!parked[s.sessionId] && s.updatedAt <= parked[s.sessionId];
const sessionState = (s) => (isParked(s) ? "idle" : s.state === "needs-input" ? "needs" : isNew(s) ? "new" : s.state);
const withNode = (x) => x.data.sessions.map((s) => ({ ...s, path: x.data.path, title: x.data.title, background: x.data.background, parent: x.data.parent }));
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
      opened.delete(x.data.path);
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
    if (e.sourceEvent) stopGlide(), stopZoomer();
    samples = [];
  })
  .on("zoom", (e) => {
    gView.attr("transform", e.transform);
    panStars(e.transform);
    if (e.sourceEvent?.type?.endsWith("move")) samples.push({ t: e.sourceEvent.timeStamp, x: e.transform.x, y: e.transform.y });
  })
  .on("end", (e) => e.sourceEvent && glide());
svg.call(zoom);

// ---- Starfield ----

// Two layers of stars behind the map. Each repeats every TILE px and pans at a fraction of the map's speed, for depth.
const TILE = 512;
const gStars = svg.insert("g", ":first-child").attr("class", "stars");
const starLayers = [
  { name: "far", speed: 0.08, count: 40, size: [0.5, 1] },
  { name: "near", speed: 0.2, count: 12, size: [0.9, 1.6] },
].map((l) => ({
  ...l,
  g: gStars.append("g").attr("class", l.name),
  tile: d3.range(l.count * 3).map(() => ({ x: Math.random() * TILE, y: Math.random() * TILE, r: l.size[0] + Math.random() * (l.size[1] - l.size[0]) })),
}));

function drawStars() {
  const tiles = d3.cross(d3.range(Math.ceil(innerWidth / TILE) + 1), d3.range(Math.ceil(innerHeight / TILE) + 1));
  for (const l of starLayers) {
    l.g.selectAll("circle")
      .data(tiles.flatMap(([i, j]) => l.tile.slice(0, Math.round(l.count * knobs.density)).map((s) => ({ ...s, x: s.x + i * TILE, y: s.y + j * TILE }))))
      .join("circle")
      .attr("cx", (s) => s.x).attr("cy", (s) => s.y).attr("r", (s) => s.r)
      // About a third twinkle, each on its own clock.
      .classed("tw", () => Math.random() < 0.3)
      .style("animation-duration", () => `${3 + Math.random() * 5}s`)
      .style("animation-delay", () => `${-Math.random() * 8}s`);
  }
  panStars(d3.zoomTransform(svg.node()));
}

function panStars(t) {
  for (const l of starLayers) {
    const off = (v) => ((((v * l.speed * knobs.parallax) % TILE) + TILE) % TILE) - TILE;
    l.g.attr("transform", `translate(${off(t.x)},${off(t.y)})`);
  }
}
drawStars();
addEventListener("resize", drawStars);

// ---- Orbit ----

// The subtree of the open node nearest the view centre turns slowly around it: one turn in ORBIT_S seconds at 1x.
// It holds still while a button is down or the pointer is on a node, so clicks and drags land where you aim.
const ORBIT_S = 600;
const calm = matchMedia("(prefers-reduced-motion: reduce)");
let pivot = null; // re-picked after each pan or zoom and each render
let held = false, onNode = false;
addEventListener("pointerdown", () => (held = true));
addEventListener("pointerup", () => (held = false));
svg.on("pointerover.orbit", (e) => (onNode = !!e.target.closest("g.node")));
zoom.on("end.orbit", () => (pivot = null));

function pickPivot() {
  const t = d3.zoomTransform(svg.node());
  const [x, y] = t.invert([center.cx, center.cy]);
  return d3.least(sim.nodes().filter((n) => n.d.children && isUnpacked(n.d)), (n) => (n.x - x) ** 2 + (n.y - y) ** 2);
}

let last = 0;
d3.timer((now) => {
  const dt = Math.min(now - last, 100) / 1000;
  last = now;
  if (!motion || !knobs.orbit || calm.matches || held || onNode) return;
  pivot ??= pickPivot();
  if (!pivot) return;
  const a = (2 * Math.PI * knobs.orbit * dt) / ORBIT_S, cos = Math.cos(a), sin = Math.sin(a);
  for (const n of sim.nodes()) {
    if (n === pivot || n.fx != null || !n.d.ancestors().includes(pivot.d)) continue;
    const dx = n.x - pivot.x, dy = n.y - pivot.y;
    n.x = pivot.x + dx * cos - dy * sin;
    n.y = pivot.y + dx * sin + dy * cos;
  }
  ticked();
});

let samples = [];  // recent pan positions, to measure release speed
let glider = null; // d3.timer for the coast after a pan
let zoomer = null; // d3.timer that eases toward targetK
let targetK = 1;
let anchor = [0, 0];

function stopGlide() {
  glider?.stop();
  glider = null;
}
function stopZoomer() {
  zoomer?.stop();
  zoomer = null;
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

// Vertical scroll and pinch zoom; sideways scroll pans. Drag the background to pan freely.
svg.node().addEventListener("wheel", (e) => {
  e.preventDefault();
  stopGlide();
  svg.interrupt(); // a running fit or pan animation would fight the zoom
  const k = d3.zoomTransform(svg.node()).k;
  if (!e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) return svg.call(zoom.translateBy, -e.deltaX / k, 0);
  anchor = d3.pointer(e, svg.node());
  // A pinch arrives as many small, smooth steps, so it applies directly.
  if (e.ctrlKey) {
    stopZoomer();
    return svg.call(zoom.scaleTo, k * Math.pow(2, -e.deltaY * 0.012), anchor);
  }
  // Scrolling, especially a mouse wheel, comes in coarse steps, so it eases toward a target.
  if (!zoomer) targetK = k;
  targetK = Math.max(0.2, Math.min(3, targetK * Math.pow(2, -e.deltaY * 0.0025)));
  zoomer ??= d3.timer(() => {
    const now = d3.zoomTransform(svg.node()).k;
    const next = now + (targetK - now) * 0.22;
    svg.call(zoom.scaleTo, next, anchor);
    if (Math.abs(targetK - next) < 0.001) stopZoomer();
  });
}, { passive: false });

// ---- Nodes ----

// The root and every unpacked node's children; nothing inside a packed node.
// Idle children of a parent collapse into one "others" node, unless that has been clicked.
function visibleNodes() {
  const out = [];
  const walk = (d) => {
    out.push(d);
    if (!isUnpacked(d) || !d.children) return;
    const idle = opened.has(d.data.path) ? [] : d.children.filter((c) => !isHot(c));
    if (idle.length < 2) return d.children.forEach(walk);
    d.children.filter((c) => !idle.includes(c)).forEach(walk);
    out.push(othersOf(d, idle));
  };
  walk(graphRoot);
  return out;
}

// A node stays on the map while it is selected, or anything inside it needs you, is working,
// has an unseen result, or had a message within the last idleMinutes.
function isHot(d) {
  if (selected !== null && within(selected, d.data.path)) return true;
  const since = new Date(Date.now() - idleMinutes * 60000).toISOString();
  return d.descendants().some((x) => (x.data.lastActive ?? "") > since
    || x.data.sessions.some((s) => s.updatedAt > since || ["needs", "new", "working"].includes(sessionState(s))));
}

// A stand-in for a parent's idle children. It draws like a leaf; clicking it shows them.
const othersOf = (d, idle) => ({
  others: idle,
  parent: d,
  depth: d.depth + 1,
  data: { path: `${d.data.path}/…`, title: `${idle.length} others`, sessions: [], issues: [] },
  descendants: () => idle.flatMap((c) => c.descendants()),
});

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
    pivot = null;
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
  gFlow.selectAll("line")
    .data(links.filter((l) => sessionsIn(l.target.d).length), (l) => l.target.path)
    .join("line")
    .attr("class", (l) => mostUrgent(sessionsIn(l.target.d)));
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
    const add = body.append("g").attr("class", "add");
    add.append("circle").attr("r", 7);
    add.append("text").attr("dy", "0.35em").text("+");
  });
  g.on("click", (e, n) => {
    e.stopPropagation();
    if (n.d.others) opened.add(n.d.parent.data.path), render();
    else if (!n.d.children || n.d === graphRoot) select(n.path);
    else toggle(n.d);
  });
  g.select(".info").on("click", function (e) {
    e.stopPropagation();
    select(d3.select(this.parentNode.parentNode).datum().path);
  });
  g.select(".add").on("click", function (e) {
    e.stopPropagation();
    openQuickAdd(d3.select(this.parentNode.parentNode).datum());
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
  sel.attr("class", (n) => `node ${kindOf(n.d)} a-${mostUrgent(nodeSessions(n.d))}${n.d.data.archived ? " archived" : ""}${n.d.others ? " others" : ""}${n.path === selected ? " selected" : ""}`);
  sel.select(".halo").transition(t).attr("r", (n) => (n.d === graphRoot ? n.r + 6 : 0));
  sel.select(".rim").transition(t).attr("r", (n) => n.r);
  sel.select(".pulse").transition(t).attr("r", (n) => n.r);
  sel.select(".inner").transition(t).attr("r", (n) => (n.d.children && n.d !== graphRoot ? n.r * 0.6 : 0));
  sel.select(".count").text((n) => (!n.d.children || n.d === graphRoot ? "" : isUnpacked(n.d) ? "–" : `+${n.d.children.length}`));
  sel.select(".title").text((n) => n.d.data.title).transition(t).attr("y", (n) => n.r + (n.d === graphRoot ? 24 : 16));
  sel.select(".label").text((n) => rimText(n.d)).transition(t).attr("y", (n) => n.r + (n.d === graphRoot ? 37 : 29));
  sel.select(".info").style("display", (n) => (n.d.children && n.d !== graphRoot ? null : "none"))
    .transition(t).attr("transform", (n) => `translate(${n.r * Math.SQRT1_2},${-n.r * Math.SQRT1_2})`);
  sel.select(".add").style("display", (n) => (n.d.others ? "none" : null))
    .transition(t).attr("transform", (n) => `translate(${n.r * Math.SQRT1_2},${n.r * Math.SQRT1_2})`);
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
  gFlow.selectAll("line")
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

// Queue workers stay off the rail unless they are blocked on you. A dispatched child stays off while
// a session runs on its parent node, which answers it; once the parent is gone, the child comes back.
const parentLive = (s) => !!byPath.get(s.parent)?.data.sessions.length;
const railSessions = () => sessionsIn(graphRoot).filter((s) => !(s.parent && parentLive(s)) && (!s.background || sessionState(s) === "needs"));

// A parent waits on its children in the background, so on its own it reads as finished.
// The rail counts it as working while a child works, and as needing you when a child has asked
// for over a minute and the parent has not picked it up.
function railState(s) {
  const own = sessionState(s);
  if (own === "working" || own === "needs" || isParked(s)) return own;
  const kids = childSessions(s);
  const stale = new Date(Date.now() - 60000).toISOString();
  if (kids.some((c) => railState(c) === "needs" && c.updatedAt < stale)) return "needs";
  if (kids.some((c) => ["working", "needs"].includes(railState(c)))) return "working";
  return own;
}

function renderRail() {
  if (!graphRoot) return;
  const sessions = railSessions().sort(
    (a, b) => STATES.indexOf(railState(a)) - STATES.indexOf(railState(b)) || b.updatedAt.localeCompare(a.updatedAt),
  );
  const attention = sessions.filter((s) => ["needs", "new"].includes(railState(s))).length;
  // The open session leads the tab title, so the browser and OS switchers show it too.
  const here = term && byPath.get(term.path)?.data.title;
  document.title = `${attention ? `(${attention}) ` : ""}${here ? `${here} · ` : ""}Orca`;
  // Your last prompt under the terminal's title; hover it for the latest status.
  const open = term && sessionsIn(graphRoot).find((s) => isOpen(s));
  const prompt = termview.querySelector(".prompt");
  prompt.textContent = open?.prompt ?? "";
  prompt.title = open?.summary ?? "";

  const wasHidden = rail.hidden;
  rail.hidden = !sessions.length && !jobs.length;
  // Working sessions get their own section at the top; the rest stay most urgent first.
  // Dispatches still being placed sit at the top of Working.
  const groups = { working: jobs.map(jobRow), rest: [], parked: [] };
  for (const s of sessions) groups[isParked(s) ? "parked" : railState(s) === "working" ? "working" : "rest"].push(railRow(s));
  for (const [name, list] of Object.entries(groups)) {
    const section = rail.querySelector(`[data-group="${name}"]`);
    section.hidden = !list.length;
    section.querySelector("ol").innerHTML = list.join("");
  }
  const parkedSection = rail.querySelector('[data-group="parked"]');
  parkedSection.classList.toggle("folded", !parkedOpen);
  parkedSection.querySelector(".fold").textContent = `Parked · ${groups.parked.length}`;
  if (wasHidden !== rail.hidden) relayout(300);
}

function railRow(s) {
  const st = railState(s);
  const label = st === sessionState(s) ? STATE_LABEL[st] : st === "working" ? "child working" : "child asks";
  const park = isParked(s)
    ? `<button type="button" class="end park" data-park="${esc(s.sessionId)}" title="Back to the rail">Unpark</button>`
    : `<button type="button" class="end park" data-park="${esc(s.sessionId)}" data-on="1" title="Move to Parked until it acts again">Park</button>`;
  return `<li>${park}<button type="button" class="end" data-end="${esc(s.sessionId)}" data-state="${st}" title="End this session">End</button><button type="button" class="a-${st}${isOpen(s) ? " open" : ""}" data-path="${esc(s.path)}" data-sid="${esc(s.sessionId)}">
    <span class="line"><span class="mark">${STATE_MARK[st]}</span><span class="name">${esc(s.title)}</span><span class="st">${label}</span></span>
    ${s.prompt ? `<span class="sum you"${s.summary ? ` title="${esc(s.summary)}"` : ""}>${esc(s.prompt)}</span>` : ""}
    <span class="meta">${s.host ? `${esc(s.host)} · ` : ""}${esc(s.path || "/")} · ${ago(s.updatedAt)}</span>
  </button>${drawer(s)}</li>`;
}

// Sessions that a parent node started. They stay off the rail; the parent's row lists them in a drawer.
const childSessions = (s) => sessionsIn(tree).filter((c) => c.parent === s.path);
let openDrawers = readSet("orca.drawers"); // parent paths whose drawer is unfolded

function drawer(s) {
  const kids = childSessions(s);
  if (!kids.length) return "";
  const working = kids.filter((c) => sessionState(c) === "working").length;
  const asking = kids.filter((c) => sessionState(c) === "needs").length;
  const tally = [`${kids.length} ${kids.length === 1 ? "child" : "children"}`, working && `${working} working`, asking && `${asking} asking`].filter(Boolean).join(" · ");
  const open = openDrawers.has(s.path);
  return `<div class="drawer${open ? " open" : ""}"><button type="button" class="drawer-head" data-drawer="${esc(s.path)}">${open ? "▾" : "▸"} ${tally}</button>
    ${open ? `<ol>${kids.map(childRow).join("")}</ol>` : ""}</div>`;
}

function childRow(c) {
  const st = railState(c);
  const label = st === "needs" ? "asks parent" : STATE_LABEL[st];
  return `<li><button type="button" class="a-${st}${isOpen(c) ? " open" : ""}" data-child="${esc(c.sessionId)}">
    <span class="line"><span class="mark">${STATE_MARK[st]}</span><span class="name">${esc(c.title)}</span><span class="st">${label}</span></span>
    ${c.summary || c.prompt ? `<span class="sum">${esc(c.summary || c.prompt)}</span>` : ""}
    <span class="meta">${esc(c.path)} · ${ago(c.updatedAt)}</span>
  </button>${drawer(c)}</li>`;
}

function jobRow(j) {
  const st = j.error ? "failed" : j.choices ? "choose" : "placing";
  const label = { failed: "failed · retry", choose: "where?", placing: "placing" }[st];
  return `<li><button type="button" class="end" data-dismiss="${esc(j.id)}" title="Dismiss">Dismiss</button><button type="button" class="a-${st}"${j.error ? ` data-retry="${esc(j.id)}" title="Retry"` : ""}>
    <span class="line"><span class="mark">${j.error ? "!" : j.choices ? "?" : "…"}</span><span class="name">${esc(j.prompt.trim().split("\n")[0])}</span><span class="st">${label}</span></span>
    ${j.error ? `<span class="sum">${esc(j.error)}</span>` : ""}
    <span class="meta">${j.host ? `${esc(j.host)} · ` : ""}${ago(j.startedAt)}</span>
  </button>${(j.choices ?? []).map((c, i) => `<button type="button" class="choice" data-choose="${esc(j.id)}" data-index="${i}" title="File it here">
    <span class="line"><span class="mark">${i + 1}</span><span class="name">${esc(c.title)}</span></span>
    <span class="meta">${esc(c.path || "/")}</span>
  </button>`).join("")}</li>`;
}

rail.addEventListener("click", async (e) => {
  const job = e.target.closest("[data-retry], [data-dismiss], [data-choose]");
  if (job) {
    const { retry, dismiss, choose, index } = job.dataset;
    if (choose) await post("choose", { id: choose, index: Number(index) }).catch(() => {});
    else await post(retry ? "retry" : "dismiss", { id: retry ?? dismiss }).catch(() => {});
    return load();
  }
  const endButton = e.target.closest("[data-end]");
  if (endButton) return endSession(endButton);
  const head = e.target.closest("[data-drawer]");
  if (head) {
    const p = head.dataset.drawer;
    openDrawers.has(p) ? openDrawers.delete(p) : openDrawers.add(p);
    try { localStorage.setItem("orca.drawers", JSON.stringify([...openDrawers])); } catch {}
    return renderRail();
  }
  const child = e.target.closest("[data-child]");
  if (child) {
    const c = sessionsIn(tree).find((x) => x.sessionId === child.dataset.child);
    if (c?.tmux) openTerminal(c.tmux, c.path, c.host, true);
    return;
  }
  const park = e.target.closest("[data-park]");
  if (park) {
    await post("park", { session: park.dataset.park, park: !!park.dataset.on }).catch(() => {});
    return load();
  }
  if (e.target.closest(".fold")) {
    parkedOpen = !parkedOpen;
    try { localStorage.setItem("orca.parkedOpen", parkedOpen ? "1" : "0"); } catch {}
    return renderRail();
  }
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

let parkedOpen = readFlag("orca.parkedOpen"); // Parked starts folded

// The current rail row is the open terminal's, or else the selected node's.
// ⌥Tab steps through the sessions that wait on you: not Working, not Parked.
const railRows = () => [...rail.querySelectorAll('[data-group="rest"] button[data-sid]')];
const isCurrent = (r) => (term ? r.classList.contains("open") : r.dataset.path === selected);

// ⌥Tab and ⌥⇧Tab step down and up the Sessions group in its shown order, wrapping, as a click would.
function stepRail(back) {
  const rows = railRows();
  if (!rows.length) return;
  const at = rows.findIndex(isCurrent);
  const next = at < 0 ? (back ? rows.length - 1 : 0) : (at + (back ? -1 : 1) + rows.length) % rows.length;
  rows[next].click();
}

// The trail from the top of the tree to the root. Click a step to make it the root.
// The tree's own root has no crumb: the logo links back to it.
function renderCrumbs() {
  crumbs.replaceChildren();
  graphRoot.ancestors().reverse().slice(1).forEach((d, i, all) => {
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
  panel.hidden = false;
  center = measure(); // the panel overlays the map; it does not shift it
  keepClear(p);
}

// Pans just far enough that the node at `p` and its title are not under the panel.
function keepClear(p) {
  const n = sim.nodes().find((x) => x.path === p);
  if (!n) return;
  const t = d3.zoomTransform(svg.node());
  const overlap = t.applyX(n.x) + space(n) * t.k + 24 - (innerWidth - panel.offsetWidth);
  if (overlap > 0) svg.transition().duration(300).ease(EASE).call(zoom.translateBy, -overlap / t.k, 0);
}

function closePanel() {
  editing = false;
  selected = null;
  panel.hidden = true;
  gNodes.selectAll("g.node").classed("selected", false);
  center = measure();
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
  // Polling redraws the panel as jobs move; keep a half-typed job.
  const draft = panel.querySelector(".qadd input");
  const typed = draft && { value: draft.value, focused: document.activeElement === draft };
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
      <button class="finder" type="button">Docs folder</button>
      ${n.path ? `<button data-form="move" type="button">Move</button><button data-archive="${n.archived ? "" : "1"}" type="button">${n.archived ? "Unarchive" : "Archive"}</button><button data-form="remove" type="button">Delete</button>` : ""}
      ${byPath.get(n.path)?.children && n.path !== graphRoot.data.path ? `<button data-root="${esc(n.path)}" type="button">Set as root</button>` : ""}
    </div>
    <form class="form" hidden></form>
    ${renderSessions(n.sessions)}
    ${renderQueue(n.queue)}
    ${renderDocs(n.docs)}
    ${n.issues.length ? `<ul class="issues">${n.issues.map((i) => `<li>${esc(i.level)}: ${esc(i.message)}</li>`).join("")}</ul>` : ""}
    <div class="md">${n.html}</div>`;
  // The goal shows under the title and the queue has its own section; drop their body sections.
  for (const h of [...panel.querySelectorAll(".md h2")].filter((el) => ["goal", "queue"].includes(el.textContent.trim().toLowerCase()))) {
    while (h.nextElementSibling && !/^H[1-6]$/.test(h.nextElementSibling.tagName)) h.nextElementSibling.remove();
    h.remove();
  }
  if (typed) {
    const input = panel.querySelector(".qadd input");
    input.value = typed.value;
    if (typed.focused) input.focus();
  }
}

// The node's ## Queue checklist as jobs: each line's mark is its state.
const JOB = { " ": ["waiting", "○"], ">": ["running", "●"], x: ["done", "✓"], "!": ["failed", "!"] };

function renderQueue(items) {
  const count = (st) => items.filter((i) => JOB[i.mark][0] === st).length;
  const tally = ["running", "waiting", "failed"].map((st) => count(st) && `${count(st)} ${st}`).filter(Boolean).join(" · ");
  const rows = items.map((i) => {
    const [st, mark] = JOB[i.mark];
    return `<li class="j-${st}">
      <span class="mark">${mark}</span>
      <span class="text">${esc(i.text)}${i.note ? `<span class="note">${esc(i.note)}</span>` : ""}</span>
      <span class="st">${st}</span>
      ${i.child ? `<button class="child" type="button" data-reveal="${esc(i.child)}" title="${esc(i.child)}">${esc(i.child.split("/").pop())}</button>` : ""}
    </li>`;
  });
  return `<section class="queue">
    <div class="sec-head"><span>Queue${tally ? ` · ${tally}` : ""}</span></div>
    ${rows.length ? `<ol>${rows.join("")}</ol>` : ""}
    <form class="qadd"><input name="task" placeholder="Add a job. A background worker picks it up." autocomplete="off" required><button type="submit">Add</button></form>
  </section>`;
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

function renderDocs(docs) {
  if (!docs.length) return "";
  const items = docs.map((d) => `<li><button class="doc" type="button" data-doc="${esc(d.file)}">${esc(d.name)}</button><time>${ago(d.modified)}</time></li>`);
  return `<section class="docs"><div class="sec-head"><span>Docs</span></div><ul>${items.join("")}</ul></section>`;
}

// Shows a document in place of the node's details, until Back.
async function readInPanel(file) {
  editing = true;
  const d = await fetchDoc(file);
  panel.innerHTML = `
    <div class="top"><button class="back" type="button">← ${esc(panelNode.title)}</button><span>${obsidian ? `<button type="button" data-copyobs="${esc(d.path)}">Copy to Obsidian</button> ` : ""}<button class="popout" type="button" data-popout="${esc(d.path)}">Open in app</button> <button class="close" type="button">Close</button></span></div>
    <p class="kicker">${esc(d.path)}</p>
    <div class="md">${d.html}</div>`;
  panel.scrollTop = 0;
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
  return end(id);
}

async function end(id) {
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
    ${field("Title", `<input name="title" placeholder="Data pipeline" required>`)}
    ${field("Folder", `<input name="name" pattern="[^/.][^/]*" placeholder="From the title">`)}
    ${field("Goal", `<textarea name="goal" rows="2"></textarea>`)}
    <div class="row"><button type="submit">Create</button><button class="cancel" type="button">Cancel</button></div>`,
  move: (n) => `
    ${field("New path", `<input name="to" value="${esc(n.path)}" required>`)}
    <p class="hint">Change the last part to rename. Change the rest to move it under another node.</p>
    <div class="row"><button type="submit">Move</button><button class="cancel" type="button">Cancel</button></div>`,
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
  try {
    if (kind === "edit") {
      await post("update", { path: n.path, ...v });
    } else if (kind === "child") {
      const name = v.name || slug(v.title);
      const path = n.path ? `${n.path}/${name}` : name;
      await post("create", { path, title: v.title, goal: v.goal });
      if (n.path !== graphRoot.data.path) expanded.add(n.path); // unpack the parent so the new child shows
      writeExpanded();
      selected = path; // a new node is idle; selecting it keeps it out of "N others"
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

// "Data pipeline" -> "data-pipeline"
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// ---- Quick add: the "+" on a node asks for a title and creates a child under it ----

const quickAdd = document.createElement("form");
quickAdd.id = "quickadd";
quickAdd.hidden = true;
quickAdd.innerHTML = `<span>New child · ↵</span><input placeholder="Title" autocomplete="off" required>`;
document.body.append(quickAdd);
const quickInput = quickAdd.querySelector("input");

function openQuickAdd(n) {
  const t = d3.zoomTransform(svg.node());
  const box = svg.node().getBoundingClientRect();
  quickAdd.style.left = `${box.left + t.applyX(n.x)}px`;
  quickAdd.style.top = `${box.top + t.applyY(n.y + n.r + 36)}px`; // under the title and label
  quickAdd.dataset.parent = n.path;
  quickInput.value = "";
  quickAdd.hidden = false;
  quickInput.focus();
}

quickInput.addEventListener("input", () => quickInput.setCustomValidity(""));
quickInput.addEventListener("blur", () => (quickAdd.hidden = true));
quickAdd.addEventListener("mousedown", (e) => e.target !== quickInput && e.preventDefault()); // a click on the card keeps it open
quickInput.addEventListener("keydown", (e) => {
  e.stopPropagation(); // Escape closes this, not the panel
  if (e.key === "Escape") quickInput.blur();
});
quickAdd.addEventListener("submit", async (e) => {
  e.preventDefault();
  const parent = quickAdd.dataset.parent;
  const title = quickInput.value.trim();
  const path = parent ? `${parent}/${slug(title)}` : slug(title);
  try {
    await post("create", { path, title });
  } catch (err) {
    quickInput.setCustomValidity(err.message);
    return quickInput.reportValidity();
  }
  quickInput.blur();
  if (parent !== graphRoot.data.path) expanded.add(parent); // unpack the parent so the new child shows
  writeExpanded();
  selected = path; // a new node is idle; selecting it before the redraw keeps it out of "N others"
  await load();
  select(path);
});

// Placement takes a few seconds (a Haiku call), so it runs on the server and shows in the rail until the session starts.
// ---- Dispatch: one dialog over everything; Haiku picks the node under the parent ----

const dispatcher = document.getElementById("dispatcher");
const dispatchForm = dispatcher.querySelector("form");
const parentLine = dispatchForm.querySelector(".parent");
let dispatchScope = ""; // the parent: the node in view, until dismissed
function setScope(p) {
  dispatchScope = p;
  parentLine.hidden = !p;
  parentLine.querySelector("b").textContent = byPath.get(p)?.data.title ?? p;
  parentLine.querySelector("b").title = p;
}
parentLine.querySelector(".unparent").addEventListener("click", () => {
  setScope("");
  dispatchForm.prompt.focus();
});
function openDispatch() {
  if (dispatcher.open) return;
  dispatchForm.reset();
  setScope(selected ?? graphRoot?.data.path ?? "");
  dispatchForm.querySelector(".where-slot").innerHTML = whereSelect();
  dispatchForm.querySelector(".err").hidden = true;
  dispatcher.showModal();
  dispatchForm.prompt.focus();
}
dispatchForm.querySelector(".cancel").addEventListener("click", () => dispatcher.close());

// ⌥Q ends the current rail session, as its End button does, once Enter confirms.
const ender = document.getElementById("ender");
function confirmEnd() {
  const row = railRows().find(isCurrent);
  if (!row || ender.open) return;
  ender.dataset.sid = row.dataset.sid;
  ender.querySelector(".what").textContent = `End ${row.querySelector(".name").textContent}?`;
  ender.returnValue = "";
  ender.showModal();
}
ender.addEventListener("close", () => ender.returnValue === "end" && end(ender.dataset.sid));

const keyhelp = document.getElementById("keyhelp");
document.getElementById("keys").addEventListener("click", () => keyhelp.showModal());

// ---- Palette: ⇧⌘P finds any node by name and resumes it. A ">" prefix lists commands instead. ----

const palette = document.getElementById("palette");
const paletteInput = palette.querySelector("input");
const paletteList = palette.querySelector("ol");
const COMMANDS = []; // { name, run }
let paletteItems = [];
let paletteAt = 0;

function openPalette() {
  if (palette.open || !tree) return;
  paletteInput.value = "";
  renderPalette();
  palette.showModal();
}

// Lower is better: title prefix, title substring, path substring, then the letters in order anywhere. -1 is no match.
function rank(q, d) {
  const title = d.data.title.toLowerCase();
  const path = d.data.path.toLowerCase();
  if (title.includes(q)) return title.startsWith(q) ? 0 : 1;
  if (path.includes(q)) return 2;
  const text = `${title} ${path}`;
  let at = -1;
  for (const c of q) if ((at = text.indexOf(c, at + 1)) < 0) return -1;
  return 3;
}

function renderPalette() {
  const q = paletteInput.value.trim().toLowerCase();
  const commands = q.startsWith(">");
  if (commands) {
    const c = q.slice(1).trim();
    paletteItems = COMMANDS.filter((x) => x.name.toLowerCase().includes(c)).map((x) => ({ label: x.name, run: x.run }));
  } else {
    // With no query, nodes with live sessions come first.
    paletteItems = tree.descendants()
      .map((d) => ({ d, r: q ? rank(q, d) : d.data.sessions.length ? 0 : 1 }))
      .filter((x) => x.r >= 0)
      .sort((a, b) => a.r - b.r)
      .map(({ d }) => ({
        label: d.data.title,
        path: d.data.path || "/",
        state: d.data.sessions.length ? mostUrgent(withNode(d)) : null,
        run: () => resumeNode(d.data.path),
      }));
  }
  paletteAt = 0;
  paletteList.innerHTML = paletteItems.length
    ? paletteItems.map((x, i) => `<li data-i="${i}"${i ? "" : ' class="on"'}><span class="name">${esc(x.label)}</span>${x.path ? `<span class="path">${esc(x.path)}</span>` : ""}${x.state ? `<span class="st">${STATE_MARK[x.state]} ${STATE_LABEL[x.state]}</span>` : ""}</li>`).join("")
    : `<li class="none">${commands ? "No commands yet" : "No matching nodes"}</li>`;
}

function movePalette(step) {
  const rows = paletteList.querySelectorAll("li[data-i]");
  if (!rows.length) return;
  rows[paletteAt].classList.remove("on");
  paletteAt = (paletteAt + step + rows.length) % rows.length;
  rows[paletteAt].classList.add("on");
  rows[paletteAt].scrollIntoView({ block: "nearest" });
}

function pickPalette(i) {
  const item = paletteItems[i];
  if (!item) return;
  palette.close();
  item.run();
}

// Opens the node's live terminal if it has one; otherwise resumes its last conversation, as the panel's Resume does.
async function resumeNode(path) {
  const s = withNode(byPath.get(path)).filter((x) => x.tmux).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (s && term) return openTerminal(s.tmux, path, s.host);
  reveal(path);
  await select(path);
  if (s) openTerminal(s.tmux, path, s.host);
  else launchSession(true);
}

paletteInput.addEventListener("input", renderPalette);
paletteInput.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    movePalette(e.key === "ArrowDown" ? 1 : -1);
  }
  if (e.key === "Enter") {
    e.preventDefault();
    pickPalette(paletteAt);
  }
});
paletteList.addEventListener("click", (e) => {
  const li = e.target.closest("li[data-i]");
  if (li) pickPalette(Number(li.dataset.i));
});
palette.addEventListener("click", (e) => e.target === palette && palette.close()); // the backdrop

// General settings are per browser. Integrations live on the server, which does the copying.
const settings = document.getElementById("settingsdlg");
const setting = (name) => settings.querySelector(`[name=${name}]`);
const settingsErr = settings.querySelector(".err");
const loadObsidian = () => fetch("/api/obsidian").then((r) => r.json());
loadObsidian().then((o) => (obsidian = o.obsidian)).catch(() => {});

function showTab(name) {
  for (const t of settings.querySelectorAll("[data-tab]")) t.setAttribute("aria-selected", t.dataset.tab === name);
  for (const p of settings.querySelectorAll("[data-pane]")) p.hidden = p.dataset.pane !== name;
}
settings.querySelector(".tabs").addEventListener("click", (e) => {
  const tab = e.target.closest("[data-tab]");
  if (tab) showTab(tab.dataset.tab);
});
const showObsidianFields = () => (settings.querySelector(".fields").hidden = !setting("obsidian").checked);
setting("obsidian").addEventListener("change", showObsidianFields);

document.getElementById("settings").addEventListener("click", async () => {
  setting("idle").value = idleMinutes;
  setting("motion").checked = motion;
  for (const k in knobs) setting(k).value = knobs[k];
  showKnobs();
  const o = await loadObsidian();
  const name = (p) => p.split("/").pop();
  setting("vault").innerHTML = o.vaults.map((v) => `<option value="${esc(v)}"${v === o.obsidian?.vault ? " selected" : ""}>${esc(name(v))}</option>`).join("");
  setting("folder").value = o.obsidian?.folder ?? "unfiled";
  setting("obsidian").checked = !!o.obsidian;
  setting("obsidian").disabled = !o.vaults.length;
  settings.querySelector(".obs-note").textContent = o.vaults.length
    ? "Adds a Copy to Obsidian button to documents. Copies are snapshots, saved in one folder of a vault."
    : "No Obsidian vaults found on this Mac.";
  showObsidianFields();
  showTab("general");
  settingsErr.hidden = true;
  settings.returnValue = "";
  settings.showModal();
});
const showKnobs = () => (settings.querySelector(".knobs").hidden = !setting("motion").checked);
setting("motion").addEventListener("change", showKnobs);
// The map follows the knobs while you drag them; Cancel puts back the saved values.
function applyKnobs() {
  document.body.style.setProperty("--flow-speed", knobs.flow);
  drawStars();
}
settings.querySelector(".knobs").addEventListener("input", (e) => {
  knobs[e.target.name] = Number(e.target.value);
  applyKnobs();
});

settings.addEventListener("close", async () => {
  if (settings.returnValue !== "save") return readKnobs(), applyKnobs();
  try { localStorage.setItem("orca.motionKnobs", JSON.stringify(knobs)); } catch {}
  idleMinutes = Number(setting("idle").value);
  try { localStorage.setItem("orca.idleMinutes", idleMinutes); } catch {}
  motion = setting("motion").checked;
  document.body.classList.toggle("still", !motion);
  try { localStorage.setItem("orca.still", motion ? "0" : "1"); } catch {}
  render();
  try {
    const vault = setting("obsidian").checked ? setting("vault").value : "";
    obsidian = (await post("obsidian", { vault, folder: setting("folder").value })).obsidian;
  } catch (err) {
    settingsErr.textContent = err.message;
    settingsErr.hidden = false;
    showTab("integrations");
    settings.showModal(); // stay open so the folder can be fixed
  }
});
dispatchForm.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) dispatchForm.requestSubmit();
  if (e.key === "Backspace" && e.target === dispatchForm.prompt && !e.target.value && dispatchScope) setScope("");
});
dispatchForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await post("dispatch", { path: dispatchScope, prompt: dispatchForm.prompt.value, host: dispatchForm.host?.value });
    dispatcher.close();
    load();
  } catch (err) {
    const el = dispatchForm.querySelector(".err");
    el.textContent = err.message;
    el.hidden = false;
  }
});

panel.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && e.target.form) e.target.form.requestSubmit();
});

panel.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!e.target.matches(".qadd")) return submitForm(e.target);
  const input = e.target.task;
  await post("queue", { path: selected, task: input.value }).catch((err) => alertInPanel(err.message));
  input.value = "";
  refreshPanel();
});

// ---- Terminal ----

// Terminal mode is the detailed view; the map is the default. Esc always leads back to the map.
// `watch` opens a child session read-only; its parent does the typing.
async function openTerminal(name, path = selected ?? graphRoot.data.path, host = undefined, watch = false) {
  if (term) stopTerminal();
  document.body.classList.add("mode-term");
  termview.hidden = false;
  const d = byPath.get(path);
  const title = d?.data.title ?? path;
  const trail = d ? d.ancestors().reverse().slice(0, -1).map((a) => a.data.title).join(" / ") : path || "/";
  termview.querySelector(".title").textContent = title;
  termview.querySelector(".trail").textContent = [trail, host, name].filter(Boolean).join("  ·  ");
  const managed = termview.querySelector(".managed");
  managed.hidden = !watch;
  managed.querySelector("b").textContent = byPath.get(d?.data.parent)?.data.title ?? d?.data.parent ?? "";
  // Flash the title over the terminal, so a switch is hard to miss.
  const flash = termview.querySelector(".flash");
  flash.textContent = title;
  flash.classList.remove("on");
  void flash.offsetWidth; // restart the animation
  flash.classList.add("on");
  relayout(0);

  const xterm = new Terminal({
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
    fontSize: 13,
    cursorBlink: true,
    theme: termTheme(),
  });
  const fit = new FitAddon.FitAddon();
  xterm.loadAddon(fit);
  const el = document.getElementById("term");
  xterm.open(el);
  // A worker session's files live on the worker, which the server cannot read.
  if (!host) xterm.registerLinkProvider(mdLinks(xterm));
  xterm.loadAddon(new WebLinksAddon.WebLinksAddon((e, url) => window.open(url, "_blank", "noopener")));
  // These keys belong to orca, not Claude; stop them so the page handlers do not act on them twice.
  xterm.attachCustomKeyEventHandler((e) => {
    // ⌥Q types œ on a Mac, so match the physical key.
    if (e.key === "Escape" || (e.metaKey && (e.key === "." || e.key === "k" || e.code === "KeyP")) || (e.altKey && (e.key === "Tab" || e.code === "KeyQ"))) e.stopPropagation();
    if (e.code === "KeyP" && e.metaKey && e.shiftKey) {
      e.preventDefault();
      if (e.type === "keydown") openPalette();
      return false;
    }
    if (e.code === "KeyQ" && e.altKey) {
      e.preventDefault();
      if (e.type === "keydown") confirmEnd();
      return false;
    }
    if (e.key === "Tab" && e.altKey) {
      e.preventDefault(); // otherwise the browser moves focus, out to its own toolbar
      if (e.type === "keydown") stepRail(e.shiftKey);
      return false;
    }
    if (e.key === "k" && e.metaKey) {
      if (e.type === "keydown") openDispatch();
      return false;
    }
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
  const ws = new WebSocket(`${proto}://${location.host}/api/term?session=${encodeURIComponent(name)}${host ? `&host=${encodeURIComponent(host)}` : ""}${watch ? "&watch=1" : ""}`);
  const resize = () => {
    fit.fit();
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ r: [xterm.cols, xterm.rows] }));
  };
  ws.onopen = resize;
  ws.onmessage = (e) => xterm.write(e.data);
  ws.onclose = () => xterm.write("\r\n[disconnected]\r\n");
  const send = (d) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ i: d }));
  if (!watch) xterm.onData(send);
  const ro = new ResizeObserver(resize);
  ro.observe(el);
  term = { xterm, ws, ro, name, path, host, watch };
  lastTerm = { name, path, host };
  markSeen(sessionsIn(tree).filter((s) => isOpen(s)));
  renderRail();
  xterm.focus();
}

function termTheme() {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  return { background: v("--paper-2"), foreground: v("--ink"), cursor: v("--ink"), selectionBackground: v("--ink-3") };
}

termview.querySelector(".takeover").addEventListener("click", () => openTerminal(term.name, term.path, term.host));

function stopTerminal() {
  docview.hidden = true;
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

// ---- Documents: a .md path printed in the terminal opens beside it ----

const docview = document.getElementById("doc");
const MD_PATH = /[\w~./-]*[\w-]\.md\b/g;

function mdLinks(xterm) {
  return {
    provideLinks(y, callback) {
      const text = xterm.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
      // A URL ending in .md is a web link, not a file.
      callback([...text.matchAll(MD_PATH)].filter((m) => !/\w:$/.test(text.slice(0, m.index))).map((m) => ({
        text: m[0],
        range: { start: { x: m.index + 1, y }, end: { x: m.index + m[0].length, y } },
        activate: () => openDoc(m[0]),
      })));
    },
  };
}

// A relative path resolves against `cwd`. An error comes back as the document's text.
async function fetchDoc(file, cwd = "") {
  const res = await fetch(`/api/file?path=${encodeURIComponent(file)}&cwd=${encodeURIComponent(cwd)}`);
  const d = await res.json();
  return res.ok ? d : { path: file, html: `<p>${esc(d.error)}</p>` };
}

// Relative paths in the terminal belong to the folder of the session that printed them.
async function openDoc(file) {
  const d = await fetchDoc(file, sessionsIn(tree).find((s) => isOpen(s))?.cwd);
  docview.querySelector(".where").textContent = d.path;
  docview.querySelector(".copied")?.remove();
  docview.querySelector(".copyobs").hidden = !obsidian;
  docview.querySelector(".copyobs").textContent = "Copy to Obsidian";
  docview.querySelector(".md").innerHTML = d.html;
  docview.hidden = false;
  docview.scrollTop = 0;
}

// Acts on the file on the Mac that runs the server: "open" uses the default app for .md files,
// "reveal" selects it in Finder.
function popout(button, file, op = "open") {
  post(op, { path: file }).catch((err) => {
    button.textContent = "Can't open";
    button.title = err.message;
  });
}

// Copies the file into the chosen vault folder. The button gives way to where it went and a link
// that opens the copy in Obsidian, so a second click cannot make a duplicate.
function copyToObsidian(button, file) {
  post("copy", { path: file }).then(
    (r) => {
      const done = document.createElement("span");
      done.className = "copied";
      done.innerHTML = `Copied to ${esc(r.copied.slice(obsidian.vault.length + 1))} <a class="button" href="obsidian://open?path=${encodeURIComponent(r.copied)}">Open in Obsidian</a>`;
      button.hidden = true;
      button.after(done);
    },
    (err) => ((button.textContent = "Can't copy"), (button.title = err.message)),
  );
}

docview.querySelector(".copyobs").addEventListener("click", (e) => copyToObsidian(e.target, docview.querySelector(".where").textContent));
docview.querySelector(".popout").addEventListener("click", (e) => popout(e.target, docview.querySelector(".where").textContent));
docview.querySelector(".reveal").addEventListener("click", (e) => popout(e.target, docview.querySelector(".where").textContent, "reveal"));

docview.querySelector(".close").addEventListener("click", () => {
  docview.hidden = true;
  term?.xterm.focus();
});

panel.addEventListener("click", (e) => {
  if (e.target.closest(".close")) closePanel();
  if (e.target.closest(".cancel")) closeForm();
  const obs = e.target.closest("[data-copyobs]");
  if (obs) copyToObsidian(obs, obs.dataset.copyobs);
  const pop = e.target.closest("[data-popout]");
  if (pop) popout(pop, pop.dataset.popout);
  const doc = e.target.closest("[data-doc]");
  if (doc) readInPanel(doc.dataset.doc);
  if (e.target.closest(".back")) {
    editing = false;
    panelText = "";
    refreshPanel();
  }
  const open = e.target.closest("[data-form]");
  if (open) openForm(open.dataset.form);
  const finder = e.target.closest(".finder");
  if (finder) popout(finder, selected, "finder");
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
  const job = e.target.closest("[data-reveal]");
  if (job) {
    reveal(job.dataset.reveal);
    select(job.dataset.reveal);
  }
  const rootButton = e.target.closest("[data-root]");
  if (rootButton) setRoot(rootButton.dataset.root);
  const copy = e.target.closest(".copy");
  if (copy) navigator.clipboard.writeText(panelFile).then(() => (copy.textContent = "Copied"));
});

// ---- Wiring ----

// Theme cycles system → light → dark. System removes the override so the CSS media query decides.
const themeButton = document.getElementById("theme");
const themes = ["system", "light", "dark"];
function applyTheme(t) {
  if (t === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  themeButton.textContent = t;
  if (term) term.xterm.options.theme = termTheme();
}
themeButton.addEventListener("click", () => {
  const t = themes[(themes.indexOf(document.documentElement.dataset.theme ?? "system") + 1) % themes.length];
  try { t === "system" ? localStorage.removeItem("orca.theme") : localStorage.setItem("orca.theme", t); } catch {}
  applyTheme(t);
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => term && (term.xterm.options.theme = termTheme()));
applyTheme(document.documentElement.dataset.theme ?? "system");

document.getElementById("about").addEventListener("click", () => graphRoot && select(graphRoot.data.path));
// Header forms act on the root of the graph.
async function openFocusForm(kind) {
  if (!graphRoot) return;
  await select(graphRoot.data.path);
  openForm(kind);
}
document.getElementById("new").addEventListener("click", () => openFocusForm("child"));
document.getElementById("dispatch").addEventListener("click", openDispatch);
svg.on("click", () => selected !== null && closePanel());
addEventListener("hashchange", () => {
  if (!tree) return;
  if (term) closeTerminal(false); // a breadcrumb click in terminal mode goes where it points
  applyRoot();
});
document.getElementById("mapbtn").addEventListener("click", () => term && closeTerminal());
addEventListener("resize", () => relayout(0));
addEventListener("keydown", (e) => {
  if (e.key === "k" && e.metaKey) {
    e.preventDefault();
    return openDispatch();
  }
  if (e.code === "KeyP" && e.metaKey && e.shiftKey) {
    e.preventDefault();
    return openPalette();
  }
  if (dispatcher.open || ender.open || keyhelp.open || settings.open || palette.open) return; // the dialogs handle their own Escape
  if (e.code === "KeyQ" && e.altKey) {
    e.preventDefault();
    return confirmEnd();
  }
  if (e.key === "Tab" && e.altKey) {
    e.preventDefault();
    return stepRail(e.shiftKey);
  }
  if (e.key === "." && e.metaKey) {
    e.preventDefault();
    return toggleTerminal();
  }
  if (e.key === "Escape" && term) return closeTerminal(); // terminal not focused
  const typing = e.target.closest?.("input, textarea, select, .xterm");
  if (e.key === "f" && !typing && !term && !e.metaKey && !e.ctrlKey) return fitView(500);
  if (e.key === "/" && !typing && !term) {
    e.preventDefault();
    return openDispatch();
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
