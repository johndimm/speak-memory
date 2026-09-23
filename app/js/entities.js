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
import { setupDictation } from "./dictation.js";

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

  async function allSources() {
    const [days, mems] = await Promise.all([getAllEntries(), getAllMemories()]);
    return [...days, ...mems];
  }

  // ---- Scan: tag every entry with the entities it names, resolving to the roster --------------
  async function scan(setStatus) {
    if (scanning) return;
    scanning = true;
    try {
      const sources = await allSources();
      let queue = sources.filter((s) => (s.raw || s.text) && !Array.isArray(s.entityRefs));
      if (!queue.length) { setStatus("Everything's already scanned. Re-scan anyway from an entry's page if a name looks off.", ""); return; }

      // The client keeps the roster and resolves names by NORMALIZED match (no roster sent to the
      // LLM — that wouldn't scale as the cast grows). A normalized index maps canonical + every alias
      // to its entity; an extracted name that matches lands on that entity, otherwise a new one is
      // created. Spelling variants that don't normalize-match become separate entities you can Merge.
      let roster = await getAllEntities();
      const byNorm = new Map();
      const indexEnt = (e) => { for (const n of [e.canonical, ...(e.aliases || [])]) { const k = normName(n); if (k) byNorm.set(k, e); } };
      roster.forEach(indexEnt);
      const total = queue.length;
      let found = 0;

      const scanOne = async (src) => {
        const text = src.raw || src.text || "";
        const label = src.date ? src.date : (src.subject || src.label || "memory");
        const jid = logAdd(label, "scan");
        logSet(jid, "running");
        const { mentions } = await postEntities(text); // LLM extracts names only
        const refs = [];
        for (const m of mentions) {
          const key = normName(m.name);
          if (!key) continue;
          let ent = byNorm.get(key); // resolve in JS by normalized name/alias
          if (!ent) {
            ent = { id: uid(), entityKind: m.kind || "person", canonical: m.name.trim(), aliases: [], note: "", createdAt: Date.now(), updatedAt: Date.now() };
            await putEntity(ent);
            roster.push(ent); indexEnt(ent);
            found++;
          }
          if (!refs.includes(ent.id)) refs.push(ent.id);
        }
        const next = { ...src, entityRefs: refs };
        if (src.date) await putEntry(next); else await putMemory(next);
        logSet(jid, "done");
      };

      let completed = 0;
      const btn = root.querySelector("#ent-scan");
      if (btn) btn.disabled = true;
      const tick = () => {
        setStatus(`◷ Scanning… ${completed} of ${total} entries${found ? ` · ${found} new names` : ""} — watch it live in Activity`, "working");
        if (btn) btn.textContent = `Scanning ${completed}/${total}…`;
      };
      tick();

      // Run several at once (the calls are slow), retrying flaky failures up to 3 passes. A source
      // that fails every pass stays untagged so a later "Scan new entries" picks it up.
      const CONCURRENCY = 4;
      for (let pass = 0; pass < 3 && queue.length; pass++) {
        const failures = [];
        let i = 0;
        const worker = async () => {
          while (i < queue.length) {
            const src = queue[i++];
            try { await scanOne(src); } catch { failures.push(src); }
            completed++;
            tick();
          }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
        queue = failures;
      }
      if (queue.length) setStatus(`Scanned — ${queue.length} still failing (tap “Scan new entries” to retry). ${found} new name${found === 1 ? "" : "s"}.`, "error");
      else setStatus(`Done — ${found} new name${found === 1 ? "" : "s"} across ${total} entr${total === 1 ? "y" : "ies"}.`, "ok");
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

    const byKind = new Map();
    for (const e of entities) {
      const k = e.entityKind || "person";
      if (!byKind.has(k)) byKind.set(k, []);
      byKind.get(k).push(e);
    }
    const sections = KIND_ORDER.filter((k) => byKind.has(k)).map((k) => {
      const list = byKind.get(k).sort((a, b) => (counts.get(b.id) || 0) - (counts.get(a.id) || 0) || a.canonical.localeCompare(b.canonical));
      const cards = list.map((e) => `
        <button type="button" class="ent-card" data-open="${escapeHtml(e.id)}">
          <span class="ent-name">${escapeHtml(e.canonical)}</span>
          ${(e.aliases && e.aliases.length) ? `<span class="ent-aka">aka ${escapeHtml(e.aliases.join(", "))}</span>` : ""}
          <span class="ent-count">${counts.get(e.id) || 0}</span>
        </button>`).join("");
      return `<h3 class="ent-kind">${KIND_LABEL[k] || k}s</h3><div class="ent-grid">${cards}</div>`;
    }).join("");

    root.innerHTML = `
      <div class="entities">
        <div class="ent-head">
          <h2 class="ent-title">People &amp; Animals</h2>
          <div class="act-actions">
            ${(SpeechRec && entities.length) ? `<button type="button" class="ent-scan ent-interview-btn" id="ent-interview">🎙 Interview me</button>` : ""}
            <button type="button" class="ent-scan" id="ent-scan">${entities.length ? "Scan new entries" : "Scan entries"}</button>
          </div>
        </div>
        <p class="field-hint">Everyone and everything your journal names, each with every mention in time order. Merge two cards if they're the same individual under different names.</p>
        <div id="ent-status" class="ent-status" hidden></div>
        ${total === 0
          ? `<p class="ent-empty">No entries yet — write or imagine some days first.</p>`
          : entities.length === 0
            ? `<p class="ent-empty">Nothing scanned yet. Tap “Scan entries” to find the people and animals in your journal.</p>`
            : sections + (taggedCount < total ? `<p class="field-hint" style="margin-top:1rem">${total - taggedCount} entr${total - taggedCount === 1 ? "y" : "ies"} not yet scanned — tap “Scan new entries”.</p>` : "")}
      </div>`;

    root.querySelector("#ent-scan")?.addEventListener("click", () => scan(setStatus));
    root.querySelector("#ent-interview")?.addEventListener("click", () => startInterview());
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
        // Two inputs: MY notes about them (my own words) and the journal entries that mention them.
        const sys = `Write a short profile of "${ent.canonical}"${(ent.aliases && ent.aliases.length) ? ` (also known as ${ent.aliases.join(", ")})` : ""}. Draw on BOTH sources below: my own notes about them, and the journal entries that mention them. In 2–4 sentences, first person from my view: who they are, our relationship, and how it changed over time; mention years where useful. My notes are authoritative where they conflict with the entries. Don't invent anything the two sources don't support.`;
        const notesBlock = ent.note ? `MY NOTES ABOUT ${ent.canonical}:\n${ent.note}\n\n` : "";
        const { reply } = await postChat([{ role: "user", content: `${sys}\n\n${notesBlock}Write the profile now.` }], mentionEntries());
        const fresh = (await getEntity(id)) || ent;
        await putEntity({ ...fresh, profile: reply, profileAt: Date.now(), updatedAt: Date.now() });
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
      await putEntity({ ...fresh, note, updatedAt: Date.now() });
      ent.note = note;
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
        const sys = `Answer only about "${ent.canonical}"${(ent.aliases && ent.aliases.length) ? ` (also known as ${ent.aliases.join(", ")})` : ""}${ent.note ? `. Known background: ${ent.note}` : ""}. Use only the entries below, which are the ones mentioning them. Be concise and cite dates.`;
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
      dstatus("Saved.", "ok");
    });
    root.querySelector("#ent-del")?.addEventListener("click", async () => {
      if (!confirm(`Delete “${ent.canonical}”? Its mentions stay in the entries; only the identity is removed.`)) return;
      // Drop this id from every entry's refs, then delete the entity.
      for (const s of mentions) {
        const refs = (s.entityRefs || []).filter((x) => x !== id);
        if (s.date) await putEntry({ ...s, entityRefs: refs }); else await putMemory({ ...s, entityRefs: refs });
      }
      await deleteEntity(id);
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
    openId = intoId;
    render();
  }

  // ---- Hands-free interview: go name after name, the app asks, you answer aloud --------------
  let iv = null; // { active, recog }
  function speak(text) {
    return new Promise((resolve) => {
      try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.rate = 1; u.onend = resolve; u.onerror = resolve; speechSynthesis.speak(u); }
      catch { resolve(); }
    });
  }
  function listenOnce() {
    return new Promise((resolve) => {
      if (!SpeechRec) return resolve("");
      const r = new SpeechRec(); r.lang = "en-US"; r.interimResults = true; r.maxAlternatives = 1;
      let final = "", done = false;
      const finish = () => { if (done) return; done = true; try { r.stop(); } catch { /* */ } resolve(final.trim()); };
      r.onresult = (e) => {
        final = "";
        for (const res of e.results) if (res.isFinal) final += res[0].transcript;
        const interim = [...e.results].map((x) => x[0].transcript).join(" ");
        setInterview({ interim });
        if ([...e.results].some((x) => x.isFinal)) finish();
      };
      r.onerror = finish; r.onend = finish;
      iv.recog = r;
      try { r.start(); } catch { resolve(""); }
    });
  }
  async function getQuestion(ent, mentions, convo) {
    const entries = mentions.map((s) => ({ date: s.date || `${s.startYear || ""}`, brief: s.brief || (s.prose && s.prose.brief) || "", full: s.full || s.raw || s.text || "" }));
    const convoText = convo.map((c) => `Q: ${c.q}\nA: ${c.a}`).join("\n") || "(none yet)";
    const sys = `You are interviewing me, by voice, to build a profile of "${ent.canonical}"${ent.note ? `. What I've said so far: ${ent.note}` : ""}. Below are the journal entries that mention them. Ask ONE short, warm, specific spoken question (one sentence) to learn the single most important thing still missing about who they are and our relationship. Do not repeat what's already known or asked. If the picture is already well-rounded, reply with exactly the word ENOUGH.\n\nConversation so far:\n${convoText}`;
    try { const { reply } = await postChat([{ role: "user", content: `${sys}\n\nYour next question (or ENOUGH):` }], entries); return (reply || "").trim(); }
    catch { return ""; }
  }

  async function startInterview() {
    if (iv && iv.active) return;
    if (!SpeechRec) { alert("Voice interview needs speech recognition (try Chrome on desktop)."); return; }
    const ents = await getAllEntities();
    if (!ents.length) return;
    // Least-explained first: people/animals with no notes, then the rest.
    const rank = (e) => (e.note ? 2 : 0) + (e.entityKind === "person" || e.entityKind === "animal" ? 0 : 1);
    const queue = [...ents].sort((a, b) => rank(a) - rank(b) || a.canonical.localeCompare(b.canonical));
    iv = { active: true, recog: null };
    renderInterview({ status: "Starting…" });
    await speak("Let's talk through the people and animals in your journal. Say skip to move on, or stop to end.");
    const sources = await allSources();
    for (const ent of queue) {
      if (!iv.active) break;
      const mentions = sources.filter((s) => Array.isArray(s.entityRefs) && s.entityRefs.includes(ent.id));
      const convo = [];
      renderInterview({ name: ent.canonical });
      for (let asked = 0; iv.active && asked < 4; asked++) {
        const q = await getQuestion(ent, mentions, convo);
        if (!iv.active) break;
        if (!q || /^enough\b/i.test(q)) break;
        renderInterview({ name: ent.canonical, q });
        await speak(q);
        if (!iv.active) break;
        renderInterview({ name: ent.canonical, q, listening: true });
        const ans = await listenOnce();
        if (!iv.active) break;
        const cmd = ans.toLowerCase();
        if (/\b(stop|end|quit|i'm done|that's all)\b/.test(cmd)) { iv.active = false; break; }
        if (!ans || /\b(skip|next|pass|move on|don't know|no idea)\b/.test(cmd)) { await speak("Okay — next."); break; }
        convo.push({ q, a: ans });
        renderInterview({ name: ent.canonical, q, a: ans });
        const fresh = (await getEntity(ent.id)) || ent;
        await putEntity({ ...fresh, note: (fresh.note ? fresh.note + "\n" : "") + ans, updatedAt: Date.now() });
      }
      if (convo.length) { const box = document.getElementById("iv-saved"); if (box) box.textContent = `Saved ${convo.length} note${convo.length === 1 ? "" : "s"} to ${ent.canonical}.`; }
    }
    if (iv.active) await speak("That's everyone for now. Thanks — I've saved your notes.");
    endInterview();
  }
  function endInterview() {
    if (iv && iv.recog) { try { iv.recog.stop(); } catch { /* */ } }
    try { speechSynthesis.cancel(); } catch { /* */ }
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
        <div class="iv-q" id="iv-q"></div>
        <div class="iv-interim" id="iv-interim"></div>
        <div class="iv-a" id="iv-a"></div>
        <div class="iv-saved" id="iv-saved"></div>
        <div class="iv-actions">
          <button type="button" id="iv-skip">Skip ›</button>
          <button type="button" id="iv-stop">Stop</button>
        </div>
        <p class="iv-hint">Answer out loud. Say “skip” for the next name, “stop” to end.</p>
      </div>`;
      document.body.appendChild(ov);
      ov.querySelector("#iv-stop").addEventListener("click", () => { if (iv) iv.active = false; if (iv && iv.recog) { try { iv.recog.stop(); } catch { /* */ } } endInterview(); });
      ov.querySelector("#iv-skip").addEventListener("click", () => { if (iv && iv.recog) { try { iv.recog.stop(); } catch { /* */ } } });
    }
    if (s.name != null) ov.querySelector("#iv-name").textContent = s.name;
    if (s.q != null) ov.querySelector("#iv-q").textContent = s.q;
    if (s.status != null) ov.querySelector("#iv-q").textContent = s.status;
    if (s.a != null) { ov.querySelector("#iv-a").textContent = s.a ? `“${s.a}”` : ""; ov.querySelector("#iv-interim").textContent = ""; }
    if (s.listening) { ov.querySelector("#iv-interim").textContent = "…listening"; ov.querySelector("#iv-a").textContent = ""; }
  }

  // Delegated once on the stable root (survives re-renders): open an entity card, or jump to a mention.
  root.addEventListener("click", (e) => {
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
