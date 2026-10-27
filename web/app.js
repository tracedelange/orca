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
let panelLock = ""; // the selected node's consolidation state, which /api/node does not carry
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
let shells = []; // plain tmux shells: [{ tmux, path, cwd, created }]
let jobs = []; // dispatches still being placed, or failed: [{ id, prompt, host, startedAt, error }]
const revealed = new Set(); // sessionIds whose node has been unpacked onto the map once
let showArchived = readFlag("orca.showArchived");
let obsidian = null; // { vault, folder } once the user opts in to copying documents there
let idleMinutes = 30; // children quiet for longer than this share one "others" node
let showTailnet = !readFlag("orca.noTailnet"); // the tailnet in the usage bar
let notify = readFlag("orca.notify"); // Mac notifications for sessions that need you or finish
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
let railOff = readFlag("orca.railOff");
const railButton = document.getElementById("railbtn");
railButton.classList.toggle("on", !railOff);
railButton.addEventListener("click", () => {
  railOff = !railOff;
  railButton.classList.toggle("on", !railOff);
  try { localStorage.setItem("orca.railOff", railOff ? "1" : "0"); } catch {}
  renderRail();
});

// ---- Data ----

async function load() {
  fetch("/api/workers").then((r) => r.json()).then((w) => (workerList = w)).catch(() => {});
  const [res, seenRes, jobsRes, parkedRes, shellsRes] = await Promise.all([fetch("/api/tree"), fetch("/api/seen"), fetch("/api/dispatches"), fetch("/api/parked"), fetch("/api/shells")]);
  jobs = await jobsRes.json();
  shells = await shellsRes.json();
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
  revealActive();
  renderRail();
  const key = lockKey(selected);
  if (key !== panelLock) (panelLock = key), (panelText = "");
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
  saveSeen(Object.fromEntries(fresh.map((s) => [s.sessionId, s.finishedAt])));
}

// An empty mark is older than any finishedAt, so the result reads as new again.
const markUnread = (id) => saveSeen({ [id]: "" });

