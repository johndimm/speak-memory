// Renders the summarization node graph as an SVG. Nodes are laid out in rows by level (Life at
// top, Days/Memories at the bottom); edges connect a parent to the children it summarizes.
// Dirty nodes glow, the node summarizing right now pulses, and the subtree you're viewing (the
// "spine") is drawn brighter. At scale, clean off-spine nodes in a crowded row collapse into a
// single count bubble so the action stays legible.

const ROW = { life: 0, decade: 1, category: 1, year: 2, subject: 2, month: 3, week: 4, day: 5, memory: 5 };
const ROW_LABELS = ["Life", "Decade · Category", "Year · Subject", "Month", "Week", "Day · Memory"];
const N_ROWS = 6;
const R = { life: 13, decade: 9, category: 9, year: 8, subject: 8, month: 7, week: 6, day: 5, memory: 5 };
const ALWAYS_LABELED = new Set(["life", "decade", "category", "month", "week"]); // structural — always shown
const HOVER_LABELED = new Set(["year", "subject", "day", "memory"]); // crowded rows — shown on hover (name is in the tap-preview on touch)

const VW = 1000, MARGIN_X = 70, TOP = 54, ROW_GAP = 98, MAX_PER_ROW = 40;

function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function trunc(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + "…" : s; }

