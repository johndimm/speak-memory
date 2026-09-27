// "People & Animals" — the entity registry. Every entry is scanned for the individuals it names
// (people, animals, places, orgs, things); each is resolved to one canonical identity with aliases,
// so "Ghost" and "Baby Kitty" are the same cat and every reference to "Ze" (even "Zay") lines up.
//
// This gives two things: a roster you can browse, and — per entity — every mention in time order,
// each a jump back to the day or memory. Merge combines two identities; rename/alias edits fix names.
//
// Entities live in the shared items store (kind "entity"); entries carry an `entityRefs: [id]` list.
// Extraction runs against /api/summarize (mode:"entities"); each scan is logged to Activity.

import { getAllEntries, getAllMemories, putEntry, putMemory, getAllEntities, getEntity, putEntity, deleteEntity } from "./db.js";
import { escapeHtml, resolveEntityTokens, setEntityMap } from "./render.js";
import { add as logAdd, set as logSet } from "./llmlog.js";
import { setupDictation, IS_MOBILE } from "./dictation.js";
import { resolveEntityNames, resetEntityIndex, sanitizeEntities } from "./entityresolve.js";
import { ensureSelf, isSelfEntity, needsDescription } from "./self.js";
import { jkey } from "./journal.js";
import { createSpeaker, CHARACTERS, savedCharacter } from "./voicetts.js";
import { listenTurn as vListen, hasSpeechInput } from "./voiceinput.js";
import { attachLiveCapture } from "./capture.js";

const SpeechRec = typeof window !== "undefined" && (window.SpeechRecognition || window.webkitSpeechRecognition);
const KIND_LABEL = { person: "Person", animal: "Animal", place: "Place", org: "Organization", thing: "Thing" };
const KIND_ORDER = ["person", "animal", "place", "org", "thing"];
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "e" + Date.now() + Math.random().toString(36).slice(2));

function llmOverrides() {
  const provider = localStorage.getItem("llm-provider") || "";
  if (!provider) return {};
  return { provider, apiKey: localStorage.getItem("llm-api-key") || "", model: localStorage.getItem("llm-model") || "", baseUrl: localStorage.getItem("llm-base-url") || "" };
}
async function postEntities(text) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  try {
    const r = await fetch("/api/summarize", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...llmOverrides(), mode: "entities", text }), signal: ctrl.signal,
    });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || `Server ${r.status}`); }
    return await r.json();
  } finally { clearTimeout(timer); }
}
// Batch: extract names from several entries in one call → { results:[{id, mentions}] }.
async function postEntitiesBatch(items) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  try {
    const r = await fetch("/api/summarize", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...llmOverrides(), mode: "entities", batch: items }), signal: ctrl.signal,
    });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || `Server ${r.status}`); }
    return await r.json();
  } finally { clearTimeout(timer); }
}
// Normalize a name for matching: lowercase, drop possessives/punctuation, collapse spaces.
function normName(s) {
  return String(s || "").toLowerCase().replace(/['’]s\b/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

// Ask a scoped question about one entity, answered only from the entries that mention it.
async function postChat(messages, entries) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  try {
    const r = await fetch("/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...llmOverrides(), messages, entries, localTime: new Date().toLocaleString() }), signal: ctrl.signal,
    });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || `Server ${r.status}`); }
    return await r.json();
  } finally { clearTimeout(timer); }
}
function renderAnswerText(t) {
  const esc = resolveEntityTokens(String(t)).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); // {{e:id|Name}} → the name
  return "<p>" + esc.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br>") + "</p>";
}

// Standard facts we like to know per kind — a light checklist on each card, filled from your notes.
const FACT_FIELDS = {
  person: [["relationship", "Relationship"], ["age", "Age"], ["job", "Work"], ["location", "Lives"], ["livesWith", "Lives with"]],
  place: [["placeType", "What"], ["location", "Where"], ["years", "When"]],
  org: [["orgType", "What"], ["role", "My role"], ["years", "When"]],
};
function factValue(f, k) {
  if (k === "age") return f.age != null ? String(f.age) : (f.birthYear ? `b. ${f.birthYear}` : "");
  return f[k] ? String(f[k]) : "";
}
function factsChecklist(ent) {
  const fields = FACT_FIELDS[ent.entityKind || "person"];
  if (!fields) return "";
  const f = ent.facts || {};
  const rows = fields.map(([k, label]) => {
    const v = factValue(f, k); const ok = !!v.trim();
    return `<li class="ent-fact${ok ? " ok" : ""}"><span class="ob-check">${ok ? "✓" : "○"}</span><span class="ob-label">${label}</span><b class="ob-val">${escapeHtml(v)}</b></li>`;
  }).join("");
  return `<ul class="ent-facts-list" id="ent-facts">${rows}</ul>`;
}

