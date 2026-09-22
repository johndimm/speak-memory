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

const KIND_LABEL = { person: "Person", animal: "Animal", place: "Place", org: "Organization", thing: "Thing" };
const KIND_ORDER = ["person", "animal", "place", "org", "thing"];
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "e" + Date.now() + Math.random().toString(36).slice(2));

function llmOverrides() {
  const provider = localStorage.getItem("llm-provider") || "";
  if (!provider) return {};
  return { provider, apiKey: localStorage.getItem("llm-api-key") || "", model: localStorage.getItem("llm-model") || "", baseUrl: localStorage.getItem("llm-base-url") || "" };
}
async function postEntities(text, known) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  try {
    const r = await fetch("/api/summarize", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...llmOverrides(), mode: "entities", text, known }), signal: ctrl.signal,
    });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || `Server ${r.status}`); }
    return await r.json();
  } finally { clearTimeout(timer); }
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
      const untagged = sources.filter((s) => (s.raw || s.text) && !Array.isArray(s.entityRefs));
      if (!untagged.length) { setStatus("Everything's already scanned. Re-scan anyway from an entry's page if a name looks off.", ""); return; }

      // Load the current roster; grow it as new names appear (so later entries resolve to earlier ones).
      let roster = await getAllEntities();
      const byId = new Map(roster.map((e) => [e.id, e]));
      let done = 0, found = 0;
      for (const src of untagged) {
        const text = src.raw || src.text || "";
        const label = src.date ? src.date : (src.subject || src.label || "memory");
        const jid = logAdd(label, "scan");
        logSet(jid, "running");
        try {
          const known = roster.map((e) => ({ id: e.id, canonical: e.canonical, aliases: e.aliases || [], kind: e.entityKind }));
          const { mentions } = await postEntities(text, known);
          const refs = [];
          for (const m of mentions) {
            // The LLM is the resolver: it returns a known id when this mention matches an existing
            // entity (spelling variants and all), else marks it new. We only create when it says new.
            let ent = m.id && byId.get(m.id);
            if (!ent) {
              ent = { id: uid(), entityKind: m.kind || "person", canonical: m.name.trim(), aliases: [], note: "", createdAt: Date.now(), updatedAt: Date.now() };
              await putEntity(ent);
              roster.push(ent); byId.set(ent.id, ent);
              found++;
            }
            if (!refs.includes(ent.id)) refs.push(ent.id);
          }
          // Persist the refs on the source item.
          const next = { ...src, entityRefs: refs };
          if (src.date) await putEntry(next); else await putMemory(next);
          logSet(jid, "done");
        } catch (err) { logSet(jid, "error", { error: (err && err.message) || "failed" }); }
        done++;
        setStatus(`Scanning… ${done} of ${untagged.length}${found ? ` · ${found} new` : ""}`, "working");
      }
      setStatus(`Done — scanned ${done} entr${done === 1 ? "y" : "ies"}, ${found} new individual${found === 1 ? "" : "s"}.`, "ok");
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
          <button type="button" class="ent-scan" id="ent-scan">${entities.length ? "Scan new entries" : "Scan entries"}</button>
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
        <button type="button" class="ent-back" id="ent-back">← All people &amp; animals</button>
        <div class="ent-profile">
          <input type="text" class="ent-canon" id="ent-canon" value="${escapeHtml(ent.canonical)}" aria-label="Name">
          <select id="ent-kind" class="ent-kindsel" aria-label="Kind">
            ${KIND_ORDER.map((k) => `<option value="${k}"${(ent.entityKind || "person") === k ? " selected" : ""}>${KIND_LABEL[k]}</option>`).join("")}
          </select>
          <label class="ent-field"><span>Also known as (comma-separated)</span>
            <input type="text" id="ent-aliases" value="${escapeHtml((ent.aliases || []).join(", "))}" placeholder="Baby Kitty, Zay…"></label>
          <label class="ent-field"><span>Note</span>
            <input type="text" id="ent-note" value="${escapeHtml(ent.note || "")}" placeholder="who they are…"></label>
          <div class="ent-profile-actions">
            <button type="button" class="ent-save" id="ent-save">Save</button>
            ${others.length ? `<span class="ent-merge"><span>Merge into</span><select id="ent-merge-sel"><option value="">choose…</option>${mergeOpts}</select><button type="button" id="ent-merge-btn">Merge</button></span>` : ""}
            <button type="button" class="ent-del" id="ent-del">Delete</button>
          </div>
          <div id="ent-pstatus" class="ent-status" hidden></div>
        </div>
        <h3 class="ent-kind">${mentions.length} mention${mentions.length === 1 ? "" : "s"}, in time order</h3>
        <div class="ent-mentions">${rows || '<p class="ent-empty">No mentions tagged yet.</p>'}</div>
      </div>`;

    const pstatus = (msg, cls) => { const el = root.querySelector("#ent-pstatus"); if (!el) return; el.hidden = !msg; el.className = "ent-status" + (cls ? " " + cls : ""); el.textContent = msg; };
    root.querySelector("#ent-back").addEventListener("click", () => { openId = null; render(); });
    root.querySelector("#ent-save").addEventListener("click", async () => {
      const next = {
        ...ent,
        canonical: root.querySelector("#ent-canon").value.trim() || ent.canonical,
        entityKind: root.querySelector("#ent-kind").value,
        aliases: root.querySelector("#ent-aliases").value.split(",").map((s) => s.trim()).filter(Boolean),
        note: root.querySelector("#ent-note").value.trim(),
        updatedAt: Date.now(),
      };
      await putEntity(next);
      pstatus("Saved.", "ok");
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
      await mergeInto(id, targetId, pstatus);
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
    close() { /* nothing to tear down */ },
  };
}
