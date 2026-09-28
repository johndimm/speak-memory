// "Write" view — a plain text box (dictate with the keyboard mic, or the in-app 🎤
// Dictate button on desktop via the Web Speech API) plus photos.
// On save we summarize via /api/summarize, store the result + photos in IndexedDB,
// and throw the raw text away.

import { getEntry, putEntry, getAllEntries, clearAllEntries, putMemory, getAllMemories, deleteEntry, deleteMemory, photoToStored, storedToBlob, getAllPeriods, deletePeriod } from "./db.js";
import { renderReps, renderRep, wireReps, isOutlineText, escapeHtml, resolveEntityTokens } from "./render.js";
import { deriveBrief, withMode, repsOf } from "./entry.js";
import { setupDictation, IS_MOBILE } from "./dictation.js";
import { primeAudio } from "./voicetts.js";
import { DEFAULT_CATEGORIES } from "./memoryvoice.js";
import { attachLiveCapture } from "./capture.js";
import { resolveEntityNames } from "./entityresolve.js";
import { jkey } from "./journal.js";
import { ensureSelf } from "./self.js";

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

// Reject if a promise (a local DB write) hasn't settled in `ms` — so a wedged IndexedDB shows a
// clear message instead of an eternal "Saving…". The write may still land; we just stop waiting.
function withTimeout(promise, ms, what) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`storage isn't responding (${what}). Close any other tabs of this app and reload, then try again — your text is still here.`)),
      ms,
    );
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

// The reader's own model/key/endpoint (from Settings), sent with each summary request.
function llmOverrides() {
  // Built-in provider (value "") uses the server's own key/model — never send a saved key then,
  // or a stale one would override the good server key and 401 every call.
  const provider = localStorage.getItem("llm-provider") || "";
  if (!provider) return {};
  return {
    provider,
    apiKey: localStorage.getItem("llm-api-key") || "",
    model: localStorage.getItem("llm-model") || "",
    baseUrl: localStorage.getItem("llm-base-url") || "",
  };
}

// Raw text is retained (up to a count limit) so summaries can be regenerated from the source.
function rawFresh(entry) { return !!(entry && entry.raw); }

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dayOfWeek(iso) {
  return DOW[new Date(iso + "T12:00:00").getDay()];
}

// Normalize any picked/captured image (incl. iPhone HEIC) to a downscaled JPEG so it
// reliably displays, stays small, and works when exported to other devices.
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode failed")); };
    img.src = url;
  });
}

