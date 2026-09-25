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
import { escapeHtml } from "./render.js";
import { add as logAdd, set as logSet } from "./llmlog.js";
import { setupDictation, IS_MOBILE } from "./dictation.js";
import { resolveEntityNames, resetEntityIndex } from "./entityresolve.js";
import { createSpeaker, CHARACTERS, savedCharacter } from "./voicetts.js";

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
  const esc = String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return "<p>" + esc.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br>") + "</p>";
}

// Write (and save) an entity's profile from MY notes + the journal entries that mention it. The note
// is passed AS AN ENTRY so /api/chat treats it as source-of-truth. Shared by the name page and the
// hands-free interview. Returns the profile text.
async function writeProfile(ent, mentions) {
  const entries = (mentions || []).map((s) => ({ date: s.date || `${s.startYear || ""}`, brief: s.brief || (s.prose && s.prose.brief) || "", full: s.full || s.raw || s.text || "" }));
  if (ent.note) entries.unshift({ date: `My notes about ${ent.canonical}`, full: ent.note });
  const sys = `Write a short profile of "${ent.canonical}"${(ent.aliases && ent.aliases.length) ? ` (also known as ${ent.aliases.join(", ")})` : ""}, using the entries below (they include "My notes about ${ent.canonical}" — my own authoritative words — and the journal entries that mention them). In 2–4 sentences, first person from my view: who they are, our relationship, and how it changed over time; mention years where useful. My notes win where they conflict with the journal.`;
  const { reply } = await postChat([{ role: "user", content: `${sys}\n\nWrite the profile now.` }], entries);
  const fresh = (await getEntity(ent.id)) || ent;
  await putEntity({ ...fresh, profile: reply, profileAt: Date.now(), updatedAt: Date.now() });
  return reply;
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

export function initEntities(root, { onOpenDay, onOpenMemory } = {}) {
  let openId = null; // entity being viewed, or null = the roster
  let scanning = false;
  let showSingles = false; // one-off names (mentioned only once) are hidden until you ask for them

  async function allSources() {
    const [days, mems] = await Promise.all([getAllEntries(), getAllMemories()]);
    return [...days, ...mems];
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

  // ---- Roster (the entity list) --------------------------------------------------------------
  async function render() {
    if (openId) { renderEntity(openId); return; }
    const [entities, sources] = await Promise.all([getAllEntities(), allSources()]);
    // Count mentions per entity from the tagged sources.
    const counts = new Map();
    let taggedCount = 0;
    for (const s of sources) {
      if (Array.isArray(s.entityRefs)) { taggedCount++; for (const id of s.entityRefs) counts.set(id, (counts.get(id) || 0) + 1); }
    }
    const total = sources.filter((s) => s.raw || s.text).length;

    // A name mentioned only ONCE across all entries is usually noise (a one-off or a mishear). Hide
    // those by default — but always keep ones you've engaged with (a note, a flag, or a profile).
    const keep = (e) => (counts.get(e.id) || 0) >= 2 || !!e.note || e.recognized === false || !!e.profile;
    const singles = entities.filter((e) => !keep(e));
    const visible = showSingles ? entities : entities.filter(keep);

    const byKind = new Map();
    for (const e of visible) {
      const k = e.entityKind || "person";
      if (!byKind.has(k)) byKind.set(k, []);
      byKind.get(k).push(e);
    }
    const sections = KIND_ORDER.filter((k) => byKind.has(k)).map((k) => {
      const list = byKind.get(k).sort((a, b) => (counts.get(b.id) || 0) - (counts.get(a.id) || 0) || a.canonical.localeCompare(b.canonical));
      const cards = list.map((e) => `
        <div class="ent-card-wrap">
          <button type="button" class="ent-card${e.recognized === false ? " ent-card-flag" : ""}" data-open="${escapeHtml(e.id)}">
            <span class="ent-name">${escapeHtml(e.canonical)}</span>
            ${e.recognized === false ? `<span class="ent-flag">🕳 didn't recognize</span>` : (e.aliases && e.aliases.length) ? `<span class="ent-aka">aka ${escapeHtml(e.aliases.join(", "))}</span>` : ""}
            <span class="ent-count">${counts.get(e.id) || 0}</span>
          </button>
          <button type="button" class="ent-card-del" data-del="${escapeHtml(e.id)}" title="Delete this name" aria-label="Delete">×</button>
        </div>`).join("");
      return `<h3 class="ent-kind">${KIND_LABEL[k] || k}s</h3><div class="ent-grid">${cards}</div>`;
    }).join("");

    root.innerHTML = `
      <div class="entities">
        <div class="ent-head">
          <h2 class="ent-title">People &amp; Animals</h2>
          <div class="act-actions">
            ${entities.length ? `<button type="button" class="ent-scan ent-interview-btn" id="ent-interview">🎙 Interview me</button>` : ""}
            <button type="button" class="ent-scan" id="ent-scan">${entities.length ? "Scan new entries" : "Scan entries"}</button>
          </div>
        </div>
        <p class="field-hint">Everyone and everything your journal names, each with every mention in time order. Merge two cards if they're the same individual under different names.</p>
        <div id="ent-status" class="ent-status" hidden></div>
        ${total === 0
          ? `<p class="ent-empty">No entries yet — write or imagine some days first.</p>`
          : entities.length === 0
            ? `<p class="ent-empty">Nothing scanned yet. Tap “Scan entries” to find the people and animals in your journal.</p>`
            : sections
              + (singles.length ? `<button type="button" class="ent-singles-toggle" id="ent-singles">${showSingles ? "Hide" : "Show"} ${singles.length} name${singles.length === 1 ? "" : "s"} mentioned once</button>` : "")
              + (taggedCount < total ? `<p class="field-hint" style="margin-top:1rem">${total - taggedCount} entr${total - taggedCount === 1 ? "y" : "ies"} not yet scanned — tap “Scan new entries”.</p>` : "")}
      </div>`;

    root.querySelector("#ent-scan")?.addEventListener("click", () => scan(setStatus));
    root.querySelector("#ent-interview")?.addEventListener("click", () => startInterview());
    root.querySelector("#ent-singles")?.addEventListener("click", () => { showSingles = !showSingles; render(); });
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
    if (!ent) { openId = null; render(); return; }
    const mentions = sources.filter((s) => Array.isArray(s.entityRefs) && s.entityRefs.includes(id))
      .sort((a, b) => itemSortKey(a).localeCompare(itemSortKey(b)));
    const rows = mentions.map((s) => {
      const brief = s.brief || (s.prose && s.prose.brief) || (s.levels && s.levels.sentence) || (s.raw || s.text || "").slice(0, 120);
      const kind = s.date ? "day" : "mem";
      const key = s.date || s.id;
      return `<button type="button" class="ent-mention" data-goto="${escapeHtml(key)}" data-kind="${kind}">
        <span class="ent-when">${escapeHtml(itemWhen(s))}</span>
        <span class="ent-snip">${escapeHtml(brief)}</span>
      </button>`;
    }).join("");
    const others = entities.filter((e) => e.id !== id).sort((a, b) => a.canonical.localeCompare(b.canonical));
    const mergeOpts = others.map((e) => `<option value="${escapeHtml(e.id)}">${escapeHtml(e.canonical)}</option>`).join("");

    root.innerHTML = `
      <div class="entities">
        <button type="button" class="ent-back" id="ent-back">← All names</button>
        <h2 class="node-name">${escapeHtml(ent.canonical)}</h2>
        <p class="node-subtitle">${KIND_LABEL[ent.entityKind || "person"]}${(ent.aliases && ent.aliases.length) ? ` · also ${escapeHtml(ent.aliases.join(", "))}` : ""}</p>
        ${ent.recognized === false ? `<p class="ent-flag-banner">🕳 You didn't recognize this name — a possible mistake or a memory hole. Add anything you can below, or it stays flagged.</p>` : ""}

        <!-- Profile paragraph at the top — written from the mentions PLUS your own notes below. -->
        <div class="node-summary ent-summary" id="ent-summary">
          ${ent.profile
            ? `${renderAnswerText(ent.profile)}<button type="button" class="ent-summary-refresh" id="ent-summary-refresh">↻ Refresh</button>`
            : mentions.length ? `<p class="ent-ask-working">◷ Writing ${escapeHtml(ent.canonical)}'s profile…</p>` : `<p class="ent-empty">No mentions yet — add a note below to start a profile.</p>`}
        </div>

        <!-- Your notes: a running transcript in your words, folded into the profile (like Write). -->
        <section class="node-comment">
          <p class="nav-hint">Your notes about ${escapeHtml(ent.canonical)} — added to the profile and to summaries that mention them.</p>
          ${ent.note ? `<div class="ent-note-existing">${renderAnswerText(ent.note)}</div>` : ""}
          <div class="node-comment-row">
            <textarea id="ent-note-input" class="node-comment-input" rows="2" placeholder="Speak or type — who they are, how you're connected, anything the journal gets wrong…"></textarea>
            <button type="button" class="node-comment-mic" id="ent-note-mic" hidden aria-label="Dictate">🎙</button>
          </div>
          <div class="node-comment-actions"><button type="button" class="node-comment-add" id="ent-note-add">Add &amp; update profile</button><span class="node-comment-status" id="ent-pstatus"></span></div>
        </section>

        <div class="ent-ask">
          <form class="ent-ask-form" id="ent-ask-form">
            <input type="text" id="ent-ask-input" placeholder="Ask about ${escapeHtml(ent.canonical)} — “who is ${escapeHtml(ent.canonical)}?”, “when did we meet?”">
            <button type="submit" class="ent-ask-btn">Ask</button>
          </form>
          <div id="ent-ask-answer" class="ent-ask-answer" hidden></div>
        </div>

        <h3 class="ent-kind">${mentions.length} mention${mentions.length === 1 ? "" : "s"}, in time order</h3>
        <div class="ent-mentions">${rows || '<p class="ent-empty">No mentions tagged yet.</p>'}</div>

        <details class="node-fold ent-details">
          <summary>Name, kind &amp; aliases</summary>
          <div class="node-fold-body ent-detail-body">
            <label class="ent-field"><span>Name</span>
              <input type="text" id="ent-canon" value="${escapeHtml(ent.canonical)}"></label>
            <label class="ent-field"><span>Kind</span>
              <select id="ent-kind" class="ent-kindsel">${KIND_ORDER.map((k) => `<option value="${k}"${(ent.entityKind || "person") === k ? " selected" : ""}>${KIND_LABEL[k]}</option>`).join("")}</select></label>
            <label class="ent-field"><span>Also known as (comma-separated)</span>
              <input type="text" id="ent-aliases" value="${escapeHtml((ent.aliases || []).join(", "))}" placeholder="Baby Kitty, Zay…"></label>
            <div class="ent-profile-actions">
              <button type="button" class="ent-save" id="ent-save">Save</button>
              ${others.length ? `<span class="ent-merge"><span>Merge into</span><select id="ent-merge-sel"><option value="">choose…</option>${mergeOpts}</select><button type="button" id="ent-merge-btn">Merge</button></span>` : ""}
              <button type="button" class="ent-del" id="ent-del">Delete</button>
            </div>
            <div id="ent-dstatus" class="ent-status" hidden></div>
          </div>
        </details>
      </div>`;

    const pstatus = (msg, cls) => { const el = root.querySelector("#ent-pstatus"); if (!el) return; el.textContent = msg; el.className = "node-comment-status" + (cls ? " " + cls : ""); };
    const dstatus = (msg, cls) => { const el = root.querySelector("#ent-dstatus"); if (!el) return; el.hidden = !msg; el.className = "ent-status" + (cls ? " " + cls : ""); el.textContent = msg; };

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
        box.innerHTML = `${renderAnswerText(reply)}<button type="button" class="ent-summary-refresh" id="ent-summary-refresh">↻ Refresh</button>`;
        root.querySelector("#ent-summary-refresh")?.addEventListener("click", genProfile);
      } catch (err) {
        box.innerHTML = `<p class="ent-ask-err">Couldn't write a profile: ${escapeHtml((err && err.message) || String(err))}</p><button type="button" class="ent-summary-refresh" id="ent-summary-refresh">↻ Try again</button>`;
        root.querySelector("#ent-summary-refresh")?.addEventListener("click", genProfile);
      }
    }
    root.querySelector("#ent-summary-refresh")?.addEventListener("click", genProfile);
    if (!ent.profile && (mentions.length || ent.note)) genProfile(); // auto-write on first open

    // Your notes — a growing transcript in your words. Adding appends to the note and rewrites the
    // profile (and, via the roster, folds into summaries that mention this name as they're rewritten).
    setupDictation(root.querySelector("#ent-note-mic"), root.querySelector("#ent-note-input"), root.querySelector("#ent-pstatus"), () => {});
    root.querySelector("#ent-note-add")?.addEventListener("click", async () => {
      const ta = root.querySelector("#ent-note-input");
      const text = (ta && ta.value || "").trim();
      if (!text) return;
      pstatus("Saving & updating profile…", "working");
      const fresh = (await getEntity(id)) || ent;
      const note = (fresh.note ? fresh.note + "\n" : "") + text;
      await putEntity({ ...fresh, note, recognized: true, reviewedAt: Date.now(), updatedAt: Date.now() }); // adding info clears a "didn't recognize" flag
      ent.note = note; ent.recognized = true;
      ta.value = "";
      // Show the appended note immediately, then regenerate the profile from mentions + notes.
      const box = root.querySelector(".ent-note-existing");
      if (box) box.innerHTML = renderAnswerText(note);
      else ta.closest(".node-comment-row")?.insertAdjacentHTML("beforebegin", `<div class="ent-note-existing">${renderAnswerText(note)}</div>`);
      pstatus("", "");
      genProfile();
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
        ans.innerHTML = `<p class="ent-ask-err">Couldn't answer: ${escapeHtml((err && err.message) || String(err))}</p>`;
      }
    });

    root.querySelector("#ent-back").addEventListener("click", () => { openId = null; render(); });
    root.querySelector("#ent-save").addEventListener("click", async () => {
      const fresh = (await getEntity(id)) || ent;
      const next = {
        ...fresh,
        canonical: root.querySelector("#ent-canon").value.trim() || fresh.canonical,
        entityKind: root.querySelector("#ent-kind").value,
        aliases: root.querySelector("#ent-aliases").value.split(",").map((s) => s.trim()).filter(Boolean),
        updatedAt: Date.now(),
      };
      await putEntity(next);
      Object.assign(ent, next);
      resetEntityIndex(); // name/aliases changed
      dstatus("Saved.", "ok");
    });
    root.querySelector("#ent-del")?.addEventListener("click", async () => {
      if (!confirm(`Delete “${ent.canonical}”? Its mentions stay in the entries; only the name is removed.`)) return;
      await removeEntity(id);
      openId = null; render();
    });
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
  function listenTurn() {
    if (!SpeechRec) return listenTurnMobile(); // no Web Speech at all → type/Gboard fallback
    return new Promise((resolve) => {
      let full = "", stopped = false, r = null, silence = null;
      const done = (result) => {
        if (stopped) return; stopped = true;
        clearTimeout(silence); iv.finishTurn = null;
        try { if (r) { r.onend = null; r.stop(); } } catch { /* */ }
        resolve(result !== undefined ? result : full.trim());
      };
      iv.finishTurn = done; // Done/Skip/Stop buttons call this
      const armSilence = () => { clearTimeout(silence); silence = setTimeout(() => { if (full.trim()) done(full.trim()); }, SIL_MS); };
      const start = () => {
        r = new SpeechRec(); r.lang = "en-US"; r.interimResults = true; r.continuous = true;
        r.onresult = (e) => {
          let interim = "";
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const res = e.results[i];
            if (res.isFinal) full += res[0].transcript + " "; else interim += res[0].transcript;
          }
          setInterview({ interim: (full + interim).trim() });
          armSilence();
        };
        r.onerror = () => { /* no-speech/aborted → let onend restart */ };
        // Restart through the browser's silence cutoff (mobile ignores `continuous`, so this loop is
        // what keeps it listening). A short delay avoids "already started" errors on rapid restarts.
        r.onend = () => { if (!stopped) setTimeout(() => { if (!stopped) start(); }, 250); };
        iv.recog = r;
        try { r.start(); } catch { setTimeout(() => { if (!stopped) start(); }, 400); }
      };
      start();
    });
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
      ov.querySelector("#iv-stop").addEventListener("click", () => { if (iv) { iv.active = false; if (iv.finishTurn) iv.finishTurn("__stop__"); else endInterview(); } });
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
    if (card) { openId = card.dataset.open; renderEntity(openId); return; }
    const m = e.target.closest(".ent-mention[data-goto]");
    if (!m) return;
    if (m.dataset.kind === "day") onOpenDay?.(m.dataset.goto);
    else onOpenMemory?.(m.dataset.goto);
  });

  return {
    open() { render(); },
    openEntity(id) { openId = id; renderEntity(id); }, // jump straight to one entity (from a name-link)
    close() { if (iv) { iv.active = false; endInterview(); } },
  };
}