export function renderGraphSvg(snapshot) {
  const raw = (snapshot && snapshot.nodes) || [];
  if (!raw.length) return `<p class="graph-empty">Nothing to summarize yet — add an entry or a memory.</p>`;

  // One memory per subject is the norm (a subject IS its single memory). Drop that subject node and
  // wire its category straight to the memory LEAF, so each girlfriend shows as one leaf node at the
  // bottom — tied up to its category (Girl Friends) and, via the calendar, its year.
  const rawById = new Map(raw.map((n) => [n.id, n]));
  const mergeInto = new Map(); // subjectId → its single memoryId
  for (const n of raw) {
    if (n.type !== "subject") continue;
    const mem = n.children.filter((c) => (rawById.get(c) || {}).type === "memory");
    if (mem.length === 1) mergeInto.set(n.id, mem[0]);
  }
  const remap = (id) => mergeInto.get(id) || id;
  const all = raw.filter((n) => !mergeInto.has(n.id))
    .map((n) => ({ ...n, children: [...new Set(n.children.map(remap).filter((c) => c !== n.id))] }));
  const byId = new Map(all.map((n) => [n.id, n]));

  // Parent lists, then the focus spine = the focused node + all its ancestors and descendants.
  const parents = new Map();
  for (const n of all) for (const c of n.children) { if (!parents.has(c)) parents.set(c, []); parents.get(c).push(n.id); }
  const spine = new Set();
  if (snapshot.focus && byId.has(snapshot.focus)) {
    const up = [snapshot.focus];
    while (up.length) { const id = up.pop(); if (spine.has(id)) continue; spine.add(id); for (const p of (parents.get(id) || [])) up.push(p); }
    const seen = new Set(), down = [snapshot.focus];
    while (down.length) { const id = down.pop(); if (seen.has(id)) continue; seen.add(id); spine.add(id); for (const c of ((byId.get(id) || {}).children || [])) down.push(c); }
  }

  // Group into rows by level, stable order within a row.
  const rows = Array.from({ length: N_ROWS }, () => []);
  for (const n of all) rows[ROW[n.type] ?? 5].push(n);
  // Order each row by its sort key so children cluster under their parent (memory-branch nodes,
  // grouped by category, on the left; the time branch chronologically on the right).
  const key = (n) => n.sort || n.id;
  for (const r of rows) r.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

  // Semantic zoom. Zoom further in and (a) a row shows more nodes before collapsing to a count
  // bubble, and (b) once close enough the crowded rows (year/subject/day/memory) reveal their
  // names too. Label text + offsets are scaled by 1/zoom so they hold a roughly constant ON-SCREEN
  // size — which is precisely what lets *more* of them fit, and appear, the further you zoom. At the
  // fit view (zoom 1) a normal life already shows in full.
  const zoom = Math.max(0.2, snapshot.zoom || 1);
  const maxPerRow = Math.max(12, Math.round(MAX_PER_ROW * 1.5 * zoom));
  const labeled = zoom >= 1.6 ? new Set([...ALWAYS_LABELED, ...HOVER_LABELED]) : ALWAYS_LABELED;
  const LS = 1 / Math.max(1, zoom); // label scale (viewBox units shrink as the SVG magnifies)

  // In a crowded row, keep dirty/active/spine nodes explicit and collapse the clean rest.
  const bubbleFor = new Map(); // collapsed node id → its bubble item
  const rowItems = rows.map((row, ri) => {
    if (row.length <= maxPerRow) return row.map((n) => ({ node: n }));
    const keep = row.filter((n) => n.dirty || n.active || spine.has(n.id));
    const collapsed = row.filter((n) => !(n.dirty || n.active || spine.has(n.id)));
    const items = keep.map((n) => ({ node: n }));
    if (collapsed.length) { const b = { bubble: true, members: collapsed, row: ri }; items.push(b); for (const n of collapsed) bubbleFor.set(n.id, b); }
    return items;
  });

  // Positions.
  const H = TOP * 2 + (N_ROWS - 1) * ROW_GAP;
  const pos = new Map();
  rowItems.forEach((items, ri) => {
    const y = TOP + ri * ROW_GAP;
    const n = items.length;
    items.forEach((it, i) => {
      const x = n === 1 ? VW / 2 : MARGIN_X + (VW - 2 * MARGIN_X) * (i / (n - 1));
      it.x = x; it.y = y;
      if (it.node) pos.set(it.node.id, { x, y });
      else it.pos = { x, y };
    });
  });
  const posOf = (id) => pos.get(id) || (bubbleFor.get(id) && bubbleFor.get(id).pos) || null;

  // Center each parent over its children so a category sits above its OWN subjects (and a decade
  // above its years). Bottom-up. A decade centers over its years only — not its memories, which
  // cluster with the category branch on the left — so the time axis stays chronological.
  const layoutKids = (n) => (n.type === "decade" ? n.children.filter((c) => c[0] === "Y") : n.children);
  for (let ri = N_ROWS - 2; ri >= 0; ri--) {
    for (const it of rowItems[ri]) {
      if (!it.node) continue;
      const ps = layoutKids(it.node).map((c) => posOf(c)).filter(Boolean);
      if (ps.length) { const nx = ps.reduce((s, p) => s + p.x, 0) / ps.length; it.x = nx; pos.set(it.node.id, { x: nx, y: it.y }); }
    }
  }

  // Greedy label placement: left→right, each always-shown label takes the LOWEST tier with room at
  // its x; if every tier is occupied there, it drops to hover-only (it.tier = -1). This guarantees
  // no two visible labels ever overlap, whatever the spacing. Widths are in viewBox units (the SVG
  // font scales with the graph), ~7 units per character.
  const CHAR_W = 7, GAP = 12, MAX_TIER = 5;
  for (const items of rowItems) {
    const labeledItems = items.filter((it) => it.node && labeled.has(it.node.type)).sort((a, b) => a.x - b.x);
    const tierRight = [];
    for (const it of labeledItems) {
      const w = Math.min(15, trunc(it.node.label, 15).length) * CHAR_W * LS;
      const left = it.x - w / 2;
      it.tier = -1;
      for (let t = 0; t < MAX_TIER; t++) {
        if ((tierRight[t] ?? -1e9) + GAP * LS <= left) { it.tier = t; tierRight[t] = it.x + w / 2; break; }
      }
    }
  }

  // Edges (curved, drawn behind the nodes). Dedup so many collapsed→bubble lines don't stack.
  let edges = ""; const seenEdge = new Set();
  for (const n of all) {
    if (bubbleFor.has(n.id)) continue; // n is inside a collapsed cluster — no edges
    const pp = posOf(n.id); if (!pp) continue;
    for (const c of n.children) {
      if (bubbleFor.has(c)) continue; // child is collapsed into a bubble — don't draw the hairball
      const cp = posOf(c); if (!cp || (cp.x === pp.x && cp.y === pp.y)) continue;
      const key = `${pp.x},${pp.y}>${cp.x},${cp.y}`; if (seenEdge.has(key)) continue; seenEdge.add(key);
      const child = byId.get(c);
      const cls = (n.active || (child && child.active)) ? " active" : (child && child.dirty) ? " dirty" : "";
      const my = (pp.y + cp.y) / 2;
      edges += `<path class="gedge${cls}" d="M${pp.x} ${pp.y} C ${pp.x} ${my}, ${cp.x} ${my}, ${cp.x} ${cp.y}"/>`;
    }
  }

  // Nodes + bubbles. Labels in a row are staggered onto two heights (with a lead line up to the
  // taller ones) so adjacent names — e.g. several girlfriends in the Subjects row — don't overlap.
  let dots = "";
  rowItems.forEach((items) => items.forEach((it, i) => {
    if (it.node) {
      const n = it.node, r = R[n.type] || 6;
      const cls = n.active ? "active" : n.dirty ? "dirty" : "clean";
      const spineCls = spine.has(n.id) ? " spine" : "";
      let label = "";
      const fs = (13 * LS).toFixed(2); // keep label text a ~constant on-screen size across zoom
      if (labeled.has(n.type) && (it.tier ?? -1) >= 0) {
        // Structural (or, when zoomed in, revealed) label placed on a free tier.
        const ly = it.y - r - (6 + it.tier * 15) * LS;
        const lead = it.tier ? `<line class="glabel-lead" x1="${it.x}" y1="${it.y - r - 2}" x2="${it.x}" y2="${ly + 4 * LS}"/>` : "";
        label = lead + `<text class="glabel" x="${it.x}" y="${ly}" style="font-size:${fs}px">${esc(trunc(n.label, 15))}</text>`;
      } else if (labeled.has(n.type) || HOVER_LABELED.has(n.type)) {
        // No room (or a crowded leaf not yet zoomed into) → name shows on hover/tap, nothing overlaps.
        label = `<text class="glabel hoveronly" x="${it.x}" y="${it.y - r - 6 * LS}" style="font-size:${fs}px">${esc(trunc(n.label, 24))}</text>`;
      }
      dots += `<g class="gnode ${cls}${spineCls}" data-node-id="${esc(n.id)}">`
        + `<circle cx="${it.x}" cy="${it.y}" r="${r}"><title>${esc(n.label)}</title></circle>`
        + label
        + `</g>`;
    } else {
      const anyDirty = it.members.some((m) => m.dirty || m.active);
      dots += `<g class="gnode bubble ${anyDirty ? "dirty" : "clean"}">`
        + `<circle cx="${it.x}" cy="${it.y}" r="16"/>`
        + `<text class="gcount" x="${it.x}" y="${it.y + 4}">${it.members.length}</text>`
        + `</g>`;
    }
  }));

  // Fit the viewBox to the actual drawn nodes instead of the full fixed 1000-wide canvas —
  // otherwise a small/thin tree floats in a huge empty field (phones showed mostly blank space).
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  rowItems.forEach((items) => items.forEach((it) => {
    const r = it.node ? (R[it.node.type] || 6) : 16;
    minX = Math.min(minX, it.x - r); maxX = Math.max(maxX, it.x + r);
    minY = Math.min(minY, it.y - r); maxY = Math.max(maxY, it.y + r);
  }));
  if (!isFinite(minX)) { minX = 0; maxX = VW; minY = 0; maxY = H; }
  // Padding: a left gutter wide enough for the row captions ("Decade · Category"), room for node
  // labels that overhang sideways, and space above the top row for the stacked label tiers.
  const GUTTER = 150, PAD_X = 74, PAD_TOP = 80, PAD_BOTTOM = 46;
  const vbX = minX - GUTTER, vbY = minY - PAD_TOP;
  const vbW = maxX + PAD_X - vbX, vbH = maxY + PAD_BOTTOM - vbY;

  // Row captions, pinned to the cropped left edge so they ride along with the content.
  let rowLabels = "";
  ROW_LABELS.forEach((lbl, ri) => { if (rows[ri].length) rowLabels += `<text class="grow-label" x="${vbX + 10}" y="${TOP + ri * ROW_GAP + 3}" style="font-size:${(12 * LS).toFixed(2)}px">${esc(lbl)}</text>`; });

  return `<svg class="graph-svg" viewBox="${vbX} ${vbY} ${vbW} ${vbH}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Summarization graph">${edges}${dots}${rowLabels}</svg>`;
}