async function processImage(file, max = 1600, quality = 0.85) {
  try {
    const { img, url } = await loadImage(file);
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    const scale = Math.min(1, max / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
    const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", quality));
    return blob || file;
  } catch {
    return file; // fall back to the original if decoding fails
  }
}

// The local time an entry is written tells the model whether it's a morning plan
// (events haven't happened yet) or an evening recap.
function nowContext() {
  const d = new Date();
  return {
    localTime: d.toLocaleString(undefined, {
      weekday: "long", month: "long", day: "numeric", year: "numeric",
      hour: "numeric", minute: "2-digit",
    }),
  };
}

// The Stories ladder: your life NOW (from Me) in the four big threads, each a place to start going
// back in time. `k` is the Me fact that holds the current one (+ `${k}Since`).
// `alias`: other category names that mean the same thread (your own "Places" is the Homes thread).
const LADDER = [
  { cat: "Homes", alias: ["home", "homes", "places", "place", "cities", "city", "houses", "where i lived"], k: "location", missing: "Tell Me where you live",
    ask: (cur) => cur ? `Where did you live before ${cur}? When did you move there?` : "Where did you live? When?" },
  { cat: "Relationships", alias: ["relationship", "relationships", "girl friends", "girlfriends", "boyfriends", "partners", "marriage", "love"], k: "livesWith", missing: "Tell Me who you live with",
    ask: (cur) => cur ? `Before ${cur} — who were you with? When?` : "Who were you with? When?" },
  { cat: "Jobs", alias: ["job", "jobs", "work", "career", "careers"], k: "job", missing: "Tell Me what you do for work",
    ask: (cur) => cur ? `What did you do before ${cur}? When did you start?` : "What work did you do? When?" },
  { cat: "Hobbies", alias: ["hobby", "hobbies", "pastimes", "fun"], k: "hobbies", missing: "Tell Me what you do for fun",
    ask: (cur) => cur ? `What did you do for fun before ${cur}? When?` : "What did you do for fun? When?" },
];

export function initRecord(root, { onSaved, onSavedMemory, onDeleted, onDeletedMemory, onNavigate, onBrowse, onOpenName, onOpenMe, onOpenGuide } = {}) {
  root.innerHTML = `
    <!-- Same layout as every input page (docs/input-method-design.md):
         breadcrumb → text box (EDIT) or ✎ Edit (READ) → title → content → Save/Cancel → Delete. -->
    <form class="write-form" id="write-form">
      <nav class="write-breadcrumb" id="write-breadcrumb" aria-label="Location"></nav>

      <!-- Stories (a new story): your life now, from Me — pick a thread and go back in time. -->
      <div class="life-ladder edit-only" id="life-ladder" hidden></div>

      <button type="button" class="edit-text-btn read-only" id="edit-text-toggle">✎ Edit</button>
      <div class="edit-only">
        <label class="field write-main">
          <span class="field-label write-prompt" id="entry-label">What happened today?</span>
          <textarea id="entry-text" rows="3"
            placeholder="Just talk — tap 🎤 Dictate — or type…"></textarea>
        </label>
        <div class="write-tools"><button type="button" class="mic-btn" id="mic-btn" hidden><span>🎤 Dictate</span></button></div>
        <div class="cap-found" id="entry-found" hidden></div>
        <p class="first-help" id="first-help" hidden>New here? <button type="button" id="first-help-btn">Read the guide ›</button></p>
      </div>

      <h2 class="write-title" id="write-title"></h2>

      <div class="read-only">
        <div class="entry-view" id="entry-view"></div>
        <p class="entry-details" id="entry-details" hidden></p>
      </div>

      <!-- Journal only: the date. -->
      <label class="field edit-only" id="write-more">
        <span class="field-label">Date</span>
        <input type="date" id="entry-date" value="${todayISO()}" max="${todayISO()}">
      </label>

      <!-- Stories only: category / subject / place / years. -->
      <div id="memory-fields" class="edit-only" hidden>
        <div class="mem-row">
          <div class="field">
            <span class="field-label">Category</span>
            <input type="text" id="entry-category" autocomplete="off" placeholder="places, friends, jobs…">
            <div class="chip-row" id="entry-category-chips"></div>
          </div>
          <div class="field">
            <span class="field-label">Subject <em>(optional)</em></span>
            <input type="text" id="entry-subject" autocomplete="off" placeholder="Deena, the Elm St. house">
            <div class="chip-row" id="entry-subject-chips"></div>
          </div>
        </div>
        <div class="field loc-field">
          <span class="field-label">Location <em>(optional)</em></span>
          <input type="text" id="entry-location" autocomplete="off" placeholder="a city or address">
          <div class="loc-suggest" id="entry-location-suggest" hidden></div>
          <span class="field-hint" id="entry-location-hint"></span>
        </div>
        <fieldset class="mem-years">
          <label class="field mem-year-field">
            <span class="field-label">Year</span>
            <input type="number" id="entry-start-year" min="1900" max="2100" inputmode="numeric" placeholder="1971">
          </label>
          <span class="mem-year-dash">–</span>
          <label class="field mem-year-field">
            <span class="field-label">End</span>
            <input type="number" id="entry-end-year" min="1900" max="2100" inputmode="numeric" placeholder="1974">
          </label>
          <label class="mem-ongoing"><input type="checkbox" id="entry-ongoing"> now</label>
        </fieldset>
      </div>

      <div class="photo-row">
        <button type="button" class="photo-add edit-only" id="entry-camera-btn"><span>📷 Camera</span></button>
        <label class="photo-add edit-only">
          <input type="file" id="entry-photo" accept="image/*,video/*" multiple hidden>
          <span>🖼 Photo / video</span>
        </label>
        <div class="photo-thumbs" id="photo-thumbs"></div>
      </div>

      <div class="write-actions edit-only">
        <button type="submit" class="save-btn" id="save-btn" disabled>Save</button>
        <button type="button" class="cancel-btn" id="cancel-btn" hidden>Cancel</button>
      </div>

      <!-- Stories voice tools. -->
      <div class="memoir-handsfree-row edit-only" id="memoir-actions" hidden>
        <button type="button" class="fut-interview" id="memoir-series">🎙 Add a series by voice</button>
        <button type="button" class="fut-interview" id="memoir-handsfree">💬 Talk it through</button>
      </div>

      <button type="button" class="delete-entry-btn edit-only" id="delete-entry-btn" hidden>Delete</button>
      <p class="write-status" id="write-status"></p>
    </form>

    <div class="camera-overlay" id="camera-overlay" hidden>
      <video id="camera-video" playsinline autoplay muted></video>
      <div class="camera-controls">
        <button type="button" class="camera-ghost" id="camera-cancel">Cancel</button>
        <button type="button" class="camera-shutter" id="camera-shutter" aria-label="Take photo"></button>
        <button type="button" class="camera-ghost" id="camera-flip">Flip</button>
      </div>
    </div>
  `;


  const dateEl = root.querySelector("#entry-date");
  const textEl = root.querySelector("#entry-text");
  const micBtn = root.querySelector("#mic-btn");
  const photoInput = root.querySelector("#entry-photo");
  const cameraBtn = root.querySelector("#entry-camera-btn");
  const thumbsEl = root.querySelector("#photo-thumbs");
  const saveBtn = root.querySelector("#save-btn");
  const deleteBtn = root.querySelector("#delete-entry-btn");
  const statusEl = root.querySelector("#write-status");
  const entryLabel = root.querySelector("#entry-label");
  const entryView = root.querySelector("#entry-view");
  const writeBreadcrumb = root.querySelector("#write-breadcrumb");
  const writeTitle = root.querySelector("#write-title");

  // A date-based breadcrumb (Life › decade › year › month › the day). Each crumb browses the time tree
  // at that level; the current day is the last, non-clickable crumb.
  const escCrumb = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function renderWriteBreadcrumb(dateStr) {
    if (!writeBreadcrumb) return;
    const isStory = !root.querySelector("#memory-fields")?.hidden; // Stories mode = the memory form is showing
    if (isStory) {
      // Stories breadcrumb: Life (all categories) › category › subject. Jump anywhere to browse.
      const catV = (root.querySelector("#entry-category")?.value || "").trim();
      const subV = (root.querySelector("#entry-subject")?.value || "").trim();
      const parts = [`<button type="button" class="crumb" data-cat="" data-sub="">⌂ Life</button>`];
      if (catV) parts.push(`<span class="crumb-sep">›</span><button type="button" class="crumb" data-cat="${escCrumb(catV)}" data-sub="">${escCrumb(catV)}</button>`);
      if (subV) parts.push(`<span class="crumb-sep">›</span><span class="crumb crumb-current">${escCrumb(subV)}</span>`);
      else if (catV) parts[parts.length - 1] = parts[parts.length - 1].replace('class="crumb"', 'class="crumb crumb-current"'); // category is the last, current
      writeBreadcrumb.innerHTML = parts.join("");
      return;
    }
    const iso = dateStr || todayISO();
    const y = iso.slice(0, 4);
    const d = new Date(iso + "T12:00:00");
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const crumbs = [
      { z: "life", f: "", label: "⌂ Life" },
      { z: "decade", f: iso, label: `${Math.floor(+y / 10) * 10}s` },
      { z: "year", f: iso, label: y },
      { z: "month", f: iso, label: d.toLocaleDateString("en-US", { month: "long" }) },
    ];
    const current = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    writeBreadcrumb.innerHTML = crumbs.map((c) =>
      `<button type="button" class="crumb" data-zoom="${c.z}" data-focus="${esc(c.f)}">${esc(c.label)}</button>`).join('<span class="crumb-sep">›</span>')
      + `<span class="crumb-sep">›</span><span class="crumb crumb-current">${esc(current)}</span>`;
  }
  writeBreadcrumb?.addEventListener("click", (e) => {
    const b = e.target.closest(".crumb");
    if (!b || b.classList.contains("crumb-current") || !onBrowse) return;
    if (b.dataset.zoom) { onBrowse(b.dataset.focus || undefined, b.dataset.zoom); return; } // Journal (date tree)
    if (b.hasAttribute("data-cat")) { onBrowse(b.dataset.cat || "", b.dataset.cat ? "category" : "memoir"); } // Stories (category tree)
  });
  const editTextToggle = root.querySelector("#edit-text-toggle");
  wireReps(entryView);

  // Live capture: colour names as you type/dictate and collect them below the box. Diary surfaces
  // names; memoir also lights up dates/places/categories (its structured fields cover the rest).
  const foundEl = root.querySelector("#entry-found");
  // Clicking a Found name opens that person's page. Save the current entry first so nothing's lost.
  const capture = attachLiveCapture(textEl, { mount: foundEl, buckets: ["names"], onPick: async (name) => {
    await persistDraft();
    try {
      const ids = await resolveEntityNames([{ name, kind: "person" }]);
      const rid = (ids || [])[0];
      if (rid && onOpenName) onOpenName(rid);
    } catch { /* */ }
  } });

  let currentSummarized = true; // mode of the loaded entry (edit mode)
  let inEditMode = false;
  let editingText = false; // in edit mode: showing the raw text box vs the formatted view

  // ONE layout for every input page (docs/input-method-design.md). `inEditMode` = there's a saved
  // version (an existing day or story); `editingText` = the user tapped ✎ Edit. READ shows the summary;
  // EDIT shows the transcript box + editable details + Save/Cancel. CSS keys off .reading.
  const entryDetails = root.querySelector("#entry-details");
  const cancelBtn = root.querySelector("#cancel-btn");
  const isStory = () => formMode === "memory";
  const currentItem = () => (isStory() ? editingMemOrig : loadedEntry); // what the READ view shows
  function titleText() {
    if (isStory()) {
      const s = (root.querySelector("#entry-subject")?.value || "").trim();
      const c = (root.querySelector("#entry-category")?.value || "").trim();
      return s || c || "New story";
    }
    const d = new Date((dateEl.value || todayISO()) + "T12:00:00");
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
  }
  function detailsText() { // the story's facts, read-only: category · years · place
    if (!isStory()) return "";
    const m = editingMemOrig || {};
    return [m.category !== titleText() ? m.category : null, m.label && m.label !== "sometime" ? m.label : null, m.place].filter(Boolean).join(" · ");
  }
  // ---- The Stories ladder -------------------------------------------------------------------
  const ladderEl = root.querySelector("#life-ladder");
  let ladderPick = null; // the thread you tapped "Before that" on
  async function renderLadder() {
    if (!ladderEl) return;
    const show = isStory() && !editingMemId; // only when starting a new story
    ladderEl.hidden = !show;
    if (!show) return;
    let facts = {};
    try { facts = ((await ensureSelf()) || {}).facts || {}; } catch { /* */ }
    // Each thread is a little timeline, left → right: an empty block to add the one BEFORE, your
    // stories in that thread in date order (tap to open), and NOW from Me on the right.
    const yrs = (m) => (m.startYear ? `${m.startYear}${m.endYear && m.endYear !== m.startYear ? `–${m.endYear}` : ""}` : (m.label || ""));
    // The threads: the four big ones (under YOUR category name when you use another, e.g. "Places"),
    // then every other category you have stories in.
    const byCat = new Map();
    for (const m of allMems) { const c = (m.category || "").trim(); if (c) { if (!byCat.has(c)) byCat.set(c, []); byCat.get(c).push(m); } }
    // The four big threads always go by their plain names; each gathers the stories from every category
    // that means the same thing (your "Girl Friends" are Relationships), and offers to refile them.
    const used = new Set();
    const threads = LADDER.map((L) => {
      const cats = [...byCat.keys()].filter((c) => c === L.cat || (L.alias || []).includes(c.toLowerCase()));
      cats.forEach((c) => used.add(c));
      used.add(L.cat);
      return { ...L, stories: cats.flatMap((c) => byCat.get(c)), others: cats.filter((c) => c !== L.cat) };
    });
    for (const [c, list] of [...byCat.entries()].sort((a, b) => b[1].length - a[1].length)) {
      if (!used.has(c)) threads.push({ cat: c, stories: list, ask: (cur) => cur ? `${c}: what came before ${cur}? When?` : `${c}: tell one. When was it?` });
    }
    const rows = threads.map((L) => {
      const cur = L.k && facts[L.k] ? String(facts[L.k]) : "";
      const since = L.k ? facts[L.k + "Since"] : null;
      const stories = L.stories.slice()
        .sort((a, b) => (a.startYear || 0) - (b.startYear || 0) || (a.createdAt || 0) - (b.createdAt || 0));
      // "Before that" asks about the time before the EARLIEST one known (a story, else your current one).
      const oldest = stories.find((m) => m.startYear) || stories[0];
      const anchor = oldest ? (oldest.subject || oldest.label || "") : cur;
      const addBlock = `<button type="button" class="lt-block lt-add" data-cat="${escapeHtml(L.cat)}" data-ask="${escapeHtml(L.ask(anchor))}" title="Add the one before">＋</button>`;
      const storyBlocks = stories.map((m) => `<button type="button" class="lt-block lt-story" data-mem="${escapeHtml(m.id)}">
          <span class="lt-name">${escapeHtml(m.subject || m.label || m.category || "Story")}</span>
          <span class="lt-yrs">${escapeHtml(yrs(m))}</span></button>`).join("");
      // NOW comes from Me — only the four big threads have one.
      const nowBlock = !L.k ? ""
        : cur ? `<div class="lt-block lt-now"><span class="lt-tag">Now</span><span class="lt-name">${escapeHtml(cur)}</span>${since ? `<span class="lt-yrs">since ${since}</span>` : ""}</div>`
        : `<button type="button" class="lt-block lt-now lt-missing ladder-me"><span class="lt-tag">Now</span><span class="lt-name">${escapeHtml(L.missing)} ›</span></button>`;
      const refile = (L.others || []).map((c) => `<button type="button" class="lt-refile" data-from="${escapeHtml(c)}" data-to="${escapeHtml(L.cat)}">Rename “${escapeHtml(c)}” → ${escapeHtml(L.cat)}</button>`).join("");
      return `<div class="ladder-row${ladderPick === L.cat ? " picked" : ""}">
          <span class="ladder-cat">${escapeHtml(L.cat)}${refile}</span>
          <div class="lt-track">${addBlock}${storyBlocks}${nowBlock}</div>
        </div>`;
    }).join("");
    ladderEl.innerHTML = `<p class="ladder-head">Your life, thread by thread — tap ＋ to add the one before</p>${rows}`;
    // Start each track scrolled to NOW (the right end).
    ladderEl.querySelectorAll(".lt-track").forEach((t) => { t.scrollLeft = t.scrollWidth; });
  }
  ladderEl?.addEventListener("click", (e) => {
    if (e.target.closest(".ladder-me")) { onOpenMe?.(); return; }
    // Refile a category's stories under the thread's name (their summaries stay; the category/subject
    // roll-ups are rebuilt under the new name, and the old ones are removed).
    const rf = e.target.closest(".lt-refile");
    if (rf) {
      const from = rf.dataset.from, to = rf.dataset.to;
      const list = allMems.filter((m) => (m.category || "").trim() === from);
      if (!list.length || !confirm(`File your ${list.length} “${from}” stor${list.length === 1 ? "y" : "ies"} under “${to}”?`)) return;
      rf.disabled = true; rf.textContent = "Renaming…";
      (async () => {
        for (const m of list) await putMemory({ ...m, category: to, updatedAt: Date.now() });
        for (const p of await getAllPeriods()) if (p.key === `CAT:${from}` || String(p.key).startsWith(`SUB:${from}\u0000`)) await deletePeriod(p.key);
        await loadMemLists(); renderLadder();
      })();
      return;
    }
    const st = e.target.closest(".lt-story[data-mem]");
    if (st) { const m = allMems.find((x) => x.id === st.dataset.mem); if (m) { editMemory(m); window.scrollTo({ top: 0 }); } return; }
    const b = e.target.closest(".lt-add");
    if (!b) return;
    ladderPick = b.dataset.cat;
    catEl.value = b.dataset.cat; subjectEl.value = "";
    renderCategoryChips(); renderSubjectChips(); syncHeader?.();
    entryLabel.textContent = b.dataset.ask; // the prompt becomes the question for this thread
    entryLabel.classList.add("is-question");
    renderLadder();
    textEl.focus();
  });

  // First run (no days, no stories yet): point at the guide under the Journal box.
  const firstHelp = root.querySelector("#first-help");
  root.querySelector("#first-help-btn")?.addEventListener("click", () => onOpenGuide?.());
  async function syncFirstHelp() {
    if (!firstHelp) return;
    let empty = false;
    if (!isStory()) { try { empty = !(await getAllEntries()).length && !(await getAllMemories()).length; } catch { /* */ } }
    firstHelp.hidden = !empty;
  }

  function applyEntryLayout() {
    const showView = inEditMode && !editingText; // reading a saved day/story
    root.querySelector("#write-form")?.classList.toggle("reading", showView);
    if (writeTitle) writeTitle.textContent = titleText();
    if (showView) {
      renderReadView();
      const det = detailsText();
      if (entryDetails) { entryDetails.textContent = det; entryDetails.hidden = !det; }
    }
    if (cancelBtn) cancelBtn.hidden = !inEditMode; // Cancel only when there's a saved version to go back to
    syncDeleteBtn();
    if (!showView) { requestAnimationFrame(autoGrow); setTimeout(autoGrow, 120); } // size the box now, and again once the layout settles
    renderLadder();
    syncFirstHelp();
  }

  // Drafts: what's in the box is kept (per day / per story) while you type, so leaving never loses it.
  // Save or Cancel clears it.
  const draftKey = () => jkey(isStory() ? `draft:mem:${editingMemId || "new"}` : `draft:day:${dateEl.value || todayISO()}`);
  const saveDraftLocal = () => { try { localStorage.setItem(draftKey(), textEl.value); } catch { /* */ } };
  const clearDraft = () => { try { localStorage.removeItem(draftKey()); } catch { /* */ } };
  function restoreDraft() {
    try {
      const d = localStorage.getItem(draftKey());
      if (d && d !== textEl.value) { textEl.value = d; capture.update(); autoGrow(); refreshSaveState(); }
    } catch { /* */ }
  }

  // Read view: the FULL summary, with a single-select toggle to swap it for the Outline (one at a
  // time). Verbatim lives in edit mode (the editable box IS the raw transcript, for fixing things).
  let repView = "prose";
  function renderReadView() {
    const item = currentItem();
    const reps = item ? repsOf(item) : {};
    if (!reps.prose) { const t = reps.verbatim || item?.text || item?.full || ""; if (t) reps.prose = t; } // not summarized yet → your words
    const opts = [];
    if (reps.prose) opts.push(["prose", "Summary"]);
    if (reps.outline) opts.push(["outline", "Outline"]);
    if (!opts.find((o) => o[0] === repView)) repView = opts[0]?.[0] || "prose";
    const toggle = opts.length > 1
      ? `<div class="rep-toggle">${opts.map(([k, l]) => `<button type="button" class="rep-tab${repView === k ? " active" : ""}" data-rep="${k}">${l}</button>`).join("")}</div>`
      : "";
    // The zoom-out rungs first — the one word and the phrase — then Summary | Outline (same as Browse).
    const lv = (item && item.levels) || {};
    const rungs = (lv.word ? `<p class="node-word">${escapeHtml(resolveEntityTokens(lv.word))}</p>` : "")
      + (lv.phrase ? `<p class="node-phrase">${escapeHtml(resolveEntityTokens(lv.phrase))}</p>` : "");
    // Your words, one tap away — closed by default, read-only (✎ Edit is where you change them).
    const words = item && (item.raw || item.text) ? String(item.raw || item.text) : "";
    const transcript = words && repView !== "verbatim" && reps.prose !== words // (unsummarized → the prose already IS your words)
      ? `<details class="node-fold node-verbatim-fold read-transcript"><summary>Transcript</summary><div class="node-fold-body"><div class="node-verbatim verbatim">${escapeHtml(words)}</div></div></details>`
      : "";
    entryView.innerHTML = rungs + toggle + `<div class="rep-body">${renderRep(reps, repView)}</div>` + transcript;
  }
  entryView.addEventListener("click", (e) => {
    const t = e.target.closest(".rep-tab[data-rep]");
    if (!t) return;
    repView = t.dataset.rep;
    renderReadView();
  });
  // Delete lives only here, in the editor: shown when editing an existing day (inEditMode) or an
  // existing memory (editingMemId). Composing something new has nothing to delete.
  function syncDeleteBtn() {
    if (!deleteBtn) return;
    deleteBtn.hidden = !inEditMode; // only a saved day/story can be deleted
    deleteBtn.textContent = "Delete";
  }
  // ✎ Edit → the transcript box (plus any unsaved draft), cursor at the end, ready to add more.
  function startEdit() {
    if (!inEditMode) return;
    editingText = true;
    applyEntryLayout();
    restoreDraft();
    textEl.focus();
    const len = textEl.value.length;
    textEl.setSelectionRange(len, len);
  }
  function toggleEditText() { startEdit(); }
  // Cancel → throw away changes since Edit and go back to the saved version.
  cancelBtn?.addEventListener("click", () => {
    clearDraft();
    if (isStory() && editingMemOrig) editMemory(editingMemOrig);
    else loadDraft();
  });

  // Summary voice is set in Settings; here we just read the current value.
  const currentStyle = () => localStorage.getItem("summary-style") || "";

  // The manual "Regenerate summaries" control is gone — editing an entry re-summarizes automatically
  // (the background pass runs on save). updateModeUI is kept as a no-op so existing callers are safe.
  function updateModeUI() { /* nothing to toggle now */ }

  let pendingPhotos = []; // { blob, url }
  let loadedEntry = null; // the saved entry for the currently selected date

  // ---- Memory fields — this same form also files a past memory (category/subject/year). A
  // filled-in category makes it a memory instead of a dated journal entry.
  const moreEl = root.querySelector("#write-more");
  const memFields = root.querySelector("#memory-fields");
  const memoirActions = root.querySelector("#memoir-actions");
  // Switch the whole form between DIARY and MEMOIR so it's never a combined page.
  let formMode = "diary";
  const writeForm = root.querySelector("#write-form");
  function setFormMode(mode) { // "diary" | "memory"
    formMode = mode;
    const memory = mode === "memory";
    if (memFields) memFields.hidden = !memory;      // category/subject/years/location — memoir only
    if (memoirActions) memoirActions.hidden = !memory; // the voice tools — memoir only
    if (moreEl) moreEl.hidden = memory;             // the date changer — diary only (memories use years)
    if (writeForm) writeForm.classList.toggle("form-memoir", memory); // compacts the layout so form + box fit above the fold
    renderWriteBreadcrumb(dateEl.value);                              // date tree for Journal, category tree for Stories
  }
  const catEl = root.querySelector("#entry-category");
  const catChips = root.querySelector("#entry-category-chips");
  const subjectEl = root.querySelector("#entry-subject");
  const subChips = root.querySelector("#entry-subject-chips");
  const startYearEl = root.querySelector("#entry-start-year");
  const endYearEl = root.querySelector("#entry-end-year");
  const ongoingEl = root.querySelector("#entry-ongoing");
  let allMems = [];
  let editingMemId = null, editingMemOrig = null;

  // ---- Location autocomplete (Photon/OSM) — you type, pick a real place, we store its coords ----
  const locationEl = root.querySelector("#entry-location");
  const locSuggest = root.querySelector("#entry-location-suggest");
  const locHint = root.querySelector("#entry-location-hint");
  let chosenLocation = null; // { place, lat, lng } once a suggestion is picked
  let locTimer = null, locCtrl = null;
  const setLocHint = (msg, ok) => { locHint.textContent = msg; locHint.className = `field-hint${ok ? " loc-ok" : ""}`; };
  const labelOf = (p) => {
    const P = p.properties || {};
    // Build a real street address when Photon returns one: "1600 Pennsylvania Avenue NW" — house
    // number + street (or the POI name), then city/district, state, country. (My earlier version
    // dropped the number and street, collapsing an address to just its city.)
    const streetLine = (P.housenumber && P.street) ? `${P.housenumber} ${P.street}`
      : (P.name || P.street || "");
    const place = P.city || P.town || P.village || P.district || "";
    const bits = [streetLine, place && place !== streetLine ? place : null, P.state, P.country].filter(Boolean);
    return [...new Set(bits)].join(", ");
  };
  // Where you live (from Me), as coordinates — found once and remembered — so suggestions for a bare
  // street ("Agate St") start near home instead of anywhere in the world.
  async function homeBias() {
    let home = "";
    try { home = (((await ensureSelf()) || {}).facts || {}).location || ""; } catch { /* */ }
    if (!home) return null;
    const key = "home-coords::" + home.toLowerCase();
    try { const c = JSON.parse(localStorage.getItem(key) || "null"); if (c) return c; } catch { /* */ }
    try {
      const r = await fetch(`https://photon.komoot.io/api/?limit=1&q=${encodeURIComponent(home)}`);
      const f = r.ok ? ((await r.json()).features || [])[0] : null;
      if (!f) return null;
      const c = { lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] };
      localStorage.setItem(key, JSON.stringify(c));
      return c;
    } catch { return null; }
  }
  async function queryLocations(q) {
    if (locCtrl) locCtrl.abort();
    locCtrl = new AbortController();
    try {
      const bias = await homeBias();
      const near = bias ? `&lat=${bias.lat}&lon=${bias.lng}&zoom=10&location_bias_scale=0.1` : "";
      const url = `https://photon.komoot.io/api/?limit=6&q=${encodeURIComponent(q)}${near}`;
      const r = await fetch(url, { signal: locCtrl.signal });
      if (!r.ok) return [];
      return ((await r.json()).features || []).filter((f) => f.geometry && f.geometry.coordinates);
    } catch { return []; }
  }
  function renderSuggest(feats) {
    if (!feats.length) { locSuggest.hidden = true; locSuggest.innerHTML = ""; return; }
    locSuggest.innerHTML = feats.map((f, i) => {
      const [lng, lat] = f.geometry.coordinates;
      return `<button type="button" class="loc-item" data-i="${i}" data-lat="${lat}" data-lng="${lng}" data-label="${escapeAttr(labelOf(f))}">${escapeHtml(labelOf(f))}</button>`;
    }).join("");
    locSuggest.hidden = false;
  }
  const escapeAttr = (s) => String(s).replace(/"/g, "&quot;");
  const escapeHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  locationEl.addEventListener("input", () => {
    chosenLocation = null; // typing invalidates a prior pick
    const q = locationEl.value.trim();
    clearTimeout(locTimer);
    if (q.length < 3) { locSuggest.hidden = true; setLocHint("", false); return; }
    setLocHint("Searching…", false);
    locTimer = setTimeout(async () => {
      const feats = await queryLocations(q);
      renderSuggest(feats);
      setLocHint(feats.length ? "Pick the right match to pin it on the map." : "No match — try a city, or add the country.", false);
    }, 320); // debounce so we don't hammer the geocoder per keystroke
  });
  locSuggest.addEventListener("click", (e) => {
    const b = e.target.closest(".loc-item"); if (!b) return;
    chosenLocation = { place: b.dataset.label, lat: +b.dataset.lat, lng: +b.dataset.lng };
    locationEl.value = b.dataset.label;
    locSuggest.hidden = true;
    setLocHint("✓ Location set — it'll appear on the Places map.", true);
  });
  document.addEventListener("click", (e) => { if (!locSuggest.contains(e.target) && e.target !== locationEl) locSuggest.hidden = true; });
  const uniq = (vals) => [...new Set(vals.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const chipsHtml = (vals, current) => vals.map((v) =>
    `<button type="button" class="chip${v.toLowerCase() === current.toLowerCase() ? " chip-on" : ""}" data-val="${escapeHtml(v)}">${escapeHtml(v)}</button>`).join("");
  const renderCategoryChips = () => { catChips.innerHTML = chipsHtml(uniq([...DEFAULT_CATEGORIES, ...allMems.map((m) => m.category)]), catEl.value.trim()); };
  const renderSubjectChips = () => {
    const cat = catEl.value.trim().toLowerCase();
    // No category yet → no subject suggestions (subjects belong to a category); once one is
    // chosen, show only that category's subjects.
    const subs = cat ? uniq(allMems.filter((m) => (m.category || "").toLowerCase() === cat).map((m) => m.subject)) : [];
    subChips.innerHTML = chipsHtml(subs, subjectEl.value.trim());
  };
  async function loadMemLists() { allMems = await getAllMemories(); renderCategoryChips(); renderSubjectChips(); }
  loadMemLists();
  const syncHeader = () => { renderWriteBreadcrumb(); if (writeTitle) writeTitle.textContent = titleText(); };
  catEl.addEventListener("input", () => { renderCategoryChips(); renderSubjectChips(); syncHeader(); });
  subjectEl.addEventListener("input", syncHeader);
  subjectEl.addEventListener("input", renderSubjectChips);
  catChips.addEventListener("click", (e) => { const b = e.target.closest(".chip"); if (!b) return; catEl.value = b.dataset.val; renderCategoryChips(); renderSubjectChips(); });
  subChips.addEventListener("click", (e) => { const b = e.target.closest(".chip"); if (!b) return; subjectEl.value = b.dataset.val; renderSubjectChips(); });

  // Opening "add a memory" → a memory is placed by its year, not a calendar date, so blank the
  // (The date fold is now just a date changer for diary entries; memory mode is entered via Memoir,
  // which shows the memory fields — no more "open the fold to convert to a memory".)

  function refreshSaveState() {
    saveBtn.disabled = !(textEl.value.trim() || pendingPhotos.length);
  }

  // The prompt reflects the selected date: "What happened today?" for today, else the date itself.
  function promptForDate(date, editMode) {
    const iso = date || todayISO();
    if (iso === todayISO()) return editMode ? "Today" : "What happened today?";
    const d = new Date(iso + "T12:00:00");
    const sameYear = d.getFullYear() === new Date().getFullYear();
    const pretty = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
    return editMode ? pretty : `What happened — ${pretty}?`;
  }

  // Show the selected day's saved entry in the box, cursor at the end, ready to continue.
  async function loadDraft({ focus = false } = {}) {
    const date = dateEl.value || todayISO();
    const entry = await getEntry(date);
    loadedEntry = entry || null;
    pendingPhotos.forEach((p) => URL.revokeObjectURL(p.url));
    // Show the day's existing photos too — the box represents the whole entry.
    pendingPhotos = (entry?.photos ?? []).map((ph) => {
      const b = storedToBlob(ph);
      return { blob: b, url: URL.createObjectURL(b) };
    });
    renderThumbs();
    // Edit the original words; if raw was purged and we fall back to the summary, show names not tokens.
    textEl.value = entry?.raw ?? resolveEntityTokens(entry?.full ?? "") ?? "";

    // Day has data → the editor (Re-summarize, literal save). No data → compose.
    const editMode = !!entry;
    inEditMode = editMode;
    editingText = false;
    entryLabel.textContent = editMode ? "Your words — add more, or fix anything" : promptForDate(date, false);
    setFormMode("diary"); // pure diary — no memory fields, no memoir voice tools
    renderWriteBreadcrumb(date);
    currentSummarized = entry ? entry.summarized !== false : true;
    saveBtn.textContent = "Save";
    updateModeUI();
    applyEntryLayout();
    capture.reset(); capture.refresh(); // recolour the loaded text and rebuild the Found list for this day
    if (!editMode) restoreDraft(); // composing: bring back anything typed before you left
    refreshSaveState();
    if (focus && textEl.offsetParent) {
      textEl.focus();
      const len = textEl.value.length;
      textEl.setSelectionRange(len, len);
      textEl.scrollTop = textEl.scrollHeight;
    }
  }

  function renderThumbs() {
    thumbsEl.innerHTML = "";
    pendingPhotos.forEach((p, i) => {
      const fig = document.createElement("div");
      fig.className = "photo-thumb";
      const media = (p.blob.type || "").startsWith("video/")
        ? `<video src="${p.url}" muted playsinline></video>`
        : `<img src="${p.url}" alt="">`;
      fig.innerHTML = `${media}<button type="button" aria-label="Remove" data-i="${i}">×</button>`;
      thumbsEl.appendChild(fig);
    });
  }

  async function addFiles(input) {
    const files = [...input.files];
    input.value = "";
    for (const file of files) {
      // Videos are stored as-is; only images are downscaled/re-encoded.
      const blob = file.type.startsWith("video/") ? file : await processImage(file);
      pendingPhotos.push({ blob, url: URL.createObjectURL(blob) });
      renderThumbs();
      refreshSaveState();
    }
  }
  photoInput.addEventListener("change", () => addFiles(photoInput));

  // In-app camera via getUserMedia — stays on the page, so iOS never reloads the app
  // (which was wiping the photo strip when the native camera was used).
  const overlay = root.querySelector("#camera-overlay");
  const video = root.querySelector("#camera-video");
  let stream = null;
  let facing = "environment";

  async function startStream() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing }, audio: false });
    video.srcObject = stream;
    await video.play().catch(() => {});
  }
  function stopCamera() {
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    video.srcObject = null;
    overlay.hidden = true;
  }
  async function openCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      statusEl.textContent = "Camera not available here — use 🖼 Photo / file.";
      statusEl.className = "write-status error";
      return;
    }
    try {
      overlay.hidden = false;
      await startStream();
    } catch (err) {
      stopCamera();
      statusEl.textContent = `Camera unavailable: ${err.message}. Try 🖼 Photo / file.`;
      statusEl.className = "write-status error";
    }
  }
  async function capturePhoto() {
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return;
    const max = 1600;
    const scale = Math.min(1, max / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.85));
    if (blob) {
      pendingPhotos.push({ blob, url: URL.createObjectURL(blob) });
      renderThumbs();
      refreshSaveState();
    }
    stopCamera();
  }

  cameraBtn.addEventListener("click", openCamera);
  root.querySelector("#camera-shutter").addEventListener("click", capturePhoto);
  root.querySelector("#camera-cancel").addEventListener("click", stopCamera);
  root.querySelector("#camera-flip").addEventListener("click", () => {
    facing = facing === "environment" ? "user" : "environment";
    startStream().catch(() => {});
  });

  thumbsEl.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-i]");
    if (!btn) return;
    const i = Number(btn.dataset.i);
    URL.revokeObjectURL(pendingPhotos[i].url);
    pendingPhotos.splice(i, 1);
    renderThumbs();
    refreshSaveState();
  });

  // Auto-grow the text box to fit its content, so it starts at a few lines and grows as you write
  // (pushing the memory form below it down), instead of scrolling inside a fixed box.
  function autoGrow() {
    if (!textEl || !textEl.offsetParent) return; // skip when the box (or its container) is hidden
    textEl.style.height = "auto";
    textEl.style.height = textEl.scrollHeight + "px";
  }
  // Re-measure at the moments a mobile layout can settle late (focus opening the keyboard, the viewport
  // resizing, fonts finishing) so the box height always matches its content and can't sit over the
  // buttons below it.
  const onText = () => { refreshSaveState(); capture.update(); autoGrow(); saveDraftLocal(); };
  textEl.addEventListener("input", onText);
  textEl.addEventListener("focus", autoGrow);
  window.addEventListener("resize", autoGrow);
  if (window.visualViewport) window.visualViewport.addEventListener("resize", autoGrow);
  try { document.fonts && document.fonts.ready.then(autoGrow); } catch { /* */ }
  dateEl.addEventListener("change", () => loadDraft({ focus: true }));

  // Delete the thing being edited (a day entry or a memory), then hand navigation back to the caller.
  deleteBtn.addEventListener("click", async () => {
    if (editingMemId) {
      const mem = editingMemOrig;
      const label = mem?.subject || mem?.category || mem?.label || "this memory";
      if (!confirm(`Delete “${label}”? This can't be undone.`)) return;
      await deleteMemory(editingMemId);
      editingMemId = null; editingMemOrig = null;
      if (onDeletedMemory) onDeletedMemory(mem);
      return;
    }
    if (!inEditMode || !loadedEntry) return;
    const date = dateEl.value || todayISO();
    const pretty = new Date(date + "T12:00:00").toLocaleDateString("en-US",
      { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    if (!confirm(`Delete the entry for ${pretty}? This can't be undone.`)) return;
    await deleteEntry(date);
    loadedEntry = null; inEditMode = false;
    if (onDeleted) onDeleted(date);
  });
  editTextToggle.addEventListener("click", toggleEditText);

  // In-app dictation (for devices whose keyboard has no mic). See dictation.js for the
  // Android-robust handling of auto-restart and de-duplication.
  setupDictation(micBtn, textEl, statusEl, onText); // dictation writes textEl.value → recolour + refresh Save
  root.querySelector("#memoir-handsfree")?.addEventListener("click", async () => {
    primeAudio(); // unlock audio IN this tap, before the async import (mobile blocks post-gesture play)
    const { startLifeInterview } = await import("./lifeinterview.js");
    startLifeInterview(() => loadMemLists());
  });
  // Structured voice capture of a SERIES of memories (form-fill then record, category by category).
  root.querySelector("#memoir-series")?.addEventListener("click", async () => {
    primeAudio();
    const { startMemoryVoice } = await import("./memoryvoice.js");
    startMemoryVoice(catEl.value.trim() || undefined, () => loadMemLists());
  });

  // Generate BOTH a prose and an outline summary of the same text (voice applies to prose only).
  async function summarizeBoth(date, text) {
    const call = (format, style) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 240000); // big/reasoning models can be slow
      return fetch("/api/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...llmOverrides(), mode: "day", date, text, ...nowContext(), style, format }),
        signal: ctrl.signal,
      }).then(async (r) => {
        if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || `Server error ${r.status}`); }
        return r.json();
      }).finally(() => clearTimeout(timer));
    };
    const [prose, outline] = await Promise.all([call("prose", currentStyle()), call("outline", "")]);
    return { prose: { brief: prose.brief, full: prose.full }, outline: { brief: outline.brief, full: outline.full } };
  }

  // Save as a memory (category filled) — stored whole; the Journal's background pass summarizes.
  // Quietly persist what's in the box (no navigation) so tapping a Found name never loses your words.
  async function persistDraft() {
    const text = textEl.value.trim();
    if (!text) return;
    if (formMode === "memory") {
      const startYear = startYearEl.value.trim() ? parseInt(startYearEl.value, 10) : null;
      const endRaw = endYearEl.value.trim() ? parseInt(endYearEl.value, 10) : null;
      const ongoing = ongoingEl.checked;
      const endYear = (!ongoing && startYear != null && endRaw && endRaw !== startYear) ? endRaw : null;
      const label = startYear == null ? "sometime" : endYear ? `${Math.min(startYear, endYear)}–${Math.max(startYear, endYear)}` : ongoing ? `${startYear}–present` : String(startYear);
      const mem = { id: editingMemId || uid(), category: catEl.value.trim(), subject: subjectEl.value.trim(), startYear, endYear, label, text, needsSummary: true, createdAt: editingMemOrig?.createdAt || Date.now(), updatedAt: Date.now() };
      if (ongoing) mem.ongoing = true;
      await putMemory(mem);
      editingMemId = mem.id; editingMemOrig = mem;
      return;
    }
    const date = dateEl.value || todayISO();
    const existing = loadedEntry ?? (await getEntry(date));
    let toSave;
    if (existing) { toSave = { ...existing, raw: text, rawSavedAt: Date.now(), updatedAt: Date.now(), needsSummary: true }; delete toSave.levels; delete toSave.prose; delete toSave.outline; }
    else { toSave = { date, dayOfWeek: dayOfWeek(date), raw: text, rawSavedAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now(), needsSummary: true }; }
    await putEntry(withMode(toSave, "verbatim"));
    loadedEntry = toSave;
  }

  async function saveMemory() {
    const text = textEl.value.trim();
    if (!text) { statusEl.textContent = "Add the story text first."; statusEl.className = "write-status error"; return; }
    clearDraft(); // (keyed to this story — clear before the id changes)
    saveBtn.disabled = true; statusEl.textContent = "Saving…"; statusEl.className = "write-status";
    try {
      const startYear = startYearEl.value.trim() ? parseInt(startYearEl.value, 10) : null;
      const endRaw = endYearEl.value.trim() ? parseInt(endYearEl.value, 10) : null;
      const ongoing = ongoingEl.checked;
      const endYear = (!ongoing && startYear != null && endRaw && endRaw !== startYear) ? endRaw : null;
      const category = catEl.value.trim();
      const subject = subjectEl.value.trim();
      const label = startYear == null ? "sometime"
        : endYear ? `${Math.min(startYear, endYear)}–${Math.max(startYear, endYear)}`
        : ongoing ? `${startYear}–present` : String(startYear);
      const photos = await Promise.all(pendingPhotos.map((p) => photoToStored(p.blob)));
      const mem = {
        id: editingMemId || uid(), category, subject, startYear, endYear, label, text, photos,
        needsSummary: true, createdAt: editingMemOrig?.createdAt || Date.now(), updatedAt: Date.now(),
      };
      if (ongoing) mem.ongoing = true;
      // Location: a freshly-picked place, or keep the one already on the memory (if the field wasn't
      // changed). Clearing the field removes the location.
      if (chosenLocation) { mem.place = chosenLocation.place; mem.lat = chosenLocation.lat; mem.lng = chosenLocation.lng; }
      else if (locationEl.value.trim() && editingMemOrig && editingMemOrig.place && locationEl.value.trim() === editingMemOrig.place) {
        mem.place = editingMemOrig.place; mem.lat = editingMemOrig.lat; mem.lng = editingMemOrig.lng;
      }
      if (editingMemOrig?.prose) mem.prose = editingMemOrig.prose;
      if (editingMemOrig?.outline) mem.outline = editingMemOrig.outline;
      if (editingMemOrig?.levels) mem.levels = editingMemOrig.levels;
      await putMemory(mem);
      editingMemId = null; editingMemOrig = null;
      if (onSavedMemory) onSavedMemory(mem);
      else { statusEl.textContent = "Saved ✓"; statusEl.className = "write-status ok"; }
    } catch (err) {
      statusEl.textContent = `Couldn't save: ${err.message}`; statusEl.className = "write-status error"; refreshSaveState();
    }
  }

  function resetMemoryFields() {
    editingMemId = null; editingMemOrig = null;
    setFormMode("diary");
    catEl.value = ""; subjectEl.value = ""; startYearEl.value = ""; endYearEl.value = ""; ongoingEl.checked = false;
    locationEl.value = ""; chosenLocation = null; locSuggest.hidden = true; setLocHint("", false);
    renderCategoryChips(); renderSubjectChips();
  }

  // Load an existing memory into this form for editing (called from the Journal's ✎ button).
  // A saved story opens in READ (like a saved day); ✎ Edit shows the box + fields.
  function editMemory(mem) {
    editingMemId = mem.id; editingMemOrig = mem;
    loadedEntry = null; inEditMode = true; editingText = false;
    setFormMode("memory"); memoirActions.hidden = true; // one story: fields, not the series tools
    dateEl.value = "";
    entryLabel.textContent = "Your words — add more, or fix anything";
    pendingPhotos = (mem.photos ?? []).map((ph) => { const b = storedToBlob(ph); return { blob: b, url: URL.createObjectURL(b) }; });
    renderThumbs();
    catEl.value = mem.category || ""; subjectEl.value = mem.subject || "";
    startYearEl.value = mem.startYear ?? ""; endYearEl.value = mem.endYear ?? ""; ongoingEl.checked = !!mem.ongoing;
    locationEl.value = mem.place || ""; chosenLocation = null; locSuggest.hidden = true;
    setLocHint(mem.place ? "✓ Location set." : "", !!mem.place);
    textEl.value = mem.text || "";
    renderCategoryChips(); renderSubjectChips();
    renderWriteBreadcrumb();
    applyEntryLayout(); // saved story → READ view
    refreshSaveState();
    capture.reset(); capture.refresh(); // colour the story's text + collect its names
    saveBtn.textContent = "Save";
    statusEl.textContent = ""; statusEl.className = "write-status";
  }

  root.querySelector("#write-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (formMode === "memory" || editingMemId) { await saveMemory(); return; } // memoir mode → a memory
    const date = dateEl.value || todayISO();
    const text = textEl.value.trim();
    const existing = loadedEntry ?? (await getEntry(date));
    const editMode = existing != null;

    saveBtn.disabled = true;
    statusEl.textContent = "Saving…";
    statusEl.className = "write-status";

    try {
      const photos = await Promise.all(pendingPhotos.map((p) => photoToStored(p.blob)));

      let toSave, mode;
      if (editMode) {
        // Editing replaces the day's words; drop the stale summary so the Journal's background
        // pass regenerates the whole ladder from the edited text.
        toSave = { ...existing, raw: text, rawSavedAt: Date.now(), photos, updatedAt: Date.now(), needsSummary: true };
        delete toSave.levels; delete toSave.prose; delete toSave.outline;
        mode = "verbatim";
      } else if (text) {
        // New day: store immediately (verbatim). Prose + outline are generated by the
        // Journal's background pass once we land there, so saving never blocks on the model.
        toSave = { date, dayOfWeek: dayOfWeek(date), raw: text, rawSavedAt: Date.now(), photos, createdAt: Date.now(), updatedAt: Date.now() };
        mode = "verbatim";
      } else {
        // Photo-only save.
        toSave = { ...(existing || {}), date, dayOfWeek: dayOfWeek(date), photos, createdAt: existing?.createdAt ?? Date.now(), updatedAt: Date.now() };
        mode = existing?.mode || "verbatim";
      }

      // A save is a purely local IndexedDB write — it should take milliseconds. If it doesn't
      // resolve, the DB is wedged (usually another tab of the app holding it open). Surface that
      // instead of hanging on "Saving…" forever, and DON'T reload the box — the typed text stays.
      await withTimeout(putEntry(withMode(toSave, mode)), 8000, "writing the entry");
      clearDraft(); // saved — the in-progress draft is no longer needed

      await withTimeout(loadDraft(), 8000, "reloading");
      // Confirmation is seeing the entry land in the Journal, in its own day page.
      if (onSaved) onSaved(date);
      else { statusEl.textContent = "Saved ✓"; statusEl.className = "write-status ok"; }
    } catch (err) {
      statusEl.textContent = `Couldn't save: ${err.message}`;
      statusEl.className = "write-status error";
      refreshSaveState();
    }
  });

  // Start a fresh memory, optionally pre-filled with a category/subject (from a Journal page).
  function newMemory(seed = {}) {
    loadedEntry = null; inEditMode = false; editingText = false;
    editingMemId = null; editingMemOrig = null;
    textEl.value = "";
    pendingPhotos = []; renderThumbs();
    dateEl.value = "";
    catEl.value = seed.category || "";
    subjectEl.value = seed.subject || "";
    ladderPick = null;
    startYearEl.value = ""; endYearEl.value = ""; ongoingEl.checked = false;
    setFormMode("memory"); // show memory fields + voice tools, hide the diary date
    renderCategoryChips(); renderSubjectChips();
    entryLabel.textContent = "Tell a story";
    entryLabel.classList.remove("is-question");
    saveBtn.textContent = "Save";
    renderWriteBreadcrumb();
    applyEntryLayout();
    capture.reset(); // fresh story — clear the Found list
    restoreDraft();  // bring back anything typed before you left
    refreshSaveState();
    window.scrollTo({ top: 0 });
    textEl.focus({ preventScroll: true }); // start talking/typing right away
  }

  return {
    // opts.edit → open straight into EDIT (the user tapped an Edit button elsewhere, e.g. in the browse).
    refresh: (arg, opts = {}) => {
      const then = () => { if (opts.edit) startEdit(); };
      if (arg && typeof arg === "object") {
        // An object with an id → that story; without → a new story pre-filled from it.
        return loadDraft({ focus: false }).then(() => { loadMemLists(); arg.id ? editMemory(arg) : newMemory(arg); then(); });
      }
      resetMemoryFields();
      if (arg) dateEl.value = arg;
      return loadDraft({ focus: true }).then(() => { loadMemLists(); then(); });
    },
    editMemory,
  };
}
