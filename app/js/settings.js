// "Settings" view — device preferences plus data import / export / delete, moved off the
// Today writing screen. (The summary voice still lives on Today, next to where you write.)

import { getEntry, putEntry, getAllEntries, clearAllEntries, getAllMemories, putMemory, clearAllMemories, getAllPeriods, putPeriod, clearAllPeriods, photoToStored, storedToBlob } from "./db.js";
import { withMode } from "./entry.js";
import { isOutlineText } from "./render.js";
import { jkey } from "./journal.js";

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const LANDING_KEY = "journal-landing";

// ---- In-app doc reader (User's Guide, posts, build prompt…) ----------------------------
function esc(s) { return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
// A rough relative price tier from the model name (providers don't expose prices via API).
// Big/flagship → $$$, small/fast → $, else $$.
function priceTier(id) {
  const s = String(id).toLowerCase();
  if (/haiku|mini|nano|flash|lite|small|8b|7b/.test(s)) return "$";
  if (/opus|gpt-4(?!o-?mini)|o1(?!-mini)|o3(?!-mini)|-pro\b|70b|large|ultra/.test(s)) return "$$$";
  return "$$";
}
function inlineMd(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
// A small Markdown → HTML converter (headings, lists, blockquotes, rules, inline formatting).
function mdToHtml(md) {
  let html = "", list = null, para = [];
  const flushPara = () => { if (para.length) { html += `<p>${inlineMd(para.join(" "))}</p>`; para = []; } };
  const flushList = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const raw of md.replace(/\r/g, "").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) { flushPara(); flushList(); continue; }
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)/))) { flushPara(); flushList(); const n = m[1].length; html += `<h${n}>${inlineMd(m[2])}</h${n}>`; continue; }
    if (/^(---|\*\*\*|___)\s*$/.test(line)) { flushPara(); flushList(); html += "<hr>"; continue; }
    if ((m = line.match(/^\s*[-*]\s+(.*)/))) { flushPara(); if (list !== "ul") { flushList(); list = "ul"; html += "<ul>"; } html += `<li>${inlineMd(m[1])}</li>`; continue; }
    if ((m = line.match(/^\s*\d+\.\s+(.*)/))) { flushPara(); if (list !== "ol") { flushList(); list = "ol"; html += "<ol>"; } html += `<li>${inlineMd(m[1])}</li>`; continue; }
    if ((m = line.match(/^>\s?(.*)/))) { flushPara(); flushList(); html += `<blockquote>${inlineMd(m[1])}</blockquote>`; continue; }
    para.push(line.trim());
  }
  flushPara(); flushList();
  return html;
}
function ensureDocReader() {
  let ov = document.getElementById("doc-reader");
  if (ov) return ov;
  ov = document.createElement("div");
  ov.id = "doc-reader";
  ov.className = "doc-reader";
  ov.hidden = true;
  ov.innerHTML = `<div class="doc-panel"><div class="doc-head">`
    + `<span class="doc-title"></span>`
    + `<button type="button" class="doc-copy">Copy</button>`
    + `<button type="button" class="doc-close" aria-label="Close">×</button></div>`
    + `<div class="doc-body"></div></div>`;
  document.body.appendChild(ov);
  const close = () => { ov.hidden = true; };
  ov.querySelector(".doc-close").addEventListener("click", close);
  ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !ov.hidden) close(); });
  return ov;
}
async function openDoc(name, title) {
  const ov = ensureDocReader();
  const body = ov.querySelector(".doc-body");
  ov.querySelector(".doc-title").textContent = title || "";
  body.innerHTML = `<p class="doc-loading">Loading…</p>`;
  ov.hidden = false;
  try {
    const md = await fetch(`docs/${name}.md`).then((r) => { if (!r.ok) throw new Error(r.status); return r.text(); });
    body.innerHTML = mdToHtml(md);
    const copyBtn = ov.querySelector(".doc-copy");
    copyBtn.textContent = "Copy";
    copyBtn.onclick = () => { navigator.clipboard?.writeText(md).then(() => { copyBtn.textContent = "Copied ✓"; setTimeout(() => (copyBtn.textContent = "Copy"), 1500); }); };
  } catch { body.innerHTML = `<p class="doc-loading">Couldn't load this document.</p>`; }
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}
function dataURLtoBlob(dataURL) {
  const [head, b64] = dataURL.split(",");
  const mime = (head.match(/data:(.*?);/) || [])[1] || "image/jpeg";
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

export function initSettings(root, { onImported } = {}) {
  root.innerHTML = `
    <div class="settings">
      <section class="settings-group">
        <h2 class="settings-h">Journal</h2>
        <label class="field">
          <span class="field-label" for="landing-level">Opens on</span>
          <select id="landing-level">
            <option value="week">The most recent week</option>
            <option value="month">The current month</option>
            <option value="year">The current year</option>
            <option value="decade">The current decade</option>
            <option value="life">Your whole life</option>
          </select>
          <span class="field-hint">Where the Journal tab starts. Drill into the cards from there; the breadcrumb walks you back up.</span>
        </label>
        <label class="field">
          <span class="field-label" for="year-grouping">Group years by</span>
          <select id="year-grouping">
            <option value="calendar">Calendar decades (1970s, 1980s…)</option>
            <option value="life">Life decades (childhood, teens, my 20s…)</option>
          </select>
          <span class="field-hint">How the decade level bundles your years. Life decades need your birth year below. Changing this re-summarizes the decade level in the background next time you open the Journal.</span>
        </label>
        <label class="field" id="birth-year-field" hidden>
          <span class="field-label" for="birth-year">Birth year</span>
          <input type="number" id="birth-year" class="settings-input" min="1900" max="2100" inputmode="numeric" placeholder="1958" autocomplete="off">
          <span class="field-hint">Used to name life decades — Childhood (0–12), Teenage years (13–19), then My 20s, My 30s, and so on.</span>
        </label>
      </section>

      <section class="settings-group">
        <h2 class="settings-h">Summaries</h2>
        <label class="field">
          <span class="field-label" for="summary-style-select">Voice</span>
          <select id="summary-style-select">
            <option value="">Clean editorial (default)</option>
            <option value="Cormac McCarthy">Cormac McCarthy</option>
            <option value="Raymond Chandler">Raymond Chandler</option>
            <option value="Ernest Hemingway">Ernest Hemingway</option>
            <option value="Joan Didion">Joan Didion</option>
            <option value="Fran Lebowitz">Fran Lebowitz</option>
            <option value="Hunter S. Thompson">Hunter S. Thompson</option>
            <option value="Jane Austen">Jane Austen</option>
            <option value="Charles Dickens">Charles Dickens</option>
            <option value="Dave Barry">Dave Barry</option>
            <option value="David Sedaris">David Sedaris</option>
            <option value="Gary Shteyngart">Gary Shteyngart</option>
            <option value="__custom__">Custom…</option>
          </select>
          <input type="text" id="summary-style-custom" placeholder="Describe a voice, e.g. hardboiled 1940s detective" hidden>
          <span class="field-hint">The author voice used for all generated prose. Verbatim entries are untouched. Changing it re-summarizes in the background next time you open the Journal.</span>
        </label>
      </section>

      <section class="settings-group">
        <h2 class="settings-h">AI model</h2>
        <label class="field">
          <span class="field-label" for="llm-provider">Provider</span>
          <select id="llm-provider" class="settings-input">
            <option value="">Built-in (DeepSeek)</option>
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai">OpenAI</option>
            <option value="other">Other (OpenAI-compatible)</option>
          </select>
          <span class="field-hint">Bring your own key for a better model. Stored only on this device; sent with each summary request.</span>
        </label>
        <label class="field" id="llm-key-field" hidden>
          <span class="field-label" for="llm-key">API key</span>
          <input type="text" id="llm-key" class="settings-input llm-secret" name="llm-key-${Math.random().toString(36).slice(2)}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="paste your key">
        </label>
        <label class="field" id="llm-base-field" hidden>
          <span class="field-label" for="llm-base">API base URL</span>
          <input type="text" id="llm-base" class="settings-input" autocomplete="off" placeholder="https://…/v1">
        </label>
        <div class="field" id="llm-model-field" hidden>
          <span class="field-label" for="llm-model">Model</span>
          <div class="llm-model-row">
            <select id="llm-model-list" class="settings-input"><option value="">— pick a model —</option></select>
            <button type="button" class="import-link" id="llm-fetch">List models</button>
          </div>
          <input type="text" id="llm-model" class="settings-input" autocomplete="off" placeholder="…or type a model id">
          <span class="field-hint" id="llm-model-hint"></span>
        </div>
        <button type="button" class="import-link" id="regen-all">Regenerate all summaries…</button>
        <p class="field-hint">Rewrites every summary from your original words using the model above (entries and memories are untouched). Runs in the background once you open the Journal.</p>
        <p class="import-status" id="regen-status"></p>
      </section>

      <section class="settings-group">
        <h2 class="settings-h">Your data</h2>
        <div class="import-actions">
          <label class="import-link">
            <input type="file" id="import-file" accept="application/json,.json" hidden>
            <span>Import from a file…</span>
          </label>
          <button type="button" class="import-link" id="export-btn">Export everything…</button>
          <button type="button" class="import-link danger" id="delete-all-btn">Delete everything…</button>
        </div>
        <label class="import-overwrite"><input type="checkbox" id="import-overwrite"> Overwrite items that already exist</label>
        <p class="field-hint">Export, import, and delete cover both journal entries and memories.</p>
        <p class="import-status" id="import-status"></p>
      </section>

      <section class="settings-group">
        <h2 class="settings-h">Guide &amp; about</h2>
        <div class="doc-list">
          <button type="button" class="import-link doc-open" data-doc="users-guide">User's Guide</button>
          <button type="button" class="import-link doc-open" data-doc="demo-a-life">Demo: watching a life take shape</button>
          <button type="button" class="import-link doc-open" data-doc="about-and-privacy">About &amp; privacy</button>
          <button type="button" class="import-link doc-open" data-doc="design-history">A history of the design</button>
          <button type="button" class="import-link doc-open" data-doc="replicate-prompt">Build prompt (replicate this app)</button>
          <button type="button" class="import-link doc-open" data-doc="linkedin-post">LinkedIn post</button>
        </div>
        <p class="field-hint">Reference material — tap to read; use Copy to share the posts and the build prompt.</p>
      </section>

      <section class="settings-group">
        <h2 class="settings-h">Development diary</h2>
        <div class="doc-list">
          <button type="button" class="import-link doc-open" data-doc="diary">What we changed, and when</button>
        </div>
        <p class="field-hint">A running log of the work on this app — the moves forward and the sideways ones.</p>
      </section>
    </div>
  `;

  root.querySelectorAll(".doc-open").forEach((b) => b.addEventListener("click", () => openDoc(b.dataset.doc, b.textContent)));

  // AI model — pick a provider (Anthropic / OpenAI have a model picker), or configure any
  // OpenAI-compatible endpoint manually. Everything is kept on this device.
  const providerEl = root.querySelector("#llm-provider");
  const keyEl = root.querySelector("#llm-key");
  const baseEl = root.querySelector("#llm-base");
  const modelEl = root.querySelector("#llm-model");
  const modelListEl = root.querySelector("#llm-model-list");
  const modelHint = root.querySelector("#llm-model-hint");
  const keyField = root.querySelector("#llm-key-field");
  const baseField = root.querySelector("#llm-base-field");
  const modelField = root.querySelector("#llm-model-field");

  const save = (key, v) => { if (v && v.trim()) localStorage.setItem(key, v.trim()); else localStorage.removeItem(key); };
  const updateProviderUI = () => {
    const p = providerEl.value;
    keyField.hidden = !p;                 // built-in ("") needs no key
    baseField.hidden = p !== "other";     // custom base URL only for "Other"
    modelField.hidden = !p;
    if (p !== "other") { baseEl.value = ""; save("llm-base-url", ""); } // Anthropic/OpenAI use their own endpoint
  };

  providerEl.value = localStorage.getItem("llm-provider") || "";
  keyEl.value = localStorage.getItem("llm-api-key") || "";
  baseEl.value = localStorage.getItem("llm-base-url") || "";
  modelEl.value = localStorage.getItem("llm-model") || "";
  if (modelEl.value) modelListEl.innerHTML = `<option value="">— pick a model —</option><option value="${esc(modelEl.value)}" selected>${esc(modelEl.value)}</option>`;
  updateProviderUI();

  providerEl.addEventListener("change", () => { save("llm-provider", providerEl.value); updateProviderUI(); });
  keyEl.addEventListener("input", () => save("llm-api-key", keyEl.value));
  baseEl.addEventListener("input", () => save("llm-base-url", baseEl.value));
  modelEl.addEventListener("input", () => save("llm-model", modelEl.value));
  modelListEl.addEventListener("change", () => { if (modelListEl.value) { modelEl.value = modelListEl.value; save("llm-model", modelListEl.value); } });

  root.querySelector("#llm-fetch").addEventListener("click", async () => {
    const apiKey = keyEl.value.trim();
    if (!apiKey) { modelHint.textContent = "Enter your API key first."; return; }
    modelHint.textContent = "Fetching models…";
    try {
      const r = await fetch("/api/summarize", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "models", provider: providerEl.value, apiKey, baseUrl: baseEl.value.trim() }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `Server ${r.status}`);
      // Newest first; label each with its release date and a rough price tier ($ … $$$).
      const models = (data.models || []).filter((m) => m && m.id)
        .sort((a, b) => String(b.created || "").localeCompare(String(a.created || "")));
      modelListEl.innerHTML = `<option value="">— pick a model —</option>` + models.map((m) => {
        const parts = [m.id];
        if (m.created) parts.push(m.created.slice(0, 10));
        parts.push(priceTier(m.id));
        return `<option value="${esc(m.id)}"${m.id === modelEl.value ? " selected" : ""}>${esc(parts.join("  ·  "))}</option>`;
      }).join("");
      modelHint.textContent = models.length
        ? `${models.length} models, newest first. The $ tier is a rough guide ($ cheapest → $$$ priciest) — providers don't publish prices via the API, so check theirs for exact rates.`
        : "No models returned.";
    } catch (err) { modelHint.textContent = `Couldn't list models: ${err.message}`; }
  });

  const regenBtn = root.querySelector("#regen-all");
  const regenStatus = root.querySelector("#regen-status");
  regenBtn.addEventListener("click", async () => {
    if (!confirm("Regenerate ALL summaries from scratch, using the current model? Your entries and memories are untouched. This runs in the background and can take a while.")) return;
    regenBtn.disabled = true;
    regenStatus.textContent = "Marking everything for re-summarization…";
    regenStatus.className = "import-status";
    try {
      let leaves = 0;
      for (const e of await getAllEntries()) {
        if (!e.raw) continue; // no source text left to regenerate from — keep its summary
        delete e.levels; e.needsSummary = true;
        await putEntry(e); leaves++;
      }
      for (const m of await getAllMemories()) {
        const mm = { ...m, needsSummary: true }; delete mm.levels;
        await putMemory(mm); leaves++;
      }
      await clearAllPeriods(); // rolled-up summaries rebuild from the fresh leaves
      regenStatus.textContent = `Queued ${leaves} to re-summarize. Open the Journal (or Graph) to watch it rebuild.`;
      regenStatus.className = "import-status ok";
      onImported?.(); // jump to the Journal so the background pass starts
    } catch (err) {
      regenStatus.textContent = `Couldn't start: ${err.message}`;
      regenStatus.className = "import-status error";
    } finally {
      regenBtn.disabled = false;
    }
  });

  const landingEl = root.querySelector("#landing-level");
  landingEl.value = localStorage.getItem(LANDING_KEY) || "week";
  landingEl.addEventListener("change", () => localStorage.setItem(LANDING_KEY, landingEl.value));

  // Year grouping — calendar decades vs life decades (relative to a birth year). Read by the
  // calendar's bucket* helpers; takes effect (and re-summarizes the decade level) next Journal open.
  const groupingEl = root.querySelector("#year-grouping");
  const birthField = root.querySelector("#birth-year-field");
  const birthEl = root.querySelector("#birth-year");
  const syncGrouping = () => { birthField.hidden = groupingEl.value !== "life"; };
  groupingEl.value = localStorage.getItem(jkey("year-grouping")) === "life" ? "life" : "calendar";
  birthEl.value = localStorage.getItem(jkey("birth-year")) || "";
  syncGrouping();
  groupingEl.addEventListener("change", () => { localStorage.setItem(jkey("year-grouping"), groupingEl.value); syncGrouping(); });
  birthEl.addEventListener("input", () => save(jkey("birth-year"), birthEl.value));

  // Summary voice — an author style applied to all generated prose (stored in localStorage).
  const styleSelect = root.querySelector("#summary-style-select");
  const styleCustom = root.querySelector("#summary-style-custom");
  const currentStyle = () => (styleSelect.value === "__custom__" ? styleCustom.value.trim() : styleSelect.value);
  (function restoreStyle() {
    const saved = localStorage.getItem("summary-style") || "";
    const isPreset = [...styleSelect.options].some((o) => o.value === saved && o.value !== "__custom__");
    if (saved && !isPreset) { styleSelect.value = "__custom__"; styleCustom.hidden = false; styleCustom.value = saved; }
    else { styleSelect.value = saved; styleCustom.hidden = true; }
  })();
  styleSelect.addEventListener("change", () => {
    const custom = styleSelect.value === "__custom__";
    styleCustom.hidden = !custom;
    if (custom) styleCustom.focus();
    localStorage.setItem("summary-style", currentStyle());
  });
  styleCustom.addEventListener("input", () => localStorage.setItem("summary-style", currentStyle()));

  const importInput = root.querySelector("#import-file");
  const importStatus = root.querySelector("#import-status");
  const exportBtn = root.querySelector("#export-btn");
  const deleteAllBtn = root.querySelector("#delete-all-btn");

  deleteAllBtn.addEventListener("click", async () => {
    const [entries, mems] = await Promise.all([getAllEntries(), getAllMemories()]);
    if (!entries.length && !mems.length) { importStatus.textContent = "Nothing to delete."; importStatus.className = "import-status"; return; }
    const parts = [];
    if (entries.length) parts.push(`${entries.length} ${entries.length === 1 ? "entry" : "entries"}`);
    if (mems.length) parts.push(`${mems.length} ${mems.length === 1 ? "memory" : "memories"}`);
    if (!confirm(`Delete ALL ${parts.join(" and ")} permanently? This cannot be undone.`)) return;
    await Promise.all([clearAllEntries(), clearAllMemories()]);
    location.reload();
  });

  exportBtn.addEventListener("click", async () => {
    importStatus.textContent = "Preparing export…";
    importStatus.className = "import-status";
    try {
      const [entries, memories, periods] = await Promise.all([getAllEntries(), getAllMemories(), getAllPeriods()]);
      if (!entries.length && !memories.length) { importStatus.textContent = "Nothing to export yet."; return; }
      // Export the whole entry (raw, prose, outline, levels, reps, mode…) so a round-trip
      // preserves every level of summarization. Only the binary photos need converting.
      const out = [];
      for (const e of entries) {
        const { photos, ...rest } = e;
        out.push({
          ...rest,
          summarized: e.summarized !== false,
          photos: await Promise.all((photos ?? []).map((ph) => blobToDataURL(storedToBlob(ph)))),
        });
      }
      // Include the rolled-up summaries (week/month/year/decade/life + category/subject) so a
      // restore doesn't have to re-summarize everything from scratch.
      const bundle = { version: 1, exportedAt: new Date().toISOString(), entries: out, memories, periods };
      const blob = new Blob([JSON.stringify(bundle)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `journal-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      const parts = [];
      if (entries.length) parts.push(`${entries.length} ${entries.length === 1 ? "day" : "days"}`);
      if (memories.length) parts.push(`${memories.length} ${memories.length === 1 ? "memory" : "memories"}`);
      importStatus.textContent = `Exported ${parts.join(" and ")}.`;
      importStatus.className = "import-status ok";
    } catch (err) {
      importStatus.textContent = `Export failed: ${err.message}`;
      importStatus.className = "import-status error";
    }
  });

  importInput.addEventListener("change", async () => {
    const file = importInput.files[0];
    importInput.value = "";
    if (!file) return;
    importStatus.textContent = "Importing…";
    importStatus.className = "import-status";
    try {
      const bundle = JSON.parse(await file.text());
      const entries = Array.isArray(bundle) ? bundle : (Array.isArray(bundle.entries) ? bundle.entries : []);
      const memories = (!Array.isArray(bundle) && Array.isArray(bundle.memories)) ? bundle.memories : [];
      const periods = (!Array.isArray(bundle) && Array.isArray(bundle.periods)) ? bundle.periods : [];
      if (!entries.length && !memories.length) throw new Error("Not a valid export file");

      const overwrite = root.querySelector("#import-overwrite")?.checked;
      let added = 0, updated = 0, skipped = 0;
      for (const item of entries) {
        if (!item.date) continue;
        const exists = await getEntry(item.date);
        if (exists && !overwrite) { skipped++; continue; } // default: never clobber existing
        const { photos: photoData, createdAt, updatedAt, ...rest } = item;
        const entry = {
          ...rest, // carry raw, prose, outline, levels, reps, mode… straight through
          dayOfWeek: item.dayOfWeek || DOW[new Date(item.date + "T12:00:00").getDay()],
          photos: await Promise.all((photoData || []).map((d) => photoToStored(dataURLtoBlob(d)))),
          createdAt: createdAt || Date.now(),
          updatedAt: Date.now(),
        };
        // Old-format file (only brief/full, no raw/reps/levels): seed a representation so it still shows.
        if (!entry.raw && !entry.prose && !entry.outline && !entry.levels && item.full != null) {
          const seedMode = item.mode || (item.summarized === false ? "verbatim" : (isOutlineText(item.full) ? "outline" : "prose"));
          if (seedMode === "verbatim") entry.raw = item.full;
          else if (seedMode === "outline") entry.outline = { brief: item.brief || "", full: item.full };
          else entry.prose = { brief: item.brief || "", full: item.full };
        }
        // No blocking summarize: any entry with raw but no levels is filled in by the
        // Journal's background pass. Import stays instant.
        await putEntry(withMode(entry, entry.mode));
        if (exists) updated++; else added++;
      }

      // Restore memories (matched by id; the same overwrite rule applies).
      let memAdded = 0, memSkipped = 0;
      if (memories.length) {
        const existingIds = new Set((await getAllMemories()).map((m) => m.id));
        for (const m of memories) {
          if (!m || !m.id) continue;
          if (existingIds.has(m.id) && !overwrite) { memSkipped++; continue; }
          await putMemory(m);
          if (!existingIds.has(m.id)) memAdded++;
        }
      }

      // Restore the rolled-up summaries (the derived cache) so a fresh restore is fully
      // summarized without re-running the model. Anything stale is recomputed on the next pass.
      for (const p of periods) { if (p && p.key) await putPeriod(p); }

      const nothingNew = !added && !updated && !memAdded;
      importStatus.textContent = nothingNew
        ? `Everything in this file is already here (${skipped} ${skipped === 1 ? "day" : "days"}${memSkipped ? `, ${memSkipped} ${memSkipped === 1 ? "memory" : "memories"}` : ""}). Turn on “Overwrite” to replace them.`
        : `Imported ${added} new` +
          (updated ? `, overwrote ${updated}` : "") +
          (skipped ? `, skipped ${skipped} already here` : "") +
          (memAdded || memSkipped ? ` · ${memAdded} ${memAdded === 1 ? "memory" : "memories"}${memSkipped ? `, skipped ${memSkipped}` : ""}` : "") +
          ". Summaries fill in as the Journal loads.";
      importStatus.className = "import-status ok";
      // Always show the imported data — even a pure re-import lands you on the Journal so
      // it's clear something happened.
      onImported?.(entries.length ? entries[entries.length - 1].date : undefined);
    } catch (err) {
      importStatus.textContent = `Import failed: ${err.message}`;
      importStatus.className = "import-status error";
    }
  });

  return { refresh: () => { landingEl.value = localStorage.getItem(LANDING_KEY) || "week"; } };
}
