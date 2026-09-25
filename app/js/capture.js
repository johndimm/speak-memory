// Live capture — the shared "watch me write" layer for every input surface (Diary, Memoire, Me, a
// Name). It attaches to an existing <textarea> and, as you type OR dictate:
//   1) COLORS the text in place — names in one color, prompt answers (years/places/categories) in
//      another — using the "highlight behind a transparent textarea" technique so the caret stays
//      native and the cursor never jumps.
//   2) grows a FOUND list of chips below, from two passes:
//        • an instant, free client-side pass (known names + unambiguous facts), and
//        • a debounced LLM pass (~1.1s after a pause) that catches NEW names / fuzzy answers.
// Nothing is persisted here — this is a live preview; the real entity/summary pipeline runs on save.

import { getAllEntities } from "./db.js";
import { isSelfEntity } from "./self.js";

// Pronouns and first-person words never count as names, even if the self entity lists them as aliases.
const STOP_NAMES = new Set(["i", "me", "myself", "we", "us", "you", "he", "she", "it", "they", "him", "her", "them"]);

function llmOverrides() {
  const provider = localStorage.getItem("llm-provider") || "";
  if (!provider) return {};
  return { provider, apiKey: localStorage.getItem("llm-api-key") || "", model: localStorage.getItem("llm-model") || "", baseUrl: localStorage.getItem("llm-base-url") || "" };
}