function saveSeen(marks) {
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

// Two layers of stars behind the map. Each pans at a fraction of the map's speed, for depth.
// Stars come in TILE px tiles, seeded by the tile's position: neighbours differ, and a tile looks the same when you pan back.
const TILE = 512;
const gStars = svg.insert("g", ":first-child").attr("class", "stars");
const starLayers = [
  { name: "far", seed: 1, speed: 0.08, count: 40, size: [0.5, 1] },
  { name: "near", seed: 2, speed: 0.2, count: 12, size: [0.9, 1.6] },
].map((l) => ({ ...l, g: gStars.append("g").attr("class", l.name), shown: "" }));

function tileStars(l, i, j) {
  const rnd = d3.randomLcg(Math.abs((i * 73856093) ^ (j * 19349663) ^ (l.seed * 83492791)));
  return d3.range(Math.round(l.count * knobs.density)).map(() => ({
    x: (i + rnd()) * TILE,
    y: (j + rnd()) * TILE,
    r: l.size[0] + rnd() * (l.size[1] - l.size[0]),
    // About a third twinkle, each on its own clock.
    tw: rnd() < 0.3,
    dur: 3 + rnd() * 5,
    delay: -rnd() * 8,
  }));
}

function drawStars() {
  for (const l of starLayers) l.shown = "";
  panStars(d3.zoomTransform(svg.node()));
}

function panStars(t) {
  for (const l of starLayers) {
    const dx = t.x * l.speed * knobs.parallax, dy = t.y * l.speed * knobs.parallax;
    l.g.attr("transform", `translate(${dx},${dy})`);
    // Redraw only when the set of tiles on screen changes.
    const is = d3.range(Math.floor(-dx / TILE), Math.floor((innerWidth - dx) / TILE) + 1);
    const js = d3.range(Math.floor(-dy / TILE), Math.floor((innerHeight - dy) / TILE) + 1);
    const key = `${is[0]},${js[0]},${is.length},${js.length}`;
    if (key === l.shown) continue;
    l.shown = key;
    l.g.selectAll("circle")
      .data(d3.cross(is, js).flatMap(([i, j]) => tileStars(l, i, j)))
      .join("circle")
      .attr("cx", (s) => s.x).attr("cy", (s) => s.y).attr("r", (s) => s.r)
      .classed("tw", (s) => s.tw)
      .style("animation-duration", (s) => `${s.dur}s`)
      .style("animation-delay", (s) => `${s.delay}s`);
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
  const under = (d) => { for (let a = d.parent; a; a = a.parent) if (a === pivot.d) return true; };
  for (const n of sim.nodes()) {
    if (n.fx != null || !under(n.d)) continue;
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
  sel.attr("class", (n) => `node ${kindOf(n.d)} a-${mostUrgent(nodeSessions(n.d))}${n.d.data.archived ? " archived" : ""}${n.d.data.lock !== undefined ? " locked" : ""}${n.d.others ? " others" : ""}${n.path === selected ? " selected" : ""}`);
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
  // The dock badge of an installed app; a plain tab has none.
  attention ? navigator.setAppBadge?.(attention) : navigator.clearAppBadge?.();
  alertChanges(sessions);
  // The open session leads the tab title, so the browser and OS switchers show it too.
  const here = term && byPath.get(term.path)?.data.title;
  document.title = `${attention ? `(${attention}) ` : ""}${here ? `${here} · ` : ""}Orca`;
  // Your last prompt under the terminal's title; hover it for the latest status.
  const open = term && sessionsIn(graphRoot).find((s) => isOpen(s));
  const prompt = termview.querySelector(".prompt");
  prompt.textContent = open?.prompt ?? "";
  prompt.title = open?.summary ?? "";

  const wasHidden = rail.hidden;
  rail.hidden = railOff || (!sessions.length && !jobs.length && !shells.length);
  // Working sessions get their own section at the top; the rest stay most urgent first.
  // Dispatches still being placed sit at the top of Working.
  const groups = { working: jobs.map(jobRow), rest: [], parked: [], shells: shells.map(shellRow) };
  for (const s of sessions) groups[isParked(s) ? "parked" : railState(s) === "working" ? "working" : "rest"].push(railRow(s));
  for (const [name, list] of Object.entries(groups)) {
    const section = rail.querySelector(`[data-group="${name}"]`);
    section.hidden = !list.length;
    section.querySelector("ol").innerHTML = list.join("");
  }
  const parkedSection = rail.querySelector('[data-group="parked"]');
  parkedSection.classList.toggle("folded", !parkedOpen);
  parkedSection.querySelector(".fold").textContent = `Parked · ${groups.parked.length}`;
  const shellsSection = rail.querySelector('[data-group="shells"]');
  shellsSection.classList.toggle("folded", shellsFolded);
  shellsSection.querySelector(".fold").textContent = `Shells · ${groups.shells.length}`;
  if (wasHidden !== rail.hidden) relayout(300);
}

function railRow(s) {
  const st = railState(s);
  const done = s.done && ["new", "ready"].includes(st);
  const label = done ? "done" : st === sessionState(s) ? STATE_LABEL[st] : st === "working" ? "child working" : "child asks";
  const park = isParked(s)
    ? `<button type="button" class="end park" data-park="${esc(s.sessionId)}" title="Back to the rail">Unpark</button>`
    : `<button type="button" class="end park" data-park="${esc(s.sessionId)}" data-on="1" title="Move to Parked until it acts again">Park</button>`;
  const unread = st === "ready" && s.finishedAt ? `<button type="button" class="end unread" data-unread="${esc(s.sessionId)}" title="Show as new result until you type a reply">Unread</button>` : "";
  return `<li>${unread}${park}${endButton(s, st)}<button type="button" class="a-${st}${isOpen(s) ? " open" : ""}" data-path="${esc(s.path)}" data-sid="${esc(s.sessionId)}">
    <span class="line"><span class="mark">${done ? "✓" : STATE_MARK[st]}</span><span class="name">${esc(s.title)}</span><span class="st">${label}</span></span>
    ${s.prompt ? `<span class="sum you"${s.summary ? ` title="${esc(s.summary)}"` : ""}>${esc(s.prompt)}</span>` : ""}
    <span class="meta">${s.host ? `${esc(s.host)} · ` : ""}${esc(s.path || "/")} · ${ago(s.updatedAt)}</span>
  </button>${drawer(s)}</li>`;
}

// A session that said "Done:" offers End + archive: its node's goal is met.
const endButton = (s, st) => s.done
  ? `<button type="button" class="end" data-end="${esc(s.sessionId)}" data-state="${st}" data-archive="1" title="End this session and archive its node">End + archive</button>`
  : `<button type="button" class="end" data-end="${esc(s.sessionId)}" data-state="${st}" title="End this session">End</button>`;

function shellRow(sh) {
  const title = byPath.get(sh.path)?.data.title ?? (sh.path || "/");
  return `<li><button type="button" class="end" data-closeshell="${esc(sh.tmux)}" title="Close this shell">Close</button><button type="button" class="a-ready${term?.name === sh.tmux ? " open" : ""}" data-shell="${esc(sh.tmux)}" data-path="${esc(sh.path)}">
    <span class="line"><span class="mark">$</span><span class="name">${esc(title)}</span><span class="st">shell</span></span>
    <span class="meta">${esc(sh.cwd)} · ${ago(sh.created)}</span>
  </button></li>`;
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
  const unread = e.target.closest("[data-unread]");
  if (unread) return markUnread(unread.dataset.unread);
  const park = e.target.closest("[data-park]");
  if (park) {
    await post("park", { session: park.dataset.park, park: !!park.dataset.on }).catch(() => {});
    return load();
  }
  const closeButton = e.target.closest("[data-closeshell]");
  if (closeButton) {
    await post("closeshell", { tmux: closeButton.dataset.closeshell }).catch(() => {});
    if (term?.name === closeButton.dataset.closeshell) closeTerminal(false);
    return load();
  }
  const shell = e.target.closest("[data-shell]");
  if (shell) return openTerminal(shell.dataset.shell, shell.dataset.path);
  const fold = e.target.closest(".fold");
  if (fold) {
    if (fold.closest('[data-group="shells"]')) {
      shellsFolded = !shellsFolded;
      try { localStorage.setItem("orca.shellsFolded", shellsFolded ? "1" : "0"); } catch {}
    } else {
      parkedOpen = !parkedOpen;
      try { localStorage.setItem("orca.parkedOpen", parkedOpen ? "1" : "0"); } catch {}
    }
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
let shellsFolded = readFlag("orca.shellsFolded"); // Shells starts open

// ---- Notifications ----

let lastStates = null; // sessionId -> rail state at the last render; the first render never notifies

// Notifies for each rail session that just turned "needs you" or "new result", unless you are looking.
// The tag stops two open tabs from showing the same notification twice.
function alertChanges(sessions) {
  const before = lastStates;
  lastStates = new Map(sessions.map((s) => [s.sessionId, isParked(s) ? "parked" : railState(s)]));
  if (!before || !notify || Notification.permission !== "granted" || document.hasFocus()) return;
  for (const s of sessions) {
    const st = lastStates.get(s.sessionId);
    if (!["needs", "new"].includes(st) || before.get(s.sessionId) === st) continue;
    const n = new Notification(s.title, { body: st === "needs" ? "Needs you" : `${s.done ? "Done" : "Finished"}${s.summary ? `: ${s.summary}` : ""}`, tag: s.sessionId });
    n.onclick = () => {
      focus();
      n.close();
      rail.querySelector(`button[data-sid="${CSS.escape(s.sessionId)}"]`)?.click();
    };
  }
}

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

async function select(p, tab = "node") {
  editing = false;
  selected = p;
  panelTab = tab;
  panelRow = -1;
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

// The panel shows one tab at a time. Its keys are in panelKey.
const TABS = ["node", "docs", "todo", "notes", "queue"];
let panelTab = "node";
let panelRow = -1; // the row the keyboard is on, in the open tab

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
  const labels = { node: "Node", docs: `Docs${n.docs.length ? ` · ${n.docs.length}` : ""}`, todo: "Todo", notes: "Notes", queue: "Queue β" };
  panel.innerHTML = `
    <div class="top"><span class="kicker">${esc(n.path || "/")}</span><button class="close" type="button">Close</button></div>
    <h1>${esc(n.title)}</h1>
    ${n.goal ? `<p class="goal">${esc(n.goal)}</p>` : ""}
    ${roundBanner(n.path)}
    <div class="actions">
      <button class="resume" type="button"><kbd>r</kbd>Resume</button>
      <button class="launch" type="button"><kbd>l</kbd>Launch</button>
      <button class="shell" type="button" title="Open a terminal in this node's folder"><kbd>s</kbd>Shell</button>
      <button data-form="child" type="button"><kbd>n</kbd>Add child</button>
      <button class="newtodo" type="button"><kbd>t</kbd>Add todo</button>
      <button data-form="edit" type="button"><kbd>e</kbd>Edit</button>
      ${whereSelect()}
    </div>
    <details class="more"><summary>More</summary>
      <dl>
        ${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}
        <dt>file</dt><dd class="file"><code>${esc(n.file)}</code><button class="copy" type="button">Copy</button></dd>
      </dl>
      <div class="actions">
        ${n.path ? `<button data-form="move" type="button">Move</button><button data-archive="${n.archived ? "" : "1"}" type="button">${n.archived ? "Unarchive" : "Archive"}</button><button data-form="remove" type="button">Delete</button>` : ""}
        ${byPath.get(n.path)?.children ? `<button class="consolidate" type="button" title="Propose a cleaner structure for this subtree">Consolidate…</button>` : ""}
        ${byPath.get(n.path)?.children && n.path !== graphRoot.data.path ? `<button data-root="${esc(n.path)}" type="button">Set as root</button>` : ""}
      </div>
    </details>
    <p class="alert" hidden></p>
    <form class="form" hidden></form>
    ${n.issues.length ? `<ul class="issues">${n.issues.map((i) => `<li>${esc(i.level)}: ${esc(i.message)}</li>`).join("")}</ul>` : ""}
    <nav class="tabs">${TABS.map((t, i) => `<button type="button" data-tab="${t}"${t === panelTab ? ' class="on"' : ""}><kbd>${i + 1}</kbd>${labels[t]}</button>`).join("")}</nav>
    <div class="tabbody">${renderTab(n)}</div>`;
  if (byPath.get(n.path)?.data.lock !== undefined) {
    for (const b of panel.querySelectorAll(".resume, .launch, [data-form], [data-archive], .consolidate")) b.disabled = true;
  }
  // The goal shows under the title and the queue has its own tab; drop their body sections.
  for (const h of [...panel.querySelectorAll(".md h2")].filter((el) => ["goal", "queue"].includes(el.textContent.trim().toLowerCase()))) {
    while (h.nextElementSibling && !/^H[1-6]$/.test(h.nextElementSibling.tagName)) h.nextElementSibling.remove();
    h.remove();
  }
  if (typed && panel.querySelector(".qadd input")) {
    const input = panel.querySelector(".qadd input");
    input.value = typed.value;
    if (typed.focused) input.focus();
  }
  markRow();
  if (panelTab === "todo") {
    todoScope = n.path;
    renderTodos();
  }
}

function renderTab(n) {
  if (panelTab === "node") return renderChildren(byPath.get(n.path)?.children ?? []) + renderSessions(n.sessions);
  if (panelTab === "docs") return renderDocs(n.docs);
  if (panelTab === "notes") return `<div class="md">${n.html}</div>`;
  if (panelTab === "queue") return renderQueue(n.queue);
  return ""; // todo: renderTodos fills it
}

function setTab(t) {
  editing = false;
  panelTab = t;
  panelRow = -1;
  renderPanel(panelNode);
}

function renderChildren(kids) {
  const items = kids.map((c) => {
    const st = c.data.sessions.length ? mostUrgent(withNode(c)) : null;
    return `<li><button class="row-open" type="button" data-reveal="${esc(c.data.path)}"><span class="name">${esc(c.data.title)}</span>${c.children ? `<span class="sub">${c.children.length} below</span>` : ""}${st ? `<span class="st">${STATE_MARK[st]} ${STATE_LABEL[st]}</span>` : ""}</button></li>`;
  });
  return `<section class="children">
    <div class="sec-head"><span>Children</span></div>
    ${items.length ? `<ul>${items.join("")}</ul>` : `<div class="none">No children</div>`}
  </section>`;
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
        ${endButton(s, sessionState(s))}
      </span>
    </li>`);
  return `<section class="sessions">
    <div class="sec-head"><span>Sessions</span></div>
    ${items.length ? `<ul>${items.join("")}</ul>` : `<div class="none">No sessions</div>`}
  </section>`;
}

function renderDocs(docs) {
  const items = docs.map((d) => `<li><button class="doc" type="button" data-doc="${esc(d.file)}">${esc(d.name)}</button><time>${ago(d.modified)}</time></li>`);
  return `<section class="docs">
    <div class="sec-head"><span>Docs</span><button class="finder" type="button">Open folder</button></div>
    ${items.length ? `<ul>${items.join("")}</ul>` : `<div class="none">No docs</div>`}
  </section>`;
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

// ---- Todo: parked ideas in each node's TODO.md ----

let todoScope = null; // a node path, or null for every node's list
let todoDone = false; // show the checked-off items too

// A node's parked ideas show in its Todo tab. Every node's ideas show in place of the node's details, until Back.
async function openTodos(scope) {
  if (term) closeTerminal(false);
  todoScope = scope;
  if (scope !== null) {
    reveal(scope);
    return select(scope, "todo");
  }
  if (selected === null) await select(graphRoot.data.path);
  renderTodos();
}

async function renderTodos() {
  const groups = await (await fetch(`/api/todos${todoScope === null ? "" : `?path=${encodeURIComponent(todoScope)}`}`)).json();
  const lists = groups.map((g) => {
    const rows = g.items.filter((t) => todoDone || !t.done).map((t) => `
      <li class="${t.done ? "j-done" : ""}" data-path="${esc(g.path)}" data-n="${t.n}">
        <span class="mark">${t.done ? "✓" : "○"}</span>
        <span class="text">${esc(t.text)}</span>
        ${t.to === "queued" ? `<span class="st">queued</span>`
          : t.to ? `<button class="child" type="button" data-reveal="${esc(t.to)}" title="${esc(t.to)}">${esc(t.to.split("/").pop())}</button>` : ""}
        <span class="row">${t.done ? `<button type="button" data-todo="todoundo">Undo</button>`
          : `<button type="button" class="tedit-open">Edit</button><button type="button" data-todo="tododone">Done</button><button type="button" data-todo="todoqueue">Queue it</button><button type="button" data-todo="todonode">Make node</button>`}</span>
      </li>`);
    if (!rows.length) return "";
    const head = todoScope === null ? `<div class="sec-head"><button class="child" type="button" data-reveal="${esc(g.path)}">${esc(g.title)}</button></div>` : "";
    return `${head}<ol>${rows.join("")}</ol>`;
  }).join("");
  if (todoScope !== null) {
    const tab = panel.querySelector(".tabbody");
    if (!tab || panelTab !== "todo") return;
    tab.innerHTML = `
      <section class="queue todo">
        <div class="sec-head"><span>Todo</span><label><input type="checkbox" class="tshowdone"${todoDone ? " checked" : ""}> Show done</label></div>
        ${lists || `<div class="none">No parked ideas</div>`}
        <form class="qadd tadd"><input name="idea" placeholder="Park an idea." autocomplete="off" required><button type="submit">Add</button></form>
        <p class="todo-err" hidden></p>
      </section>`;
    return markRow();
  }
  editing = true;
  panel.innerHTML = `
    <div class="top"><button class="back" type="button">← ${esc(panelNode.title)}</button><span><label><input type="checkbox" class="tshowdone"${todoDone ? " checked" : ""}> Show done</label> <button class="close" type="button">Close</button></span></div>
    <p class="kicker">every node</p>
    <h1>Todo</h1>
    <section class="queue todo">
      ${lists || `<div class="none">No parked ideas</div>`}
      <button class="tnew" type="button">New idea</button>
      <p class="todo-err" hidden></p>
    </section>`;
}

const todoError = (msg) => Object.assign(panel.querySelector(".todo-err"), { textContent: msg, hidden: false });

// Turns an idea's text into an input. Enter saves it; Escape puts the list back.
function editIdea(li) {
  const text = li.querySelector(".text");
  text.innerHTML = `<form class="tedit"><input name="idea" value="${esc(text.textContent)}" autocomplete="off" required></form>`;
  const input = text.querySelector("input");
  input.focus();
  input.select();
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    renderTodos();
  });
}

async function todoAction(button) {
  const { path, n } = button.closest("li").dataset;
  try {
    const out = await post(button.dataset.todo, { path, n: Number(n) });
    if (out.path) {
      if (path !== graphRoot.data.path) expanded.add(path); // unpack the parent so the new child shows
      writeExpanded();
      await load();
    }
  } catch (err) {
    return todoError(err.message);
  }
  renderTodos();
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
  const host = panel.querySelector(".where")?.value ?? "";
  const q = `path=${encodeURIComponent(selected)}${resume ? "&resume=1" : ""}${host ? `&host=${encodeURIComponent(host)}` : ""}`;
  const res = await fetch(`/api/launch?${q}`, { method: "POST" });
  const body = await res.json();
  if (!res.ok) return alertInPanel(body.error);
  await load();
  openTerminal(body.tmux, selected, body.host);
}

const lockKey = (path) => {
  const d = byPath.get(path)?.data;
  return d?.lock === undefined ? "" : JSON.stringify([d.lock, d.round, d.sessions.map((s) => [s.tmux, s.state, s.done])]);
};

// A node in a consolidation round is locked. The round's own node says how the round is going
// and offers Accept (commit the subtree) and Reject (put it back as it was).
function roundBanner(path) {
  const d = byPath.get(path)?.data;
  if (d?.lock === undefined) return "";
  if (!d.round) return `<div class="round"><p>Locked while ${esc(d.lock || "/")} consolidates.</p></div>`;
  const s = d.sessions.find((x) => x.tmux === d.round.tmux);
  const state = !s ? "Session ended" : s.done ? "Ready to review" : s.state === "working" ? "Consolidating…" : "Waiting on you";
  return `<div class="round">
    <p><strong>${state}</strong> · ${d.round.changed} file${d.round.changed === 1 ? "" : "s"} changed</p>
    <div class="row">
      ${s ? `<button type="button" data-watch="${esc(s.tmux)}">Open session</button>` : ""}
      <button type="button" data-finish="accept">Accept</button>
      <button type="button" data-finish="reject">Reject</button>
    </div>
  </div>`;
}

// Reject throws away the round's changes, so it needs a second click.
async function finishRound(button) {
  const accept = button.dataset.finish === "accept";
  if (!accept && !button.classList.contains("armed")) {
    button.classList.add("armed");
    button.textContent = "Sure? Reverts all changes";
    setTimeout(() => {
      button.classList.remove("armed");
      button.textContent = "Reject";
    }, 3000);
    return;
  }
  const d = byPath.get(selected)?.data;
  const s = d?.sessions.find((x) => x.tmux === d.round?.tmux);
  if (s && isOpen(s)) closeTerminal();
  try {
    await post("finish", { path: selected, accept });
  } catch (err) {
    return alertInPanel(err.message);
  }
  await load();
}

// Consolidation commits ~/nodes and starts a session that rewrites the subtree, so it asks first.
const consolidator = document.getElementById("consolidator");
function confirmConsolidate(path) {
  consolidator.dataset.path = path;
  consolidator.querySelector(".what").textContent = `Consolidate ${path || "/"}? Orca commits the node tree first, then starts a session that proposes archives and moves under this node. Nothing changes until you approve its proposal.`;
  consolidator.returnValue = "";
  consolidator.showModal();
}
consolidator.addEventListener("close", async () => {
  if (consolidator.returnValue !== "go") return;
  const path = consolidator.dataset.path;
  try {
    const { tmux } = await post("consolidate", { path });
    await load();
    openTerminal(tmux, path);
  } catch (err) {
    alertInPanel(err.message);
  }
});

async function openShell(path) {
  try {
    const { tmux } = await post("shell", { path });
    await load();
    openTerminal(tmux, path);
  } catch (err) {
    alertInPanel(err.message);
  }
}

// Ending quits Claude; the conversation stays on disk for Resume. A session that is still
// working or waiting on you, or whose node's repo has uncommitted files, needs a second click.
async function endSession(button) {
  const { end: id, archive } = button.dataset;
  if (!button.classList.contains("armed")) {
    const { count } = await fetch(`/api/uncommitted?session=${encodeURIComponent(id)}`).then((r) => r.json()).catch(() => ({}));
    if (count || ["working", "needs"].includes(button.dataset.state)) {
      const text = button.textContent;
      button.classList.add("armed");
      button.textContent = count ? `${count} uncommitted · end?` : "Sure?";
      setTimeout(() => {
        button.classList.remove("armed");
        button.textContent = text;
      }, 3000);
      return;
    }
  }
  return end(id, !!archive);
}

async function end(id, archive = false) {
  const s = sessionsIn(tree).find((x) => x.sessionId === id);
  if (s && isOpen(s)) closeTerminal();
  try {
    await post("end", { session: id, archive });
  } catch (err) {
    return alertInPanel(err.message);
  }
  await load();
  panelText = "";
  if (selected !== null) refreshPanel();
}

const alertInPanel = (msg) => Object.assign(panel.querySelector(".alert"), { textContent: msg, hidden: false });

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
// The node field of Dispatch and Todo. `null` shows "anywhere"; × clears to it, where a form has one.
function showNode(form, p) {
  const field = form.querySelector(".nodefield");
  field.querySelector("b").textContent = p === null ? "Anywhere in the tree" : byPath.get(p)?.data.title ?? (p || "/");
  field.querySelector("small").textContent = p === null ? "" : p || "/";
  const clear = field.querySelector(".clear");
  if (clear) clear.hidden = p === null;
}

let dispatchScope = ""; // the parent: the node in view, until cleared; "" is the whole tree
function setScope(p) {
  dispatchScope = p;
  showNode(dispatchForm, p || null);
}
dispatchForm.querySelector(".pick").addEventListener("click", () => openPalette((p) => {
  setScope(p);
  dispatchForm.prompt.focus();
}));
dispatchForm.querySelector(".clear").addEventListener("click", () => {
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

// ---- Todo capture: ⌥T from anywhere parks an idea in a node's TODO.md, the node in view by default ----

const todoer = document.getElementById("todoer");
const todoForm = todoer.querySelector("form");
let todoTarget = "";
function setTodoTarget(p) {
  todoTarget = p;
  showNode(todoForm, p);
}
function openTodoer() {
  if (todoer.open || !tree) return;
  todoForm.reset();
  setTodoTarget(hereNode());
  todoForm.querySelector(".err").hidden = true;
  todoer.showModal();
  todoForm.idea.focus();
}
todoForm.querySelector(".pick").addEventListener("click", () => openPalette((p) => {
  setTodoTarget(p);
  todoForm.idea.focus();
}));
todoForm.querySelector(".cancel").addEventListener("click", () => todoer.close());
todoForm.querySelector(".viewall").addEventListener("click", () => {
  todoer.close();
  openTodos(null);
});
todoForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await post("todo", { path: todoTarget, idea: todoForm.idea.value });
  } catch (err) {
    const el = todoForm.querySelector(".err");
    el.textContent = err.message;
    el.hidden = false;
    return;
  }
  todoer.close();
  if (panel.querySelector(".todo")) renderTodos(); // a list is open: show the new idea
});

// ⌥Q ends the current rail session, as its End button does, once Enter confirms.
const ender = document.getElementById("ender");
async function confirmEnd() {
  const row = railRows().find(isCurrent);
  if (!row || ender.open) return;
  const s = sessionsIn(tree).find((x) => x.sessionId === row.dataset.sid);
  const { count } = await fetch(`/api/uncommitted?session=${encodeURIComponent(row.dataset.sid)}`).then((r) => r.json()).catch(() => ({}));
  ender.dataset.sid = row.dataset.sid;
  ender.dataset.archive = s?.done ? "1" : "";
  ender.querySelector(".what").textContent = `End ${row.querySelector(".name").textContent}?${count ? ` Its repo has ${count} uncommitted files.` : ""}`;
  ender.querySelector('[value="end"]').textContent = s?.done ? "End + archive" : "End session";
  ender.returnValue = "";
  ender.showModal();
}
ender.addEventListener("close", () => {
  if (ender.returnValue !== "end") return;
  ender.dataset.sid ? end(ender.dataset.sid, !!ender.dataset.archive) : endAll();
});

// End all, at the foot of the rail: ends every session, background and child ones too, and
// closes every shell, so their memory goes back to the machine. Conversations stay for Resume.
document.getElementById("endall").addEventListener("click", () => {
  ender.dataset.sid = "";
  ender.querySelector(".what").textContent = `End all ${sessionsIn(tree).length} sessions and close ${shells.length} shells?`;
  ender.querySelector('[value="end"]').textContent = "End all";
  ender.returnValue = "";
  ender.showModal();
});

async function endAll() {
  if (term) closeTerminal(false);
  await Promise.all([
    ...sessionsIn(tree).map((s) => post("end", { session: s.sessionId }).catch(() => {})),
    ...shells.map((sh) => post("closeshell", { tmux: sh.tmux }).catch(() => {})),
  ]);
  await load();
  if (selected !== null) refreshPanel();
}

const keyhelp = document.getElementById("keyhelp");
document.getElementById("keys").addEventListener("click", () => keyhelp.showModal());

// ---- Palette: ⇧⌘P finds any node by name and opens its panel; ⌘Enter resumes it. A ">" prefix lists commands instead. ----

const palette = document.getElementById("palette");
const paletteInput = palette.querySelector("input");
const paletteList = palette.querySelector("ol");
// The current node: the open terminal's, else the selected one, else the map's root.
const hereNode = () => term?.path ?? selected ?? graphRoot.data.path;
const COMMANDS = [ // { name, run }
  { name: "Open shell", run: () => openShell(hereNode()) },
  { name: "New todo", run: () => openTodoer() },
  { name: "Open todo", run: () => openTodos(hereNode()) },
  { name: "All todos", run: () => openTodos(null) },
  { name: "Restart orca", run: () => restartOrca() },
];
let paletteItems = [];
let paletteAt = 0;

// With `pick`, the palette finds a node for another dialog and hands its path to `pick`.
let palettePick = null;
function openPalette(pick = null) {
  if (palette.open || !tree) return;
  palettePick = pick;
  paletteInput.placeholder = pick ? "Find a node" : "Find a node · ↵ open · ⌘↵ resume · > for commands";
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
  const commands = !palettePick && q.startsWith(">");
  if (commands) {
    const c = q.slice(1).trim();
    paletteItems = [...COMMANDS, ...tailnetCommands()].filter((x) => x.name.toLowerCase().includes(c)).map((x) => ({ label: x.name, run: x.run }));
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
        run: () => (palettePick ?? openNode)(d.data.path),
        alt: palettePick ? null : () => resumeNode(d.data.path),
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

// `alt` is ⌘Enter: resume the node's session instead of opening its panel.
function pickPalette(i, alt = false) {
  const item = paletteItems[i];
  if (!item) return;
  palette.close();
  (alt && item.alt ? item.alt : item.run)();
}

async function openNode(path) {
  if (term) closeTerminal(false);
  reveal(path);
  await select(path);
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
    pickPalette(paletteAt, e.metaKey);
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
  setting("notify").checked = notify && Notification.permission === "granted";
  setting("tailnet").checked = showTailnet;
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
// Turning notifications on asks the browser for permission; a refusal turns the switch back off.
setting("notify").addEventListener("change", async (e) => {
  if (!e.target.checked || Notification.permission === "granted") return;
  if ((await Notification.requestPermission()) === "granted") return;
  e.target.checked = false;
  settings.querySelector(".notify-note").textContent = "The browser blocks notifications for this page. Allow them in the site settings (the icon left of the address), then turn this on.";
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
  showTailnet = setting("tailnet").checked;
  try { localStorage.setItem("orca.noTailnet", showTailnet ? "0" : "1"); } catch {}
  loadTailnet();
  notify = setting("notify").checked;
  try { localStorage.setItem("orca.notify", notify ? "1" : "0"); } catch {}
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
  if (e.target.matches(".tedit")) {
    const { path, n } = e.target.closest("li").dataset;
    try {
      await post("todoedit", { path, n: Number(n), idea: e.target.idea.value });
    } catch (err) {
      return todoError(err.message);
    }
    return renderTodos();
  }
  if (e.target.matches(".tadd")) {
    try {
      await post("todo", { path: todoScope ?? "", idea: e.target.idea.value });
    } catch (err) {
      return todoError(err.message);
    }
    return renderTodos();
  }
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
    if (e.key === "Escape" || (e.metaKey && (e.key === "." || e.key === "k" || e.code === "KeyP")) || (e.altKey && (e.key === "Tab" || e.code === "KeyQ" || e.code === "KeyT"))) e.stopPropagation();
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
    if (e.code === "KeyT" && e.altKey) {
      e.preventDefault();
      if (e.type === "keydown") openTodoer();
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
  if (!watch) xterm.onData((d) => {
    // A result counts as read once you type a reply. Escape sequences (focus reports, arrow keys) do not count.
    if (!d.startsWith("\x1b")) markSeen(sessionsIn(tree).filter((s) => isOpen(s)));
    send(d);
  });
  const ro = new ResizeObserver(resize);
  ro.observe(el);
  term = { xterm, ws, ro, name, path, host, watch };
  lastTerm = { name, path, host };
  renderRail();
  xterm.focus();
}

function termTheme() {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  return { background: v("--paper-2"), foreground: v("--ink"), cursor: v("--ink"), selectionBackground: v("--ink-3") };
}

termview.querySelector(".takeover").addEventListener("click", () => openTerminal(term.name, term.path, term.host));
termview.querySelector(".docsdir").addEventListener("click", (e) => {
  popout(e.currentTarget, term.path, "finder");
  term.xterm.focus(); // keep typing in the session
});

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
  if (e.target.closest(".newtodo")) openTodoer();
  const tab = e.target.closest("[data-tab]");
  if (tab) setTab(tab.dataset.tab);
  if (e.target.closest(".tedit-open")) editIdea(e.target.closest("li"));
  if (e.target.closest(".tnew")) openTodoer();
  const todo = e.target.closest("[data-todo]");
  if (todo) todoAction(todo);
  if (e.target.matches(".tshowdone")) {
    todoDone = e.target.checked;
    renderTodos();
  }
  if (e.target.closest(".launch")) launchSession(false);
  if (e.target.closest(".resume")) launchSession(true);
  if (e.target.closest(".shell")) openShell(selected);
  if (e.target.closest(".consolidate")) confirmConsolidate(selected);
  const finish = e.target.closest("[data-finish]");
  if (finish) finishRound(finish);
  const watch = e.target.closest("[data-watch]");
  if (watch) openTerminal(watch.dataset.watch, selected);
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

// Keys for the open panel, while nothing takes typing. Returns whether it used the key.
const PANEL_KEYS = { r: ".resume", l: ".launch", s: ".shell", n: '[data-form="child"]', t: ".newtodo", e: '[data-form="edit"]' };
// What Enter opens in a row: a child's panel, a doc, a session's terminal, a todo's node.
const ROW_OPEN = "[data-reveal], [data-doc], .attach";

function panelKey(k) {
  if (PANEL_KEYS[k]) {
    panel.querySelector(PANEL_KEYS[k])?.click();
    return true;
  }
  if (k >= "1" && k <= String(TABS.length)) {
    setTab(TABS[k - 1]);
    return true;
  }
  if (k === "[" || k === "]") {
    setTab(TABS[(TABS.indexOf(panelTab) + (k === "]" ? 1 : TABS.length - 1)) % TABS.length]);
    return true;
  }
  if (["j", "k", "ArrowDown", "ArrowUp"].includes(k)) {
    const rows = panelRows();
    if (rows.length) panelRow = (panelRow + (k === "j" || k === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
    markRow();
    return true;
  }
  if (k === "Enter") {
    const open = panelRows()[panelRow]?.querySelector(ROW_OPEN);
    open?.click();
    return !!open;
  }
  if (k === "Backspace") {
    const up = byPath.get(selected)?.parent?.data.path;
    if (up !== undefined) {
      reveal(up);
      select(up);
    }
    return true;
  }
  return false;
}

const panelRows = () => [...panel.querySelectorAll(".tabbody li")];

function markRow() {
  panelRows().forEach((li, i) => li.classList.toggle("on", i === panelRow));
  panelRows()[panelRow]?.scrollIntoView({ block: "nearest" });
}

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
document.getElementById("todos").addEventListener("click", () => openTodoer());
addEventListener("resize", () => relayout(0));
addEventListener("keydown", (e) => {
  if (e.key === "k" && e.metaKey) {
    e.preventDefault();
    return openDispatch();
  }
  if (e.code === "KeyP" && e.metaKey && e.shiftKey) {
    e.preventDefault();
    // In Dispatch or Todo, it picks the node of that dialog.
    const pick = [dispatcher, todoer].find((d) => d.open)?.querySelector(".pick");
    return pick ? pick.click() : openPalette();
  }
  if (dispatcher.open || todoer.open || ender.open || keyhelp.open || settings.open || palette.open) return; // the dialogs handle their own Escape
  if (e.code === "KeyT" && e.altKey) {
    e.preventDefault();
    return openTodoer();
  }
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
  if (selected !== null && !term && !typing && !editing && !e.metaKey && !e.ctrlKey && !e.altKey && panelKey(e.key)) return e.preventDefault();
  if (e.key !== "Escape" || term) return;
  if (editing) return closeForm();
  if (selected !== null) closePanel();
});

// ---- Plan usage ----

// Same windows as the Hammerspoon panel: 5h counts down to its reset, the week names the reset day.
// One "Switch tailnet" command per other Tailscale account, while the tailnet is shown.
let tailnetProfiles = [];
function tailnetCommands() {
  if (!showTailnet) return [];
  return tailnetProfiles.filter((p) => !p.selected).map((p) => ({ name: `Switch tailnet: ${p.tailnet}`, run: () => switchTailnet(p.id) }));
}

async function switchTailnet(id) {
  net.innerHTML = "<b>tailnet</b>switching…";
  await fetch(`/api/tailnet/switch?id=${encodeURIComponent(id)}`, { method: "POST" }).catch(() => {});
  loadTailnet().then(loadUsage);
}

// The usage card shows the progress until the new server answers, then goes back to usage.
async function restartOrca() {
  const el = document.getElementById("usage");
  el.textContent = "restarting orca…";
  const ok = await fetch("/api/restart", { method: "POST" }).then((r) => r.ok, () => false);
  if (!ok) return (el.textContent = "restart failed");
  // Give the old server time to exit, so the poll does not reach it.
  await new Promise((r) => setTimeout(r, 1000));
  while (!(await fetch("/api/usage").then((r) => r.ok, () => false))) await new Promise((r) => setTimeout(r, 500));
  el.textContent = "orca restarted";
  setTimeout(loadUsage, 3000);
}

// The tailnet leads the usage card. "Running" shows its name; anything else shows the state, in the accent.
const net = document.createElement("span");
async function loadTailnet() {
  net.hidden = !showTailnet;
  if (!showTailnet) return;
  const t = await fetch("/api/tailnet").then((r) => r.json()).catch(() => ({ state: "unavailable" }));
  tailnetProfiles = t.profiles ?? [];
  const up = t.state === "Running";
  net.className = up ? "" : "hot";
  net.title = t.login ? `Tailscale: ${t.login}` : "Tailscale";
  net.innerHTML = `<b>tailnet</b>${esc(up ? t.tailnet ?? "?" : t.state.toLowerCase())}`;
}

async function loadUsage() {
  const el = document.getElementById("usage");
  const u = await fetch("/api/usage").then((r) => r.json()).catch(() => ({ error: "unavailable" }));
  if (u.error) return el.replaceChildren(net, `usage ${u.error}`);
  const left = (t) => {
    const m = Math.max(0, Math.round((new Date(t) - Date.now()) / 60000));
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
  };
  const day = (t) => new Date(t).toLocaleString([], { weekday: "short", hour: "numeric" });
  const who = Object.assign(document.createElement("span"), { className: "who", textContent: u.email ?? "not logged in" });
  el.replaceChildren(net, who, ...[["5h", u.five_hour, left], ["wk", u.seven_day, day]].filter(([, w]) => w).map(([label, w, when]) => {
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
loadTailnet().then(loadUsage);
setInterval(() => loadTailnet().then(loadUsage), 60_000);