// The fact fields for an entity. "You" gets a life-focused set; anyone else gets their kind's facts.
const SELF_FIELDS = [["age", "Age"], ["location", "Home"], ["livesWith", "Lives with"], ["job", "Work"], ["family", "Family"], ["friends", "Best friends"]];
function factFields(ent) {
  if (isSelfEntity(ent)) return SELF_FIELDS;
  return FACT_FIELDS[ent.entityKind || "person"] || [];
}
// Read-only facts, for the BROWSE view — a clean "Label: value" list of what's known (empties hidden).
function factsView(ent) {
  const fields = factFields(ent);
  if (!fields.length) return "";
  const f = ent.facts || {};
  const rows = fields.map(([k, label]) => [label, factValue(f, k)]).filter(([, v]) => v && v.trim());
  if (!rows.length) return "";
  return `<dl class="ent-facts-view">${rows.map(([label, v]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(v)}</dd></div>`).join("")}</dl>`;
}
// The game, for the EDIT view — a chip per fact that fills IN as you talk (extracted invisibly), so
// you just speak freely; the chips show what's been picked up. Tap one to correct it by hand.
function factChipsInner(ent) {
  const f = ent.facts || {};
  return factFields(ent).map(([k, label]) => {
    const v = factValue(f, k);
    return `<button type="button" class="fact-chip${v ? " filled" : ""}" data-k="${escapeHtml(k)}">
      <span class="fc-check">${v ? "✓" : "○"}</span><span class="fc-k">${escapeHtml(label)}</span>${v ? `<span class="fc-v">${escapeHtml(v)}</span>` : ""}</button>`;
  }).join("");
}
function factChips(ent) {
  if (!factFields(ent).length) return "";
  return `<div class="fact-chips" id="fact-chips">${factChipsInner(ent)}</div>`;
}

// Read-modify-write one entity, serialized — so a profile and its facts landing at the same moment
// can't overwrite each other.
let entWrite = Promise.resolve();
function updateEntity(id, fallback, change) {
  const run = entWrite.then(async () => { const cur = (await getEntity(id)) || fallback; await putEntity(change(cur)); });
  entWrite = run.catch(() => {});
  return run;
}

// Write (and save) an entity's profile from MY notes + the journal entries that mention it. The note
// is passed AS AN ENTRY so /api/chat treats it as source-of-truth. Shared by the name page and the
// hands-free interview. Returns the profile text.
async function writeProfile(ent, mentions) {
  const entries = (mentions || []).map((s) => ({ date: s.date || `${s.startYear || ""}`, brief: s.brief || (s.prose && s.prose.brief) || "", full: s.full || s.raw || s.text || "" }));
  const r = await fetch("/api/summarize", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...llmOverrides(), mode: "entityprofile", name: ent.canonical, kind: ent.entityKind || "person", aliases: ent.aliases || [], note: ent.note || "", entries }),
  });
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || `Server ${r.status}`); }
  const { profile } = await r.json();
  const reply = profile || "";
  await updateEntity(ent.id, ent, (cur) => ({ ...cur, profile: reply, profileAt: Date.now(), updatedAt: Date.now() }));
  return reply;
}

// Extract the standard facts for a name's kind from its notes + mentions, store them, refresh the
// on-card checklist, and create/link any other names it mentions. Returns the names found.
async function extractFacts(ent, mentions) {
  if (!FACT_FIELDS[ent.entityKind || "person"]) return [];
  const entries = (mentions || []).map((s) => ({ date: s.date || `${s.startYear || ""}`, brief: s.brief || (s.prose && s.prose.brief) || "", full: s.full || s.raw || s.text || "" }));
  const r = await fetch("/api/summarize", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...llmOverrides(), mode: "entityfacts", name: ent.canonical, kind: ent.entityKind || "person", note: ent.note || "", entries }),
  });
  if (!r.ok) return [];
  const { facts, names } = await r.json();
  // MERGE, don't overwrite: a value you typed/said in the keyword game is authoritative — the LLM
  // only fills topics you haven't answered yet, so extracting from a new note can't wipe your answers.
  let merged = {};
  await updateEntity(ent.id, ent, (cur) => {
    merged = { ...(cur.facts || {}) };
    for (const [k, v] of Object.entries(facts || {})) {
      const has = merged[k] != null && String(merged[k]).trim() !== "";
      if (!has && v != null && String(v).trim() !== "") merged[k] = v;
    }
    return { ...cur, facts: merged, updatedAt: Date.now() };
  });
  ent.facts = merged;
  const el = document.getElementById("ent-facts");
  if (el && el.closest("[data-ent]")?.dataset.ent === ent.id) el.outerHTML = factsChecklist(ent); // only on its own page
  const others = (names || []).filter((m) => m && m.name);
  if (others.length) {
    try {
      const refs = (await resolveEntityNames(others)).filter((rid) => rid !== ent.id);
      if (refs.length) { const c = (await getEntity(ent.id)) || ent; await putEntity({ ...c, noteRefs: [...new Set([...(c.noteRefs || []), ...refs])], updatedAt: Date.now() }); }
    } catch { /* */ }
  }
  return others;
}

// A short date for a source item (day = its date; memory = its year range or label).
function itemWhen(it) {
  if (it.kind === "journal" || it.date) return it.date;
  if (it.startYear) return `${it.startYear}${it.endYear && it.endYear !== it.startYear ? "–" + it.endYear : ""}`;
  return it.label || "";
}
function itemSortKey(it) {
  if (it.date) return it.date;
  if (it.startYear) return `${it.startYear}-00-00`;
  return "0000";
}

// A name the journal mentions this often gets its description written FROM those entries; only the
// thinly-mentioned ones (≤ ASK_MAX) are left for you to describe.
const ASK_MAX = 2;
function mentionIndex(sources) {
  const byId = new Map(); // entity id → the sources that mention it
  for (const s of sources) for (const id of (Array.isArray(s.entityRefs) ? s.entityRefs : [])) {
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(s);
  }
  return byId;
}
// Still needs YOUR words: no note of your own, and too few mentions to write one from.
const needsYou = (e, count) => !isSelfEntity(e) && needsDescription(e) && e.recognized !== false && count <= ASK_MAX;
// Can be described from the journal: no note, no profile yet, and mentioned often enough.
// Tried once (profileTriedAt) → never retried automatically, so an empty or failing reply can't loop.
const canAutoDescribe = (e, count) => !isSelfEntity(e) && needsDescription(e) && e.recognized !== false && !e.profile && !e.profileTriedAt && count > ASK_MAX;

export function initEntities(root, { onOpenDay, onOpenMemory, onProgress, onShown } = {}) {
  let openId = null; // entity being viewed, or null = the roster
  let entEditing = null; // browse (read) vs edit (write); null = decide by whether the card has content
  let needOrder = null;    // ids of the names still needing a description, in the roster's order
  let autoRunning = false; // the background describer (one name at a time) is working
  // Which page is on screen. Every render bumps viewSeq; slow background work checks it before it
  // touches the page, so finishing late can never redraw — or pull you back to — a page you've left.
  let viewSeq = 0;
  const processing = new Set(); // ids whose saved words are still being turned into facts + a profile
  let selecting = false;         // the roster's Select mode (batch delete)
  const selected = new Set();
  let editSnapshot = null; // the saved version when ✎ Edit was tapped — Cancel restores it
  const entDraftKey = (eid) => jkey(`draft:ent:${eid}`); // unsaved words in the box, kept while you're away
  let scanning = false;
  let showSingles = false; // one-off names (mentioned only once) are hidden until you ask for them

  async function allSources() {
    const [days, mems] = await Promise.all([getAllEntries(), getAllMemories()]);
    return [...days, ...mems];
  }

  // Remove several names in ONE pass over the entries (batch delete from the roster's Select mode).
  async function removeEntities(ids) {
    const gone = new Set(ids);
    if (!gone.size) return;
    const sources = await allSources();
    for (const s of sources) {
      if (Array.isArray(s.entityRefs) && s.entityRefs.some((x) => gone.has(x))) {
        const refs = s.entityRefs.filter((x) => !gone.has(x));
        if (s.date) await putEntry({ ...s, entityRefs: refs }); else await putMemory({ ...s, entityRefs: refs });
      }
    }
    for (const id of gone) await deleteEntity(id);
    resetEntityIndex();
  }

  // Remove a name entirely: drop its id from every entry's refs, then delete the entity record.
  async function removeEntity(id) {
    const sources = await allSources();
    for (const s of sources) {
      if (Array.isArray(s.entityRefs) && s.entityRefs.includes(id)) {
        const refs = s.entityRefs.filter((x) => x !== id);
        if (s.date) await putEntry({ ...s, entityRefs: refs }); else await putMemory({ ...s, entityRefs: refs });
      }
    }
    await deleteEntity(id);
    resetEntityIndex(); // roster changed — the pass's resolver cache must rebuild
  }

  // An entry already has a summary → the summarization pass has run on it. NER now rides along with
  // that pass, so un-summarized entries get their names for free when they're summarized; Scan only
  // needs to catch up the ALREADY-summarized entries that predate NER-in-summarize.
  const hasSummary = (s) => !!(s.levels || (s.prose && (s.prose.full || s.prose.brief)) || s.summarized === true);
  const srcKey = (s) => s.date || s.id;

  // ---- Scan: tag already-summarized entries that still lack name tags. Batched (10 per call). ----
  async function scan(setStatus) {
    if (scanning) return;
    scanning = true;
    try {
      const sources = await allSources();
      const untagged = sources.filter((s) => (s.raw || s.text) && !Array.isArray(s.entityRefs));
      let queue = untagged.filter(hasSummary); // leave un-summarized ones to the pass (free NER)
      const deferred = untagged.length - queue.length;
      if (!queue.length) {
        setStatus(deferred ? `Nothing to scan — ${deferred} entr${deferred === 1 ? "y is" : "ies are"} still summarizing, and names come with that automatically.` : "Everything's already scanned.", deferred ? "" : "");
        return;
      }

      // Shared resolver (normalized name/alias match) — same path the pass uses, so no dupes.
      resetEntityIndex();
      const before = (await getAllEntities()).length;
      const total = queue.length;

      // One call handles a whole chunk of entries; the model returns names per entry id.
      const CHUNK = 10;
      const chunks = [];
      for (let i = 0; i < queue.length; i += CHUNK) chunks.push(queue.slice(i, i + CHUNK));

      let completed = 0, failedEntries = 0;
      const btn = root.querySelector("#ent-scan");
      if (btn) btn.disabled = true;
      const tick = () => {
        setStatus(`◷ Scanning… ${completed} of ${total} entries (batched)`, "working");
        if (btn) btn.textContent = `Scanning ${completed}/${total}…`;
      };
      tick();

      const doChunk = async (chunk) => {
        const jid = logAdd(`${chunk.length} entries`, "scan");
        logSet(jid, "running");
        const byId = new Map(chunk.map((s) => [String(srcKey(s)), s]));
        try {
          const { results } = await postEntitiesBatch(chunk.map((s) => ({ id: String(srcKey(s)), text: s.raw || s.text || "" })));
          const map = new Map((results || []).map((r) => [String(r.id), r.mentions || []]));
          for (const s of chunk) {
            const mentions = map.get(String(srcKey(s))) || [];
            const refs = await resolveEntityNames(mentions);
            const next = { ...s, entityRefs: refs };
            if (s.date) await putEntry(next); else await putMemory(next);
            completed++;
          }
          logSet(jid, "done");
        } catch (e) {
          failedEntries += chunk.length; // whole chunk failed → left untagged for a later Scan
          logSet(jid, "error", (e && e.message) || "failed");
        }
        tick();
      };

      // A couple of chunks in flight at once.
      const CONCURRENCY = 2;
      let ci = 0;
      const worker = async () => { while (ci < chunks.length) { await doChunk(chunks[ci++]); } };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));

      const found = (await getAllEntities()).length - before;
      const tail = deferred ? ` (${deferred} more will get names as they summarize)` : "";
      if (failedEntries) setStatus(`Scanned ${completed} of ${total} — ${failedEntries} failed, tap Scan again to retry. ${found} new name${found === 1 ? "" : "s"}.${tail}`, "error");
      else setStatus(`Done — ${found} new name${found === 1 ? "" : "s"} across ${total} entr${total === 1 ? "y" : "ies"}.${tail}`, "ok");
      render();
    } finally { scanning = false; }
  }

  // ---- Describe the well-mentioned names from the journal, in the background ----------------
  // One at a time (it shares the model with the summarizing pass). Each gets a profile + its facts;
  // the roster redraws as they land so those names stop showing as "needs a description".
  async function autoDescribe() {
    if (autoRunning) return;
    autoRunning = true;
    try {
      for (;;) {
        const [all, sources] = await Promise.all([getAllEntities(), allSources()]);
        const idx = mentionIndex(sources);
        const next = all.filter((e) => canAutoDescribe(e, (idx.get(e.id) || []).length))
          .sort((a, b) => (idx.get(b.id) || []).length - (idx.get(a.id) || []).length)[0];
        if (!next) break;
        const mentions = idx.get(next.id) || [];
        const jid = logAdd(`Describe ${next.canonical}`, "profile");
        logSet(jid, "running");
        let ok = true;
        try {
          // Profile and facts read the same entries — run them side by side.
          await Promise.all([writeProfile(next, mentions), extractFacts(next, mentions).catch(() => [])]);
          logSet(jid, "done");
        } catch (e) { ok = false; logSet(jid, "error", (e && e.message) || "failed"); }
        if (!ok) break; // the model is failing — stop; the next visit to Names tries again
        // Done → never picked again automatically (even if the reply came back empty); its page can Refresh.
        await updateEntity(next.id, next, (cur) => ({ ...cur, profileTriedAt: Date.now() }));
        if (!openId && root.isConnected && !root.hidden) render(); // show it land on the list
      }
    } finally { autoRunning = false; }
  }

  // ---- Roster (the entity list) --------------------------------------------------------------
  async function render() {
    await sanitizeEntities(); // repair any names that are leftover {{tokens}}
    await ensureSelf(); // the journal-keeper is the first Name, there by default
    const all = await getAllEntities();
    setEntityMap(new Map(all.map((e) => [e.id, e.canonical]))); // so {{e:id|Name}} tokens resolve to names here
    if (openId) { renderEntity(openId); return; }
    const sources = await allSources();
    // Count mentions per entity from the tagged sources.
    const counts = new Map();
    let taggedCount = 0;
    for (const s of sources) {
      if (Array.isArray(s.entityRefs)) { taggedCount++; for (const id of s.entityRefs) counts.set(id, (counts.get(id) || 0) + 1); }
    }
    const total = sources.filter((s) => s.raw || s.text).length;

    // You live in your own "Me" tab now — the Names roster is everyone ELSE.
    const entities = all.filter((e) => !isSelfEntity(e));

    // Names deliberately mentioned in someone's note (e.g. your self-description) — always show these.
    const noteReffed = new Set();
    for (const e of all) for (const rid of (e.noteRefs || [])) noteReffed.add(rid);

    // A name mentioned only ONCE across all entries is usually noise in a BIG journal. Keep anything
    // you've engaged with (note/flag/profile) or that you named in a note; and never hide when there
    // are only a handful of one-offs (a new or small journal shows everyone).
    const keep = (e) => (counts.get(e.id) || 0) >= 2 || !!e.note || e.recognized === false || !!e.profile || noteReffed.has(e.id);
    const singles = entities.filter((e) => !keep(e));
    const manySingles = singles.length > 20;
    const visible = (showSingles || !manySingles) ? entities : entities.filter(keep);


    const byKind = new Map();
    for (const e of visible) {
      const k = e.entityKind || "person";
      if (!byKind.has(k)) byKind.set(k, []);
      byKind.get(k).push(e);
    }
    const sections = KIND_ORDER.filter((k) => byKind.has(k)).map((k) => {
      const list = byKind.get(k).sort((a, b) => (counts.get(b.id) || 0) - (counts.get(a.id) || 0) || a.canonical.localeCompare(b.canonical));
      const cards = list.map((e) => { const empty = needsYou(e, counts.get(e.id) || 0); return `
        <div class="ent-card-wrap">
          <button type="button" class="ent-card${e.recognized === false ? " ent-card-flag" : ""}${empty ? " ent-card-empty" : ""}${selected.has(e.id) ? " ent-card-picked" : ""}" data-open="${escapeHtml(e.id)}"${empty ? ` data-empty="1"` : ""}>
            ${selecting ? `<span class="ent-pick" aria-hidden="true">${selected.has(e.id) ? "☑" : "☐"}</span>` : ""}<span class="ent-name">${escapeHtml(e.canonical)}</span>
            ${e.recognized === false ? `<span class="ent-flag">🕳 didn't recognize</span>` : empty ? `<span class="ent-need" title="Needs a description" aria-label="needs a description">✎</span>` : (e.aliases && e.aliases.length) ? `<span class="ent-aka">aka ${escapeHtml(e.aliases.join(", "))}</span>` : ""}
            <span class="ent-count">${counts.get(e.id) || 0}</span>
          </button>
          ${selecting ? "" : `<button type="button" class="ent-card-del" data-del="${escapeHtml(e.id)}" title="Delete this name" aria-label="Delete">×</button>`}
        </div>`; }).join("");
      return `<h3 class="ent-kind">${KIND_LABEL[k] || k}s</h3><div class="ent-grid">${cards}</div>`;
    }).join("");
    // "Needs a description" = a shown name with no note of your own yet — in the order the list shows
    // them, so the count, the marked cards, and the guided Next all walk the same names.
    const undescribed = KIND_ORDER.flatMap((k) => byKind.get(k) || []).filter((e) => e && needsYou(e, counts.get(e.id) || 0));
    const describing = entities.filter((e) => canAutoDescribe(e, counts.get(e.id) || 0)).length;
    needOrder = undescribed.map((e) => e.id);

    viewSeq++;
    document.body.classList.toggle("ent-selecting", selecting); // hides the Next nudge while picking
    const selBar = selecting ? `<div class="ent-selbar" id="ent-selbar">
          <span class="ent-selcount" id="ent-selcount">${selected.size} selected</span>
          <button type="button" class="ent-sellink" id="ent-sel-all">All</button>
          <button type="button" class="ent-sellink" id="ent-sel-empty">Empty ones</button>
          <button type="button" class="ent-sellink" id="ent-sel-none">None</button>
          <button type="button" class="delete-entry-btn ent-sel-del" id="ent-sel-del"${selected.size ? "" : " disabled"}>Delete ${selected.size || ""}</button>
        </div>` : "";
    root.innerHTML = `
      <div class="entities${selecting ? " ent-selectmode" : ""}">
        <div class="ent-head">
          <h2 class="ent-title">Names</h2>
          <div class="act-actions">
            ${entities.length && !selecting ? `<button type="button" class="ent-scan ent-interview-btn" id="ent-interview">🎙 Interview me</button>` : ""}
            ${entities.length ? `<button type="button" class="ent-scan ent-select-btn" id="ent-select">${selecting ? "Done" : "Select"}</button>` : ""}
            <button type="button" class="ent-scan" id="ent-scan">${entities.length ? "Scan new entries" : "Scan entries"}</button>
          </div>
        </div>
        ${undescribed.length && !selecting ? `<button type="button" class="ent-needs" id="ent-needs">✎ ${undescribed.length} still need${undescribed.length === 1 ? "s" : ""} a description <span class="ent-needs-key">(dashed below) — tap to start</span></button>` : ""}
        ${describing ? `<p class="field-hint">◷ Writing descriptions for ${describing} name${describing === 1 ? "" : "s"} from your journal…</p>` : ""}
        <div id="ent-status" class="ent-status" hidden></div>
        ${total === 0 && entities.length === 0
          ? `<p class="ent-empty">Write or imagine some days and the people, places and things you name will show up here.</p>`
          : sections + selBar
              + ((manySingles || showSingles) && singles.length ? `<button type="button" class="ent-singles-toggle" id="ent-singles">${showSingles ? "Hide" : "Show"} ${singles.length} name${singles.length === 1 ? "" : "s"} mentioned once</button>` : "")
              + (taggedCount < total ? `<p class="field-hint" style="margin-top:1rem">${total - taggedCount} entr${total - taggedCount === 1 ? "y" : "ies"} not yet scanned — tap “Scan new entries”.</p>` : "")}
      </div>`;

    root.querySelector("#ent-scan")?.addEventListener("click", () => scan(setStatus));
    root.querySelector("#ent-select")?.addEventListener("click", () => { selecting = !selecting; selected.clear(); render(); });
    const pickAll = (pred) => { for (const c of root.querySelectorAll(".ent-card[data-open]")) if (pred(c)) selected.add(c.dataset.open); render(); };
    root.querySelector("#ent-sel-all")?.addEventListener("click", () => pickAll(() => true));
    root.querySelector("#ent-sel-empty")?.addEventListener("click", () => pickAll((c) => c.dataset.empty === "1"));
    root.querySelector("#ent-sel-none")?.addEventListener("click", () => { selected.clear(); render(); });
    root.querySelector("#ent-sel-del")?.addEventListener("click", async () => {
      const ids = [...selected];
      if (!ids.length) return;
      const names = entities.filter((e) => selected.has(e.id)).map((e) => e.canonical);
      const list = names.slice(0, 8).join(", ") + (names.length > 8 ? `, and ${names.length - 8} more` : "");
      if (!confirm(`Delete ${ids.length} name${ids.length === 1 ? "" : "s"}? (${list})\nTheir mentions stay in the entries; only the names are removed.`)) return;
      const btn = root.querySelector("#ent-sel-del");
      if (btn) { btn.disabled = true; btn.textContent = "Deleting…"; }
      await removeEntities(ids);
      selected.clear(); selecting = false;
      render();
    });
    root.querySelector("#ent-interview")?.addEventListener("click", () => startInterview());
    root.querySelector("#ent-singles")?.addEventListener("click", () => { showSingles = !showSingles; render(); });
    root.querySelector("#ent-needs")?.addEventListener("click", () => { openId = (undescribed[0] || {}).id; if (openId) { entEditing = true; renderEntity(openId); } }); // jump straight into editing the first name that needs a description
    onShown && onShown(); // the roster is up → the guided Next can point at the first empty name
    if (describing) autoDescribe();
  }

  function setStatus(msg, cls) {
    const el = root.querySelector("#ent-status");
    if (!el) return;
    el.hidden = !msg;
    el.className = "ent-status" + (cls ? " " + cls : "");
    el.textContent = msg;
  }

  // ---- One entity: profile + every mention in time order -------------------------------------
  async function renderEntity(id) {
    const [ent, sources, entities] = await Promise.all([getEntity(id), allSources(), getAllEntities()]);
    setEntityMap(new Map(entities.map((e) => [e.id, e.canonical]))); // resolve {{e:id|Name}} tokens to names
    onShown && onShown(); // a name page is up → the guided Next can point at the next empty one
    if (!ent) { openId = null; render(); return; }
    const mentions = sources.filter((s) => Array.isArray(s.entityRefs) && s.entityRefs.includes(id))
      .sort((a, b) => itemSortKey(a).localeCompare(itemSortKey(b)));
    const rows = mentions.map((s) => {
      const brief = s.brief || (s.prose && s.prose.brief) || (s.levels && s.levels.sentence) || (s.raw || s.text || "").slice(0, 120);
      const kind = s.date ? "day" : "mem";
      const key = s.date || s.id;
      return `<button type="button" class="ent-mention" data-goto="${escapeHtml(key)}" data-kind="${kind}">
        <span class="ent-when">${escapeHtml(itemWhen(s))}</span>
        <span class="ent-snip">${escapeHtml(resolveEntityTokens(brief))}</span>
      </button>`;
    }).join("");
    const others = entities.filter((e) => e.id !== id).sort((a, b) => a.canonical.localeCompare(b.canonical));
    const mergeOpts = others.map((e) => `<option value="${escapeHtml(e.id)}">${escapeHtml(e.canonical)}</option>`).join("");

    const selfMode = isSelfEntity(ent);

    // Same rule as every page: open EMPTY cards ready to write (edit), and cards that already have
    // something to show in read mode with an Edit button. entEditing === null means "decide by content".
    // "Content to read" = YOUR words or facts, or real mentions — NOT the auto-generated profile
    // (a leftover profile shouldn't stop an otherwise-empty card from opening ready to write).
    const hasContent = !!((ent.note && ent.note.trim()) || (ent.facts && Object.keys(ent.facts).length) || mentions.length);
    if (entEditing === null || entEditing === undefined) entEditing = !hasContent;

    // ONE background extractor for the "just talk, we listen" capture. For YOU we use the onboard
    // extractor (purpose-built for first-person "my life now" → age/home/lives-with/work/friends); for
    // anyone else, entityfacts. Both also return the names mentioned, so a single call feeds names too.
    async function postCapture(text, signal) {
      try {
        if (selfMode) {
          const r = await fetch("/api/summarize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...llmOverrides(), mode: "onboard", text }), signal });
          if (!r.ok) return null;
          const j = await r.json();
          const facts = {};
          if (j.age != null) facts.age = j.age;
          if (j.birthYear != null) facts.birthYear = j.birthYear;
          if (j.location) facts.location = j.location;
          if (j.livesWith) facts.livesWith = j.livesWith;
          if (j.job) facts.job = j.job;
          if (Array.isArray(j.family) && j.family.length) facts.family = j.family.join(", ");
          if (Array.isArray(j.friends) && j.friends.length) facts.friends = j.friends.join(", ");
          return { facts, names: j.names || [] };
        }
        const r = await fetch("/api/summarize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...llmOverrides(), mode: "entityfacts", name: ent.canonical, kind: ent.entityKind || "person", note: text, entries: [] }), signal });
        if (!r.ok) return null;
        const j = await r.json();
        return { facts: j.facts || {}, names: j.names || [] };
      } catch { return null; } // aborted or offline — the chips just don't fill this round
    }

    const subtitle = `<p class="node-subtitle">${KIND_LABEL[ent.entityKind || "person"]}${(!selfMode && ent.aliases && ent.aliases.length) ? ` · also ${escapeHtml(ent.aliases.join(", "))}` : ""}</p>`;
    const flag = ent.recognized === false ? `<p class="ent-flag-banner">🕳 You didn't recognize this name — a possible mistake or a memory hole. Add anything you can in Edit, or it stays flagged.</p>` : "";

    // Profile paragraph — written from the mentions PLUS your notes.
    const profileFrag = `<div class="node-summary ent-summary" id="ent-summary">
          ${processing.has(id) ? `<p class="ent-ask-working">◷ Updating ${escapeHtml(ent.canonical)}'s description…</p>`
            : ent.profile
            ? `${renderAnswerText(ent.profile)}<button type="button" class="ent-summary-refresh" id="ent-summary-refresh">↻ Refresh</button>`
            : mentions.length ? `<p class="ent-ask-working">◷ Writing ${escapeHtml(ent.canonical)}'s profile…</p>` : `<p class="ent-empty">Nothing yet — tap Edit to add a few facts or notes.</p>`}
        </div>`;

    const mentionsFrag = `<h3 class="ent-kind">${mentions.length} mention${mentions.length === 1 ? "" : "s"}, in time order</h3>
        <div class="ent-mentions">${rows || '<p class="ent-empty">No mentions tagged yet.</p>'}</div>`;

    const askFrag = `<div class="ent-ask">
          <form class="ent-ask-form" id="ent-ask-form">
            <input type="text" id="ent-ask-input" placeholder="Ask about ${escapeHtml(ent.canonical)}${(ent.entityKind || "person") === "person" ? ` — “when did we meet?”` : ""}">
            <button type="submit" class="ent-ask-btn">Ask</button>
          </form>
          <div id="ent-ask-answer" class="ent-ask-answer" hidden></div>
        </div>`;

    // Same layout as Journal/Stories (docs/input-method-design.md):
    //   breadcrumb → text box (EDIT) or ✎ Edit (READ) → title → content → Save/Cancel → Delete.
    const breadcrumb = `<nav class="write-breadcrumb" aria-label="Location">${selfMode
      ? `<span class="crumb crumb-current">Me</span>`
      : `<button type="button" class="crumb" id="ent-back">Names</button><span class="crumb-sep">›</span><span class="crumb crumb-current">${escapeHtml(ent.canonical)}</span>`}</nav>`;

    // The transcript box: your own words, prefilled so you can add more below or fix anything.
    const boxFrag = `<label class="field write-main">
          <span class="field-label write-prompt">${hasContent ? "Your words — add more, or fix anything" : selfMode ? "Tell me about your life" : `Tell me about ${escapeHtml(ent.canonical)}`}</span>
          <textarea id="ent-note-input" class="node-comment-input" rows="3" placeholder="${selfMode ? "Where you live, who with, your family and best friends…" : ({ person: "Who they are, how you're connected…", animal: "Whose pet, what they were like…", place: "What it is, when you were there…" })[ent.entityKind || "person"] || "What it is, how it fits in your life…"}">${escapeHtml(ent.note || "")}</textarea>
        </label>
        <div class="write-tools"><button type="button" class="mic-btn" id="ent-note-mic" hidden><span>🎤 Dictate</span></button></div>
        <div class="cap-found" id="ent-note-found" hidden></div>`;

    // Rename / kind / aliases are saved with Save; Merge is its own action.
    const kindFrag = `<details class="node-fold ent-details">
          <summary>${selfMode ? "Details" : "Name, kind, aliases &amp; merge"}</summary>
          <div class="node-fold-body ent-detail-body">
            <label class="ent-field"><span>Name</span>
              <input type="text" class="ent-rename" id="ent-rename" value="${escapeHtml(ent.canonical)}" spellcheck="false"></label>
            <label class="ent-field"><span>Kind</span>
              <select id="ent-kind" class="ent-kindsel">${KIND_ORDER.map((k) => `<option value="${k}"${(ent.entityKind || "person") === k ? " selected" : ""}>${KIND_LABEL[k]}</option>`).join("")}</select></label>
            <label class="ent-field"><span>Also known as (comma-separated)</span>
              <input type="text" id="ent-aliases" value="${escapeHtml((ent.aliases || []).join(", "))}" placeholder="Baby Kitty, Zay…"></label>
            ${others.length ? `<div class="ent-profile-actions"><span class="ent-merge"><span>Merge into</span><select id="ent-merge-sel"><option value="">choose…</option>${mergeOpts}</select><button type="button" id="ent-merge-btn">Merge</button></span></div>` : ""}
            <div id="ent-dstatus" class="ent-status" hidden></div>
          </div>
        </details>`;

    const actionsFrag = `<div class="write-actions">
          <button type="button" class="save-btn" id="ent-note-add">Save</button>
          ${hasContent ? `<button type="button" class="cancel-btn" id="ent-cancel">Cancel</button>` : ""}
          <span class="node-comment-status" id="ent-pstatus"></span>
        </div>`;

    const browseBody = `
        <button type="button" class="edit-text-btn" id="ent-edit-toggle">✎ Edit</button>
        <h2 class="node-name">${escapeHtml(ent.canonical)}</h2>
        ${subtitle}${flag}
        ${profileFrag}
        ${factsView(ent)}
        ${mentionsFrag}
        ${askFrag}`;

    const editBody = `
        ${boxFrag}
        <h2 class="node-name">${escapeHtml(ent.canonical)}</h2>
        ${subtitle}${flag}
        ${factChips(ent)}
        ${kindFrag}
        ${actionsFrag}
        ${selfMode ? "" : `<button type="button" class="delete-entry-btn" id="ent-del-big">Delete</button>`}`;

    const mySeq = ++viewSeq;
    document.body.classList.remove("ent-selecting");
    const live = () => viewSeq === mySeq; // still this page, in this mode?
    root.innerHTML = `
      <div class="entities${selfMode ? " ent-selfpage" : ""}${entEditing ? " ent-editing" : ""}" data-ent="${escapeHtml(id)}">
        ${breadcrumb}
        ${entEditing ? editBody : browseBody}
      </div>`;

    const pstatus = (msg, cls) => { const el = live() && root.querySelector("#ent-pstatus"); if (!el) return; el.textContent = msg; el.className = "node-comment-status" + (cls ? " " + cls : ""); };
    const dstatus = (msg, cls) => { const el = live() && root.querySelector("#ent-dstatus"); if (!el) return; el.hidden = !msg; el.className = "ent-status" + (cls ? " " + cls : ""); el.textContent = msg; };

    // Edit ⇄ Done toggles between writing and reading this card.
    // ✎ Edit → remember the saved version (so Cancel can restore it), then show the box.
    root.querySelector("#ent-edit-toggle")?.addEventListener("click", () => {
      editSnapshot = { id, note: ent.note || "", facts: { ...(ent.facts || {}) }, canonical: ent.canonical, entityKind: ent.entityKind, aliases: [...(ent.aliases || [])] };
      entEditing = true; renderEntity(id);
    });
    // Cancel → put the saved version back and return to READ.
    root.querySelector("#ent-cancel")?.addEventListener("click", async () => {
      try { localStorage.removeItem(entDraftKey(id)); } catch { /* */ }
      if (editSnapshot && editSnapshot.id === id) {
        const cur = (await getEntity(id)) || ent;
        const { id: _i, ...snap } = editSnapshot;
        await putEntity({ ...cur, ...snap });
      }
      editSnapshot = null; entEditing = false; renderEntity(id);
    });

    // Each name gets an LLM-written profile, generated from its mentions and cached on the entity.
    const mentionEntries = () => mentions.map((s) => ({
      date: s.date || `${s.startYear || ""}`, dayOfWeek: s.dayOfWeek || "",
      brief: s.brief || (s.prose && s.prose.brief) || "", full: s.full || s.raw || s.text || "",
    }));
    async function genProfile() {
      const box = root.querySelector("#ent-summary");
      if (!box || (!mentions.length && !ent.note)) return; // need mentions or your notes to write from
      box.innerHTML = `<p class="ent-ask-working">◷ Writing ${escapeHtml(ent.canonical)}'s profile…</p>`;
      try {
        const reply = await writeProfile(ent, mentions);
        ent.profile = reply;
        if (!live()) return; // you've moved on — it's saved; don't touch the page you're on now
        box.innerHTML = `${renderAnswerText(reply)}<button type="button" class="ent-summary-refresh" id="ent-summary-refresh">↻ Refresh</button>`;
        root.querySelector("#ent-summary-refresh")?.addEventListener("click", genProfile);
      } catch (err) {
        if (!live()) return;
        box.innerHTML = `<p class="ent-ask-err">Couldn't write a profile: ${escapeHtml((err && err.message) || String(err))}</p><button type="button" class="ent-summary-refresh" id="ent-summary-refresh">↻ Try again</button>`;
        root.querySelector("#ent-summary-refresh")?.addEventListener("click", genProfile);
      }
    }
    root.querySelector("#ent-summary-refresh")?.addEventListener("click", genProfile);
    // Auto-write on first open, OR refresh a profile that's now stale — written before you added
    // notes (so it won't keep saying "little is known" above your detailed notes).
    const stale = (ent.profileAt || 0) < (ent.updatedAt || 0);
    if (!processing.has(id) && (!ent.profile || stale) && (mentions.length || ent.note)) genProfile();
    // Backfill the standard-facts checklist on open, when it's empty but there's something to read.
    if (!processing.has(id) && FACT_FIELDS[ent.entityKind || "person"] && !ent.facts && (ent.note || mentions.length)) extractFacts(ent, mentions);

    // Edit/Done toggle — flip between the browse and edit versions of the page.
    // (defined once; see above)

    // ---- EDIT-ONLY wiring (these elements exist only in the edit version of the page) ----------
    const noteTa = root.querySelector("#ent-note-input");

    // Save a single fact by hand (tap a chip to correct what was extracted).
    async function saveFact(k, val) {
      val = String(val || "").trim();
      const fresh = (await getEntity(id)) || ent;
      const facts = { ...(fresh.facts || {}) };
      if (k === "age") { const n = (val.match(/\d{1,3}/) || [])[0]; if (n) facts.age = Number(n); else if (val) facts.age = val; else delete facts.age; }
      else if (val) facts[k] = val; else delete facts[k];
      await putEntity({ ...fresh, facts, recognized: true, updatedAt: Date.now() });
      ent.facts = facts; refreshChips();
      onProgress && onProgress();
    }
    // Merge extracted facts in — only fills a topic that's still blank, so live extraction can't
    // clobber something you corrected by hand.
    async function applyFacts(newFacts) {
      // A live reading that lands after you saved or left belongs to text that's gone — drop it
      // (otherwise clearing your words and saving quickly would bring the old facts back).
      if (!live()) return;
      const fresh = (await getEntity(id)) || ent;
      if (!live()) return;
      const facts = { ...(fresh.facts || {}) };
      let changed = false;
      for (const [k, v] of Object.entries(newFacts || {})) {
        const has = facts[k] != null && String(facts[k]).trim() !== "";
        if (!has && v != null && String(v).trim() !== "") { facts[k] = v; changed = true; }
      }
      if (changed) { await putEntity({ ...fresh, facts, recognized: true, updatedAt: Date.now() }); ent.facts = facts; refreshChips(); onProgress && onProgress(); }
    }
    function refreshChips() { const w = live() && root.querySelector("#fact-chips"); if (w) w.innerHTML = factChipsInner(ent); }
    // Tap a chip → correct that one field inline (the only "manual" path; talking is the main one).
    const chipsWrap = root.querySelector("#fact-chips");
    const chipLabels = new Map(factFields(ent));
    chipsWrap?.addEventListener("click", (e) => {
      const chip = e.target.closest(".fact-chip");
      if (!chip || chip.classList.contains("editing")) return;
      const k = chip.dataset.k, label = chipLabels.get(k) || "", cur = factValue(ent.facts || {}, k);
      chip.classList.add("editing");
      chip.innerHTML = `<span class="fc-k">${escapeHtml(label)}</span><input class="fc-input" value="${escapeHtml(cur)}" autocomplete="off">`;
      const inp = chip.querySelector(".fc-input");
      inp.focus(); try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch { /* */ }
      inp.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); inp.blur(); } });
      inp.addEventListener("blur", () => saveFact(k, inp.value));
    });

    if (noteTa) {
      // ONE background call does both: extract this entity's facts AND the names it mentions, then
      // fill the chips (invisibly) and light up names. You just talk; we listen and extract.
      const hasFacts = factFields(ent).length > 0;
      const remote = async (text, signal) => {
        const res = await postCapture(text, signal);
        if (res && hasFacts) await applyFacts(res.facts);
        // On YOUR page, listing family/friends creates their cards right away, so you can go describe
        // them in Names next (this is what feeds the guided Journal → Me → Names → Stories loop).
        if (res && selfMode && res.names && res.names.length) { try { await resolveEntityNames(res.names); } catch { /* */ } }
        return { names: (res && res.names || []).map((n) => ({ name: n.name, kind: n.kind })) };
      };
      // Clicking a found name jumps to that person's page (in edit mode, to add info). Save the note
      // first so nothing you've typed is lost on the way.
      const onPick = async (name) => {
        autoSaveNote(); // your words stay in the draft; nothing is lost by jumping to the name
        try {
          const ids = await resolveEntityNames([{ name, kind: "person" }]);
          const rid = (ids || []).find((x) => x && x !== id) || (ids || [])[0];
          if (rid) { openId = rid; entEditing = true; renderEntity(rid); }
        } catch { /* */ }
      };
      const noteCap = attachLiveCapture(noteTa, { mount: root.querySelector("#ent-note-found"), buckets: ["names"], remote: hasFacts ? remote : undefined, onPick, exclude: [ent.canonical, ...(ent.aliases || [])] });
      // Auto-grow the box to fit its content — new lines push what's below down (consistent with the
      // Journal/Stories boxes); all the text stays editable with the keyboard.
      const noteGrow = () => { noteTa.style.height = "auto"; noteTa.style.height = noteTa.scrollHeight + "px"; };
      // Keep a draft of the box as you write, so leaving never loses your words (Save or Cancel clears
      // it). Restore any unsaved draft when the box opens.
      const autoSaveNote = () => { try { localStorage.setItem(entDraftKey(id), noteTa.value); } catch { /* */ } };
      try { const d = localStorage.getItem(entDraftKey(id)); if (d && d !== noteTa.value) noteTa.value = d; } catch { /* */ }
      const noteOnText = () => { noteCap.update(); noteGrow(); autoSaveNote(); };
      noteTa.addEventListener("input", noteOnText);
      setupDictation(root.querySelector("#ent-note-mic"), noteTa, root.querySelector("#ent-pstatus"), noteOnText);
      requestAnimationFrame(noteGrow); // fit the existing note on open
      noteCap.update();
    }

    // After Save: turn your words into facts, linked names, and a fresh profile. Runs in the
    // BACKGROUND with no page access — you may be on another name by the time it finishes.
    async function processNote(text) {
      if (!text) {
        // Your words are gone → so are the facts and profile drawn from them (mentions can rewrite a profile).
        await updateEntity(id, ent, (cur) => ({ ...cur, facts: {}, profile: "", profileAt: 0, updatedAt: Date.now() }));
      } else {
        // A note names other people and carries standard facts. For kinds with a fact checklist
        // (person/place/org) extractFacts does both (facts + names); otherwise just pull the names.
        try {
          const fresh = (await getEntity(id)) || ent;
          if (FACT_FIELDS[fresh.entityKind || "person"]) await extractFacts(fresh, mentions);
          else {
            const { mentions: mm } = await postEntities(text);
            const refs = mm && mm.length ? (await resolveEntityNames(mm)).filter((rid) => rid !== id) : [];
            if (refs.length) await updateEntity(id, ent, (cur) => ({ ...cur, noteRefs: [...new Set([...(cur.noteRefs || []), ...refs])], updatedAt: Date.now() }));
          }
        } catch { /* the words are saved; facts can be refreshed later */ }
      }
      const fresh = (await getEntity(id)) || ent;
      if (fresh.note || mentions.length) { try { await writeProfile(fresh, mentions); } catch { /* Refresh on its page */ } }
    }
    // Save = keep everything you changed (your words + name/kind/aliases) and go straight to READ.
    // The slow part (facts, names, profile) follows in the background — it never pulls you back here.
    root.querySelector("#ent-note-add")?.addEventListener("click", async () => {
      const ta = root.querySelector("#ent-note-input");
      const text = (ta && ta.value || "").trim();
      if (!text && !hasContent) { pstatus("Nothing to save yet.", ""); return; }
      pstatus("Saving…", "working");
      // Name / kind / aliases from the Details fold, plus your words (REPLACES the note, so you can
      // correct or delete bad text).
      const newName = (root.querySelector("#ent-rename")?.value || "").trim();
      const kindV = root.querySelector("#ent-kind")?.value;
      const aliasesV = (root.querySelector("#ent-aliases")?.value || "").split(",").map((s) => s.trim()).filter(Boolean);
      const cur = (await getEntity(id)) || ent;
      const renamed = newName && newName !== cur.canonical;
      await putEntity({ ...cur, canonical: newName || cur.canonical, entityKind: kindV || cur.entityKind, aliases: aliasesV, note: text, recognized: true, reviewedAt: Date.now(), updatedAt: Date.now() });
      Object.assign(ent, { canonical: newName || cur.canonical, entityKind: kindV || cur.entityKind, aliases: aliasesV, note: text, recognized: true });
      if (renamed || kindV !== cur.entityKind) { resetEntityIndex(); setEntityMap(new Map((await getAllEntities()).map((e) => [e.id, e.canonical]))); }
      try { localStorage.removeItem(entDraftKey(id)); } catch { /* */ }
      onProgress && onProgress(); // a note describes this name → the guided "Next" can move on
      processing.add(id);
      editSnapshot = null; entEditing = null;
      await renderEntity(id); // your result, in READ, right away
      const shown = viewSeq;
      processNote(text).finally(() => {
        processing.delete(id);
        // Still reading this very page, untouched? Then show the finished facts + profile in place.
        // Anywhere else — another name, Edit, another tab — leave you alone.
        if (viewSeq === shown && openId === id && !root.hidden) renderEntity(id);
      });
    });

    // Ask about this entity — answered only from the entries that mention it.
    root.querySelector("#ent-ask-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = root.querySelector("#ent-ask-input");
      const ans = root.querySelector("#ent-ask-answer");
      const q = input.value.trim();
      if (!q) return;
      ans.hidden = false;
      ans.innerHTML = `<p class="ent-ask-working">◷ Reading ${escapeHtml(ent.canonical)}'s ${mentions.length} mention${mentions.length === 1 ? "" : "s"}…</p>`;
      try {
        const entries = mentions.map((s) => ({
          date: s.date || `${s.startYear || ""}`, dayOfWeek: s.dayOfWeek || "",
          brief: s.brief || (s.prose && s.prose.brief) || "", full: s.full || s.raw || s.text || "",
        }));
        if (ent.note) entries.unshift({ date: `My notes about ${ent.canonical}`, dayOfWeek: "", brief: "", full: ent.note });
        const sys = `Answer only about "${ent.canonical}"${(ent.aliases && ent.aliases.length) ? ` (also known as ${ent.aliases.join(", ")})` : ""}. Use only the entries below (they include "My notes about ${ent.canonical}", my own authoritative words, plus the journal entries mentioning them). Be concise and cite dates.`;
        const { reply } = await postChat([{ role: "user", content: `${sys}\n\n${q}` }], entries);
        if (!live()) return; // you've left this page
        ans.innerHTML = renderAnswerText(reply)
          + `<button type="button" class="ent-ask-save" id="ent-ask-save">Save as background</button>`;
        root.querySelector("#ent-ask-save")?.addEventListener("click", async () => {
          const fresh = (await getEntity(id)) || ent;
          const note = (fresh.note ? fresh.note + "\n" : "") + reply.trim();
          await putEntity({ ...fresh, note, updatedAt: Date.now() });
          ent.note = note;
          const box = root.querySelector(".ent-note-existing");
          if (box) box.innerHTML = renderAnswerText(note);
          else root.querySelector("#ent-note-input")?.closest(".node-comment-row")?.insertAdjacentHTML("beforebegin", `<div class="ent-note-existing">${renderAnswerText(note)}</div>`);
          genProfile();
        });
      } catch (err) {
        if (!live()) return;
        ans.innerHTML = `<p class="ent-ask-err">Couldn't answer: ${escapeHtml((err && err.message) || String(err))}</p>`;
      }
    });

    root.querySelector("#ent-back")?.addEventListener("click", () => { openId = null; render(); });

    // (Name, kind and aliases are saved by the page's Save button, so Cancel can undo them too.)
    const deleteThisName = async () => {
      if (!confirm(`Delete “${ent.canonical}”? Its mentions stay in the entries; only the name is removed.`)) return;
      await removeEntity(id);
      openId = null; render();
    };
    root.querySelector("#ent-del-big")?.addEventListener("click", deleteThisName); // Delete — at the bottom of Edit
    root.querySelector("#ent-merge-btn")?.addEventListener("click", async () => {
      const targetId = root.querySelector("#ent-merge-sel").value;
      if (!targetId || targetId === id) return;
      await mergeInto(id, targetId, dstatus);
    });
  }

  // Merge entity `fromId` into `intoId`: fold names/aliases, re-point every entry's refs, delete `from`.
  async function mergeInto(fromId, intoId, status) {
    status && status("Merging…", "working");
    const [from, into, sources] = await Promise.all([getEntity(fromId), getEntity(intoId), allSources()]);
    if (!from || !into) { status && status("Couldn't merge — entity not found.", "error"); return; }
    const aliases = new Set([...(into.aliases || []), ...(from.aliases || [])]);
    if (from.canonical && from.canonical.toLowerCase() !== into.canonical.toLowerCase()) aliases.add(from.canonical);
    await putEntity({ ...into, aliases: [...aliases], note: into.note || from.note || "", updatedAt: Date.now() });
    for (const s of sources) {
      if (Array.isArray(s.entityRefs) && s.entityRefs.includes(fromId)) {
        const refs = [...new Set(s.entityRefs.map((x) => (x === fromId ? intoId : x)))];
        if (s.date) await putEntry({ ...s, entityRefs: refs }); else await putMemory({ ...s, entityRefs: refs });
      }
    }
    await deleteEntity(fromId);
    resetEntityIndex(); // merged aliases/removed id
    openId = intoId;
    render();
  }

  // ---- Hands-free interview: go name after name, the app asks, you answer aloud --------------
  let iv = null; // { active, recog }

  // Pick a natural-sounding voice. Browsers ship robotic defaults alongside much better ones
  // ("… Natural", Google, Apple's Samantha/Ava, Microsoft Online Natural); prefer those. The
  // reader's saved choice (localStorage) wins.
  function englishVoices() { try { return (speechSynthesis.getVoices() || []).filter((v) => /^en(-|_|$)/i.test(v.lang)); } catch { return []; } }
  function pickVoice() {
    const voices = englishVoices();
    if (!voices.length) return null;
    const saved = localStorage.getItem("tts-voice");
    if (saved) { const m = voices.find((v) => v.voiceURI === saved || v.name === saved); if (m) return m; }
    const score = (v) => {
      const n = v.name.toLowerCase();
      let s = 0;
      if (/natural|neural|premium|enhanced/.test(n)) s += 50;
      if (/google/.test(n)) s += 30;
      if (/\b(samantha|ava|allison|serena|zoe|jenny|aria|libby|sonia)\b/.test(n)) s += 25;
      if (/\ben-us\b|en_us/i.test(v.lang)) s += 5;
      if (v.localService) s += 3;
      return s;
    };
    return voices.slice().sort((a, b) => score(b) - score(a))[0];
  }
  // Voices can load asynchronously; nudge them.
  try { if (!speechSynthesis.getVoices().length) speechSynthesis.onvoiceschanged = () => {}; } catch { /* */ }

  // ChatGPT-quality OpenAI voice (character-steered), with browser fallback — the same speaker the
  // reveal and life interview use. unlock() is called on the interview's start tap (mobile audio).
  const ivSpeaker = createSpeaker((m) => { const el = document.getElementById("iv-voicestatus"); if (el) el.textContent = "🔊 " + m; });
  const speak = (text) => ivSpeaker.speak(text);
  // Listen for a whole answer, however long. Recognition runs continuously and RESTARTS through the
  // browser's own silence cutoff, so pauses never end the turn. A turn ends only when: you go quiet
  // for a longer stretch after speaking (SIL_MS), or you tap Done / Skip / Stop.
  const SIL_MS = 5000; // 5s of silence ends your answer automatically — no tap needed
  // Fallback when Web Speech isn't available (e.g. iOS Safari): a textarea you dictate into with the
  // keyboard's own mic (or type), ended with Done. Web Speech (below) is used everywhere it exists.
  function listenTurnMobile() {
    return new Promise((resolve) => {
      const box = document.getElementById("iv-input-wrap");
      if (!box) return resolve("");
      box.hidden = false;
      box.innerHTML = `<textarea id="iv-input" class="node-comment-input" rows="3" placeholder="Tap here and use the mic on your keyboard, or type…"></textarea>`;
      const ta = box.querySelector("#iv-input");
      ta.focus();
      iv.finishTurn = (result) => { iv.finishTurn = null; box.hidden = true; const v = box.querySelector("#iv-input"); resolve(result !== undefined ? result : (v ? v.value.trim() : "")); };
    });
  }
  async function listenTurn() {
    if (!hasSpeechInput) return listenTurnMobile(); // no Web Speech at all → type/Gboard fallback
    const ctrl = {};
    iv.finishTurn = (cmd) => { if (cmd === "__stop__") ctrl.stop && ctrl.stop(); else if (cmd === "__skip__") ctrl.skip && ctrl.skip(); else ctrl.finish && ctrl.finish(); };
    const res = await vListen({ silenceMs: SIL_MS, onInterim: (t) => setInterview({ interim: t }), control: ctrl });
    iv.finishTurn = null;
    if (res.command === "stop") return "__stop__";
    if (res.command === "skip") return "__skip__";
    return res.text;
  }
  async function getQuestion(ent, mentions, convo) {
    const entries = mentions.map((s) => ({ date: s.date || `${s.startYear || ""}`, brief: s.brief || (s.prose && s.prose.brief) || "", full: s.full || s.raw || s.text || "" }));
    const convoText = convo.map((c) => `Q: ${c.q}\nA: ${c.a}`).join("\n") || "(none yet)";
    // IDENTIFICATION only — who this is, how I know them, their role. NOT feelings or relationship
    // depth (that richer interview can come later, from all input). Keep it factual and brief.
    const sys = `You are helping me IDENTIFY "${ent.canonical}" — just establish who they are, plainly.${ent.note ? ` What I've said so far: ${ent.note}` : ""} Below are the journal entries that mention them. Ask ONE short spoken question (one sentence) to pin down a basic identifying fact still missing: who they are, how I know them, their role/relation, where they fit — NOT how I feel about them, not emotional or reflective questions. Don't repeat what's known or asked. If they're already identified, reply with exactly the word ENOUGH.\n\nConversation so far:\n${convoText}`;
    try { const { reply } = await postChat([{ role: "user", content: `${sys}\n\nYour next question (or ENOUGH):` }], entries); return (reply || "").trim(); }
    catch { return ""; }
  }

  async function startInterview() {
    if (iv && iv.active) return;
    if (!IS_MOBILE && !SpeechRec) { alert("Voice interview needs speech recognition (try Chrome on desktop), or use it on your phone with the keyboard mic."); return; }
    ivSpeaker.unlock(); // inside the start-tap gesture → let mobile play the OpenAI voice afterward
    const ents = await getAllEntities();
    if (!ents.length) return;
    // Cover EVERY name: un-reviewed first (never seen in an interview), then no-notes, people first.
    const rank = (e) => (e.reviewedAt ? 4 : 0) + (e.note ? 2 : 0) + (e.entityKind === "person" || e.entityKind === "animal" ? 0 : 1);
    const queue = [...ents].sort((a, b) => rank(a) - rank(b) || a.canonical.localeCompare(b.canonical));
    iv = { active: true, recog: null };
    renderInterview({ status: "Starting…" });
    await speak("I'll go through the names one by one. Tell me who each one is, or say you don't know. Say stop to end.");
    const sources = await allSources();
    // "I don't know / don't recognize this" — a short answer that's essentially not-knowing.
    const isDontKnow = (t) => t.length < 60 && /\b(don'?t know|do not know|dont know|don'?t recognize|no idea|not sure|never heard|can'?t remember|cannot remember|doesn'?t ring|no clue|not a clue|who (is|are|'s)? ?(this|that|they|it))\b/i.test(t);
    for (const ent of queue) {
      if (!iv.active) break;
      const mentions = sources.filter((s) => Array.isArray(s.entityRefs) && s.entityRefs.includes(ent.id));
      const convo = [];
      renderInterview({ name: ent.canonical });
      for (let asked = 0; iv.active && asked < 2; asked++) {
        const q = asked === 0
          ? `Who is ${ent.canonical}?`
          : await getQuestion(ent, mentions, convo);
        if (!iv.active) break;
        if (!q || /^enough\b/i.test(q)) break;
        renderInterview({ name: ent.canonical, q });
        await speak(q);
        if (!iv.active) break;
        renderInterview({ name: ent.canonical, q, listening: true });
        const ans = await listenTurn();
        if (!iv.active || ans === "__stop__") { iv.active = false; break; }
        if (ans === "__skip__" || !ans) { await speak("Okay — next."); break; } // skip: revisit later, no flag
        // "Don't know" → FLAG this name (a mistake or a memory hole) for future reference; don't save as fact.
        if (isDontKnow(ans)) {
          const fresh = (await getEntity(ent.id)) || ent;
          await putEntity({ ...fresh, recognized: false, reviewedAt: Date.now(), updatedAt: Date.now() });
          renderInterview({ name: ent.canonical, q, a: "(didn't recognize — flagged)" });
          await speak("Noted — I'll flag that one.");
          break;
        }
        convo.push({ q, a: ans });
        renderInterview({ name: ent.canonical, q, a: ans });
        const fresh = (await getEntity(ent.id)) || ent;
        const merged = { ...fresh, note: (fresh.note ? fresh.note + "\n" : "") + ans, recognized: true, reviewedAt: Date.now(), updatedAt: Date.now() };
        await putEntity(merged);
        // Revise the visible name's summary at the top from the new note (+ its mentions), live.
        renderInterview({ name: ent.canonical, profileWorking: true });
        try { const p = await writeProfile(merged, mentions); renderInterview({ name: ent.canonical, profile: p }); } catch { /* keep going */ }
      }
    }
    if (iv.active) await speak("That's every name. Thanks — I've saved your notes and flagged the ones you didn't recognize.");
    endInterview();
  }
  function endInterview() {
    if (iv && iv.recog) { try { iv.recog.stop(); } catch { /* */ } }
    ivSpeaker.cancel();
    iv = null;
    const ov = document.getElementById("iv-overlay"); if (ov) ov.remove();
    render(); // refresh the roster (notes/counts changed)
  }
  function setInterview(patch) {
    const el = document.getElementById("iv-interim"); if (el && patch.interim != null) el.textContent = patch.interim;
  }
  function renderInterview(s = {}) {
    let ov = document.getElementById("iv-overlay");
    if (!ov) {
      ov = document.createElement("div"); ov.id = "iv-overlay"; ov.className = "iv-overlay";
      ov.innerHTML = `<div class="iv-card">
        <div class="iv-name" id="iv-name"></div>
        <div class="iv-profile" id="iv-profile"></div>
        <div class="iv-q" id="iv-q"></div>
        <div class="iv-interim" id="iv-interim"></div>
        <div class="iv-a" id="iv-a"></div>
        <div class="iv-input-wrap" id="iv-input-wrap" hidden></div>
        <div class="iv-saved" id="iv-saved"></div>
        <div class="iv-actions">
          <button type="button" id="iv-done" class="iv-done">✓ Done</button>
          <button type="button" id="iv-skip">Skip ›</button>
          <button type="button" id="iv-stop">Stop</button>
        </div>
        <label class="iv-voice"><span>Voice</span> <select id="iv-voice-sel">${CHARACTERS.map((c) => `<option value="${c.id}"${c.id === savedCharacter() ? " selected" : ""}>${c.label}</option>`).join("")}</select></label>
        <p class="iv-voicestatus" id="iv-voicestatus"></p>
        <p class="iv-hint">${SpeechRec
          ? "Talk as long as you like — pause about 5 seconds and it moves on. Skip for the next name, Stop to end."
          : "Tap the answer box and use the mic on your keyboard, then tap Done. Skip for the next name, Stop to end."}</p>
      </div>`;
      document.body.appendChild(ov);
      // Done ends the current answer; Skip moves to the next name; Stop ends the interview.
      ov.querySelector("#iv-done").addEventListener("click", () => { if (iv && iv.finishTurn) iv.finishTurn(); });
      ov.querySelector("#iv-skip").addEventListener("click", () => { if (iv && iv.finishTurn) iv.finishTurn("__skip__"); });
      // Stop ALWAYS closes the overlay, even if the interview loop is wedged (e.g. speech recognition
      // died) — so it can never get stuck open.
      ov.querySelector("#iv-stop").addEventListener("click", () => { if (iv) { iv.active = false; try { iv.finishTurn && iv.finishTurn("__stop__"); } catch { /* */ } } endInterview(); });
      ov.querySelector("#iv-voice-sel").addEventListener("change", (e) => localStorage.setItem("tts-character", e.target.value));
    }
    if (s.name != null) { ov.querySelector("#iv-name").textContent = s.name; ov.querySelector("#iv-profile").innerHTML = ""; } // new name → clear old profile
    if (s.q != null) ov.querySelector("#iv-q").textContent = s.q;
    if (s.status != null) ov.querySelector("#iv-q").textContent = s.status;
    if (s.a != null) { ov.querySelector("#iv-a").textContent = s.a ? `“${s.a}”` : ""; ov.querySelector("#iv-interim").textContent = ""; }
    if (s.listening) { ov.querySelector("#iv-interim").textContent = "…listening"; ov.querySelector("#iv-a").textContent = ""; }
    if (s.profileWorking) ov.querySelector("#iv-profile").innerHTML = `<span class="iv-profile-working">◷ updating summary…</span>`;
    if (s.profile != null) ov.querySelector("#iv-profile").innerHTML = renderAnswerText(s.profile);
  }

  // Delegated once on the stable root (survives re-renders): open an entity card, or jump to a mention.
  root.addEventListener("click", async (e) => {
    const del = e.target.closest(".ent-card-del[data-del]");
    if (del) {
      const idToDel = del.dataset.del;
      const ent = await getEntity(idToDel);
      if (ent && confirm(`Delete “${ent.canonical}”? Its mentions stay in the entries; only the name is removed.`)) {
        await removeEntity(idToDel);
        render();
      }
      return;
    }
    const card = e.target.closest(".ent-card[data-open]");
    if (card && selecting && !openId) {
      // Select mode: a tap picks / unpicks (updated in place — no redraw, so the list doesn't jump).
      const cid = card.dataset.open;
      if (selected.has(cid)) selected.delete(cid); else selected.add(cid);
      const on = selected.has(cid);
      card.classList.toggle("ent-card-picked", on);
      const mark = card.querySelector(".ent-pick"); if (mark) mark.textContent = on ? "☑" : "☐";
      const cnt = root.querySelector("#ent-selcount"); if (cnt) cnt.textContent = `${selected.size} selected`;
      const del = root.querySelector("#ent-sel-del"); if (del) { del.disabled = !selected.size; del.textContent = `Delete ${selected.size || ""}`; }
      return;
    }
    if (card) { openId = card.dataset.open; entEditing = null; renderEntity(openId); return; }
    const m = e.target.closest(".ent-mention[data-goto]");
    if (!m) return;
    if (m.dataset.kind === "day") onOpenDay?.(m.dataset.goto);
    else onOpenMemory?.(m.dataset.goto);
  });

  return {
    open() { openId = null; selecting = false; selected.clear(); render(); }, // Names always lands on the roster (Me lives in its own tab)
    async openSelf() { selecting = false; selected.clear(); const s = await ensureSelf(); openId = s.id; entEditing = null; renderEntity(s.id); }, // Me: write if empty, else read + Edit
    openEntity(id) { selecting = false; selected.clear(); openId = id; entEditing = null; renderEntity(id); }, // a name: write if empty, else read + Edit
    async nextUndescribed() { // the next name still needing a word, in the list's order — for the guided "Next"
      const [all, sources] = await Promise.all([getAllEntities(), allSources()]);
      const idx = mentionIndex(sources);
      const empty = new Set(all.filter((e) => needsYou(e, (idx.get(e.id) || []).length)).map((e) => e.id));
      // Walk the list's order from just past the open name (wrapping), so Next moves forward through it.
      // Before the list has been drawn, any empty name will do. (Names described since it was drawn
      // drop out via `empty`; hidden once-mentioned names are never suggested.)
      const order = needOrder || all.map((e) => e.id);
      const at = openId ? order.indexOf(openId) : -1;
      for (let i = 1; i <= order.length; i++) { const id = order[(at + i + order.length) % order.length]; if (id !== openId && empty.has(id)) return id; }
      return null;
    },
    close() { if (iv) { iv.active = false; endInterview(); } },
  };
}
