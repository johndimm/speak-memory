// Shared rendering for summary bodies: a nested outline if the text is bullet lines,
// otherwise prose paragraphs. Used by both the Journal detail and the Write editor.

export function escapeHtml(t) {
  return String(t)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---- Entity tokens ------------------------------------------------------------------------
// Summaries store references to individuals as {{e:<id>|<Name>}} instead of a literal name, so a
// rename/spelling-fix/merge updates every summary at render time with no re-summarization. The map
// (id → canonical name) is kept in memory and refreshed when entities change; an unknown/bad id
// falls back to the name embedded in the token, so text never renders worse than plain names.
let entityMap = new Map();
export function setEntityMap(idToName) {
  entityMap = idToName instanceof Map ? idToName : new Map(Object.entries(idToName || {}));
}
// Match {{e:<id>|<Name>}} — and tolerate the model dropping the "e:" prefix ({{<id>|<Name>}}).
// The id is restricted to token-safe chars so this never swallows ordinary braces in prose.
const ENTITY_TOKEN = /\{\{(?:e:)?([A-Za-z0-9_:-]+)(?:\|([^{}]*))?\}\}/g;
// Resolve one token's id to {id, name} from the registry, tolerating the model splitting an "e"-
// prefixed id (writing {{e:1|…}} for id "e1"): try the id as-is, then with an "e" restored.
function lookupEntity(id) {
  const k = String(id).trim();
  if (entityMap.has(k)) return { id: k, name: entityMap.get(k) };
  if (entityMap.has("e" + k)) return { id: "e" + k, name: entityMap.get("e" + k) };
  return null;
}
// Plain-text resolution (for textContent, tooltips): token → canonical name (or the fallback name).
export function resolveEntityTokens(text) {
  const s = String(text ?? "");
  if (s.indexOf("{{") === -1) return s;
  return s.replace(ENTITY_TOKEN, (_, id, name) => (lookupEntity(id)?.name) || (name || "").trim() || "");
}
// Link resolution (for rendered HTML): token → a tappable name that opens the entity's page. The
// tokens survive escapeHtml (they contain no &<>"), so call this on already-escaped HTML. A known id
// becomes a button; an unknown id falls back to plain text (no page to open).
export function resolveEntityLinks(html) {
  const s = String(html ?? "");
  if (s.indexOf("{{") === -1) return s;
  return s.replace(ENTITY_TOKEN, (_, id, name) => {
    const hit = lookupEntity(id);
    const label = escapeHtml((hit && hit.name) || (name || "").trim() || "");
    if (!label) return "";
    return hit
      ? `<button type="button" class="ent-link" data-eid="${escapeHtml(hit.id)}">${label}</button>`
      : label;
  });
}

export function isOutlineText(text) {
  return /^\s*-\s+/m.test(String(text));
}

const REP_LABEL = { outline: "Outline", prose: "Prose", verbatim: "Verbatim" };

function proseParagraphs(text) {
  return String(text || "").replace(/\r/g, "").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
}

// Best-matching prose paragraph for an outline item, by shared significant words.
function refFor(itemText, proseParas) {
  const toks = (s) => new Set(String(s).toLowerCase().match(/[a-z']{4,}/g) || []);
  const it = toks(itemText);
  if (it.size < 2) return -1;
  let best = -1, bestScore = 0;
  proseParas.forEach((p, i) => {
    const pt = toks(p);
    let overlap = 0;
    for (const w of it) if (pt.has(w)) overlap++;
    if (overlap > bestScore) { bestScore = overlap; best = i; }
  });
  return bestScore >= 2 ? best : -1; // need a couple of shared words to claim a link
}

// Parse outline text into nodes, tagging each bullet with its display level, whether it's a LEAF
// (no deeper-indented child follows), and whether that leaf is a PARAGRAPH (a few sentences) rather
// than a short label — so leaves can be rendered as readable prose.
function parseOutline(raw) {
  const nodes = [];
  for (const line of String(raw).replace(/\r/g, "").split("\n")) {
    const m = line.match(/^(\s*)-\s+(.*)$/);
    if (m) {
      const depth = Math.floor(m[1].replace(/\t/g, "  ").length / 2) + 1;
      nodes.push({ kind: "item", depth, level: Math.min(3, depth), text: m[2] });
    } else if (line.trim()) nodes.push({ kind: "text", text: line.trim() });
  }
  nodes.forEach((n, i) => {
    if (n.kind !== "item") return;
    const next = nodes.slice(i + 1).find((x) => x.kind === "item");
    n.leaf = !next || next.depth <= n.depth;
    n.para = n.leaf && (n.text.length > 100 || (n.text.match(/[.!?](\s|$)/g) || []).length >= 2);
  });
  return nodes;
}

// Outline where short leaf labels link (by data-ref) into the prose paragraphs. Paragraph leaves
// already carry the detail, so they aren't linked.
function renderOutlineLinked(text, proseParas) {
  const raw = String(text).replace(/\r/g, "");
  if (!isOutlineText(raw)) return renderFull(raw);
  let out = '<div class="outline">';
  for (const n of parseOutline(raw)) {
    if (n.kind === "text") { out += `<div class="ol-text">${escapeHtml(n.text)}</div>`; continue; }
    const ref = n.para ? -1 : refFor(n.text, proseParas);
    const linked = ref >= 0 ? ` ol-linked" data-ref="${ref}` : "";
    out += `<div class="ol-item ol-l${n.level}${n.leaf ? " ol-leaf" : ""}${n.para ? " ol-para" : ""}${linked}">${escapeHtml(n.text)}</div>`;
  }
  return resolveEntityLinks(out + "</div>");
}

// Render an entry's representations: the first is shown, the rest fold away (on demand).
// Shared by the Journal detail and the Write edit view.
export function renderReps(reps, leadingHtml = "") {
  const order = ["outline", "prose", "verbatim"]; // outline is the starting point (detail on its leaves)
  const present = order.filter((m) => reps?.[m]);
  if (present.length <= 1) return leadingHtml + renderFull(present.length ? reps[present[0]] : "");

  const proseParas = proseParagraphs(reps.prose);
  // Render each rep the same whether it's shown open or folded, so the outline→prose
  // links keep working regardless of order (prose paragraphs carry data-p indices).
  const bodyFor = (m) => {
    if (m === "prose") return resolveEntityLinks(proseParas.map((p, idx) => `<p data-p="${idx}">${escapeHtml(p)}</p>`).join(""));
    if (m === "outline") return renderOutlineLinked(reps.outline, proseParas);
    return renderFull(reps[m]); // verbatim has no tokens; renderFull passes it through
  };
  let html = leadingHtml;
  present.forEach((m, i) => {
    // Every rep is a collapsible fold; the first just starts open. (It used to be a plain
    // heading, so clicking it — unlike the others — did nothing.)
    const cls = m === "prose" ? "rep-fold rep-prose" : "rep-fold";
    html += `<details class="${cls}"${i === 0 ? " open" : ""}><summary class="rep-heading">${REP_LABEL[m]}</summary>${bodyFor(m)}</details>`;
  });
  return html;
}

// Wire outline→prose links inside a container (call once; uses event delegation).
export function wireReps(container) {
  container.addEventListener("click", (e) => {
    const item = e.target.closest(".ol-linked[data-ref]");
    if (!item || !container.contains(item)) return;
    const details = container.querySelector(".rep-prose");
    if (details) details.open = true;
    const para = container.querySelector(`[data-p="${item.dataset.ref}"]`);
    if (para) {
      para.scrollIntoView({ behavior: "smooth", block: "center" });
      para.classList.add("rep-hl");
      setTimeout(() => para.classList.remove("rep-hl"), 1600);
    }
  });
}

// Nest the flat parseOutline list into a tree by depth.
function outlineTree(nodes) {
  const roots = [];
  const stack = [];
  for (const n of nodes) {
    if (n.kind !== "item") continue; // stray text lines are dropped from the compressed view
    const node = { ...n, children: [] };
    while (stack.length && stack[stack.length - 1].depth >= n.depth) stack.pop();
    (stack.length ? stack[stack.length - 1].children : roots).push(node);
    stack.push(node);
  }
  return roots;
}

// A compressed, drill-down outline: the top-level nodes show right away, and any node with
// children is a collapsible <details> you open to drill in. Leaves render as plain items.
export function renderOutlineTree(text) {
  const raw = String(text).replace(/\r/g, "");
  if (!isOutlineText(raw)) return renderFull(raw);
  // `path` is a stable index chain ("0", "0.2", …) so a caller can save/restore which nodes are open.
  const render = (node, path) => {
    const cls = `ol-item ol-l${node.level}${node.leaf ? " ol-leaf" : ""}${node.para ? " ol-para" : ""}`;
    if (!node.children.length) return `<div class="${cls}">${escapeHtml(node.text)}</div>`;
    return `<details class="ol-node" data-ol-key="${path}"><summary class="${cls} ol-branch">${escapeHtml(node.text)}</summary>`
      + `<div class="ol-children">${node.children.map((c, i) => render(c, path + "." + i)).join("")}</div></details>`;
  };
  return resolveEntityLinks(`<div class="outline outline-tree">${outlineTree(parseOutline(raw)).map((n, i) => render(n, String(i))).join("")}</div>`);
}

export function renderFull(text) {
  // Keep entity tokens through escaping, then turn them into tappable name-links at the end.
  const raw = String(text).replace(/\r/g, "");
  if (!isOutlineText(raw)) {
    return resolveEntityLinks(raw.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${escapeHtml(p)}</p>`).join(""));
  }
  let out = '<div class="outline">';
  for (const n of parseOutline(raw)) {
    if (n.kind === "text") out += `<div class="ol-text">${escapeHtml(n.text)}</div>`;
    else out += `<div class="ol-item ol-l${n.level}${n.leaf ? " ol-leaf" : ""}${n.para ? " ol-para" : ""}">${escapeHtml(n.text)}</div>`;
  }
  return resolveEntityLinks(out + "</div>");
}