// Default remote pass: named-individual extraction (people/places/orgs/things) → strings.
async function remoteNames(text, signal) {
  const r = await fetch("/api/summarize", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...llmOverrides(), mode: "entities", text }), signal,
  });
  if (!r.ok) throw new Error(`entities ${r.status}`);
  const j = await r.json();
  return { names: (j.mentions || []).map((m) => ({ name: m.name, kind: m.kind || "person" })) };
}

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const norm = (s) => String(s || "").toLowerCase().replace(/['’]s\b/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

// ---- Instant client-side extractors (see memoryvoice.js for the same idea) --------------------
const CAT_ALIASES = {
  home: "Homes", homes: "Homes", house: "Homes", apartment: "Homes",
  city: "Cities", cities: "Cities", town: "Cities",
  family: "Family", relationship: "Relationships", relationships: "Relationships", marriage: "Relationships",
  friend: "Friends", friends: "Friends",
  school: "Schools", schools: "Schools", college: "Schools", university: "Schools",
  job: "Jobs", jobs: "Jobs", work: "Jobs", career: "Jobs",
  vacation: "Vacations", vacations: "Vacations", trip: "Vacations", holiday: "Vacations",
  success: "Successes", successes: "Successes", failure: "Failures", failures: "Failures",
};
const YR = "(?:18|19|20)\\d{2}";

// Icons + labels for the Found chips, by type.
const CHIP_META = {
  name: { icon: "👤" }, when: { icon: "📅" }, where: { icon: "📍" },
  category: { icon: "🏷" }, subject: { icon: "✦" },
};

export function attachLiveCapture(textarea, {
  mount,                       // element to render the Found chips into
  buckets = ["names"],         // which kinds to surface: "names","when","where","category","subject"
  remote = remoteNames,        // debounced LLM pass; return { names?:[{name,kind}], facts?:[{type,value}] }
  debounceMs = 1100,
} = {}) {
  const wantNames = buckets.includes("names");
  const wantWhen = buckets.includes("when");
  const wantWhere = buckets.includes("where");
  const wantCat = buckets.includes("category");

  // ---- Build the highlight backdrop behind the textarea -------------------------------------
  const wrap = document.createElement("div");
  wrap.className = "cap-wrap";
  textarea.parentNode.insertBefore(wrap, textarea);
  const marks = document.createElement("div");
  marks.className = "cap-marks";
  marks.setAttribute("aria-hidden", "true");
  wrap.appendChild(marks);
  wrap.appendChild(textarea);         // textarea now sits on top of the backdrop
  textarea.classList.add("cap-input");

  // Copy the textarea's exact text metrics onto the backdrop so highlights line up perfectly.
  function syncStyles() {
    const cs = getComputedStyle(textarea);
    const props = ["fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "lineHeight",
      "textTransform", "textIndent", "wordSpacing", "tabSize",
      "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
      "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "borderRadius"];
    for (const p of props) marks.style[p] = cs[p];
    marks.style.borderStyle = "solid";
    marks.style.borderColor = "transparent"; // occupy the same box as the textarea's border
  }
  syncStyles();
  const ro = ("ResizeObserver" in window) ? new ResizeObserver(syncStyles) : null;
  ro && ro.observe(textarea);
  textarea.addEventListener("scroll", () => { marks.scrollTop = textarea.scrollTop; marks.scrollLeft = textarea.scrollLeft; });

  // ---- Known + discovered names ------------------------------------------------------------
  let nameIndex = [];          // [{re, canonical, kind}] built from known + discovered names
  let knownCache = [];         // entities loaded from the DB
  const discovered = new Map();// norm(name) -> {name, kind} found by the remote pass this session
  function rebuildIndex() {
    const seen = new Set();
    const rows = [];
    const add = (name, kind) => {
      const n = norm(name);
      if (!n || seen.has(n) || STOP_NAMES.has(n)) return;
      seen.add(n);
      rows.push({ re: new RegExp("\\b" + escRe(name.trim()) + "\\b", "gi"), canonical: name.trim(), kind: kind || "person" });
    };
    for (const e of knownCache) { add(e.canonical, e.entityKind); for (const a of (e.aliases || [])) add(a, e.entityKind); }
    for (const d of discovered.values()) add(d.name, d.kind);
    // Longer names first so "Agate House" wins over "Agate" when both are known.
    rows.sort((a, b) => b.canonical.length - a.canonical.length);
    nameIndex = rows;
  }

  // ---- Found chips (accumulate for this text) ----------------------------------------------
  const chips = new Map();     // key -> {type, label}
  const addChip = (type, label) => {
    if (!label) return false;
    if (type === "name") {
      const nl = norm(label);
      if (STOP_NAMES.has(nl)) return false;
      // Prefer the fuller name: skip a substring of one we already have; drop a shorter one it contains.
      for (const [k, c] of chips) {
        if (c.type !== "name") continue;
        const nc = norm(c.label);
        if (nc === nl) return false;
        if ((" " + nc + " ").includes(" " + nl + " ")) return false;              // "Tom" when we already have "Tom Waits"
        if ((" " + nl + " ").includes(" " + nc + " ")) chips.delete(k);           // "Tom Waits" supersedes "Tom"
      }
    }
    const key = type + ":" + norm(label);
    if (chips.has(key)) return false;
    chips.set(key, { type, label });
    return true;
  };
  function renderChips() {
    if (!mount) return;
    const items = [...chips.values()];
    mount.innerHTML = items.length
      ? `<span class="cap-found-label">Found</span>` + items.map((c) =>
          `<span class="cap-chip cap-chip-${c.type}">${CHIP_META[c.type]?.icon || ""} ${esc(c.label)}</span>`).join("")
      : "";
    mount.hidden = !items.length;
  }

  // ---- Compute highlight ranges over the current text --------------------------------------
  function ranges(text) {
    const out = [];
    if (wantNames) for (const row of nameIndex) { row.re.lastIndex = 0; let m; while ((m = row.re.exec(text))) { out.push({ start: m.index, end: m.index + m[0].length, cls: "cap-name" }); if (m.index === row.re.lastIndex) row.re.lastIndex++; } }
    if (wantWhen) { const re = new RegExp("\\b" + YR + "\\b", "g"); let m; while ((m = re.exec(text))) out.push({ start: m.index, end: m.index + m[0].length, cls: "cap-fact" }); }
    if (wantWhere) { const re = /\b(?:in|at|near)\s+([A-Z][\p{L}'’.-]+(?:\s+[A-Z][\p{L}'’.-]+){0,3})/gu; let m; while ((m = re.exec(text))) { const s = m.index + m[0].indexOf(m[1]); out.push({ start: s, end: s + m[1].length, cls: "cap-fact" }); } }
    if (wantCat) { const re = /[A-Za-z']+/g; let m; while ((m = re.exec(text))) if (CAT_ALIASES[m[0].toLowerCase()]) out.push({ start: m.index, end: m.index + m[0].length, cls: "cap-fact" }); }
    // Sort and drop overlaps (first/longer match wins).
    out.sort((a, b) => a.start - b.start || b.end - a.end);
    const merged = [];
    let lastEnd = -1;
    for (const r of out) { if (r.start >= lastEnd) { merged.push(r); lastEnd = r.end; } }
    return merged;
  }
  function paint() {
    const text = textarea.value;
    const rs = ranges(text);
    let html = "", last = 0;
    for (const r of rs) { html += esc(text.slice(last, r.start)) + `<mark class="${r.cls}">` + esc(text.slice(r.start, r.end)) + "</mark>"; last = r.end; }
    html += esc(text.slice(last));
    if (/\n$/.test(text)) html += " ";           // keep the backdrop's height in step with a trailing newline
    marks.innerHTML = html;
    marks.scrollTop = textarea.scrollTop; marks.scrollLeft = textarea.scrollLeft;
  }

  // Instant, free pass over the current text → chips (names already known + facts).
  function instant() {
    const text = textarea.value;
    let changed = false;
    if (wantNames) for (const row of nameIndex) { row.re.lastIndex = 0; if (row.re.test(text)) changed = addChip("name", row.canonical) || changed; }
    if (wantWhen) { const ys = (text.match(new RegExp("\\b" + YR + "\\b", "g")) || []).map(Number).filter((y) => y >= 1900 && y <= 2035); for (const y of ys) changed = addChip("when", String(y)) || changed; }
    if (wantWhere) { const re = /\b(?:in|at|near)\s+([A-Z][\p{L}'’.-]+(?:\s+[A-Z][\p{L}'’.-]+){0,3})/gu; let m; while ((m = re.exec(text))) changed = addChip("where", m[1].replace(/[.,;:]$/, "").trim()) || changed; }
    if (wantCat) { const re = /[A-Za-z']+/g; let m; while ((m = re.exec(text))) { const c = CAT_ALIASES[m[0].toLowerCase()]; if (c) changed = addChip("category", c) || changed; } }
    if (changed) renderChips();
  }

  // Debounced remote pass — newest wins, in-flight aborted.
  let timer = null, abort = null, seq = 0, lastSent = "";
  function schedule() {
    const text = textarea.value.trim();
    if (text.length < 5 || text === lastSent || !remote) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      lastSent = text; const mine = ++seq;
      if (abort) abort.abort();
      abort = new AbortController();
      try {
        const res = await remote(text, abort.signal) || {};
        if (mine !== seq) return;                 // superseded by a newer parse
        let changed = false;
        for (const n of (res.names || [])) { if (!n || !n.name) continue; const k = norm(n.name); if (!discovered.has(k)) { discovered.set(k, { name: n.name, kind: n.kind }); changed = true; } changed = addChip("name", n.name) || changed; }
        for (const f of (res.facts || [])) { if (f && f.value != null && buckets.includes(f.type)) changed = addChip(f.type, String(f.value)) || changed; }
        if (changed) { rebuildIndex(); paint(); renderChips(); }  // newly-discovered names now colour in the text too
      } catch { /* aborted or transient — keep what we have */ }
    }, debounceMs);
  }

  // ---- Public update: call on every keystroke AND after dictation writes the value ----------
  function update() { instant(); paint(); schedule(); }

  const loadKnown = async () => { try { knownCache = (await getAllEntities()).filter((e) => !isSelfEntity(e)); } catch { knownCache = []; } }; // "I" is not a name to colour

  // Prime the known-name index (and colour any pre-existing text) up front.
  (async () => { await loadKnown(); rebuildIndex(); instant(); paint(); })();

  return {
    update,
    async refresh() { await loadKnown(); rebuildIndex(); update(); },
    reset() { chips.clear(); discovered.clear(); lastSent = ""; rebuildIndex(); renderChips(); paint(); }, // new/blank entry
    found: () => [...chips.values()],
    destroy() { clearTimeout(timer); if (abort) abort.abort(); ro && ro.disconnect(); },
  };
}
