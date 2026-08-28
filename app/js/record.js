// "Write" view — a plain text box (dictate with the keyboard mic, or the in-app 🎤
// Dictate button on desktop via the Web Speech API) plus photos.
// On save we summarize via /api/summarize, store the result + photos in IndexedDB,
// and throw the raw text away.

import { getEntry, putEntry, getAllEntries, clearAllEntries, putMemory, getAllMemories, deleteEntry, deleteMemory, photoToStored, storedToBlob } from "./db.js";
import { renderReps, wireReps, isOutlineText, escapeHtml } from "./render.js";
import { deriveBrief, withMode, repsOf } from "./entry.js";

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
  return {
    provider: localStorage.getItem("llm-provider") || "",
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

export function initRecord(root, { onSaved, onSavedMemory, onDeleted, onDeletedMemory } = {}) {
  root.innerHTML = `
    <aside class="app-intro" id="app-intro" hidden>
      <button type="button" class="app-intro-dismiss" id="app-intro-dismiss" aria-label="Dismiss">×</button>
      <p class="app-intro-lead"><strong>Speak, Memory</strong> turns talk into a life story.</p>
      <p>Just talk — dictate a journal entry, or add a past memory (a place you lived, a job, a
      relationship). It writes compact summaries that zoom from a single day out to your whole life.</p>
      <p>Completely free — no account, no login, no ads, no tracking. Everything stays in your
      browser, private to this device.</p>
    </aside>
    <form class="write-form" id="write-form">
      <h2 class="view-intro">Write</h2>
      <label class="field">
        <span class="field-label">Date</span>
        <input type="date" id="entry-date" value="${todayISO()}" max="${todayISO()}">
      </label>

      <details class="write-more" id="write-more">
        <summary>A past memory? Give it a category, subject, or year</summary>
        <div class="field">
          <span class="field-label">Category</span>
          <input type="text" id="entry-category" autocomplete="off" placeholder="childhood, girlfriends…  (blank = journal)">
          <div class="chip-row" id="entry-category-chips"></div>
        </div>
        <div class="field">
          <span class="field-label">Subject <em>(optional)</em></span>
          <input type="text" id="entry-subject" autocomplete="off" placeholder="a name — Deena, the Elm St. house">
          <div class="chip-row" id="entry-subject-chips"></div>
        </div>
        <div class="field loc-field">
          <span class="field-label">Location <em>(optional — for the map)</em></span>
          <input type="text" id="entry-location" autocomplete="off" placeholder="type a city or address, then pick a match">
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
            <span class="field-label">End year</span>
            <input type="number" id="entry-end-year" min="1900" max="2100" inputmode="numeric" placeholder="1974">
          </label>
          <label class="mem-ongoing"><input type="checkbox" id="entry-ongoing"> still going</label>
        </fieldset>
        <span class="field-hint">Fill in a category to file this as a memory instead of a dated journal entry.</span>
      </details>

      <label class="field" id="headline-field" hidden>
        <span class="field-label">Headline</span>
        <input type="text" id="entry-brief">
      </label>

      <label class="field">
        <span class="field-label" id="entry-label">What happened?</span>
        <textarea id="entry-text" rows="10"
          placeholder="Just talk — tap 🎤 Dictate below (or your keyboard mic) — or type…"></textarea>
      </label>
      <button type="button" class="photo-add mic-btn" id="mic-btn" hidden><span>🎤 Dictate</span></button>

      <div class="entry-view" id="entry-view" hidden></div>
      <button type="button" class="detail-nav-btn edit-text-btn" id="edit-text-toggle" hidden>✎ Edit text</button>

      <div class="edit-tools" id="write-edit-tools" hidden>
        <button type="button" class="detail-nav-btn" id="write-resummarize">↻ Re-summarize into prose</button>
        <span class="edit-hint">Dictated something rough? This rewrites the whole entry into clean prose.</span>
      </div>

      <div class="photo-row">
        <button type="button" class="photo-add" id="entry-camera-btn"><span>📷 Camera</span></button>
        <label class="photo-add">
          <input type="file" id="entry-photo" accept="image/*,video/*" multiple hidden>
          <span>🖼 Photo / video</span>
        </label>
        <div class="photo-thumbs" id="photo-thumbs"></div>
      </div>

      <button type="submit" class="save-btn" id="save-btn" disabled>Save entry</button>
      <button type="button" class="delete-entry-btn" id="delete-entry-btn" hidden>Delete entry</button>
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

  // First-visit intro card: show until the reader dismisses it (or has already written something).
  const introEl = root.querySelector("#app-intro");
  const introDismiss = root.querySelector("#app-intro-dismiss");
  if (introEl && localStorage.getItem("sm-intro-dismissed") !== "1") {
    introEl.hidden = false;
    introDismiss?.addEventListener("click", () => {
      introEl.hidden = true;
      localStorage.setItem("sm-intro-dismissed", "1");
    });
  }

  const dateEl = root.querySelector("#entry-date");
  const textEl = root.querySelector("#entry-text");
  const micBtn = root.querySelector("#mic-btn");
  const photoInput = root.querySelector("#entry-photo");
  const cameraBtn = root.querySelector("#entry-camera-btn");
  const thumbsEl = root.querySelector("#photo-thumbs");
  const saveBtn = root.querySelector("#save-btn");
  const deleteBtn = root.querySelector("#delete-entry-btn");
  const statusEl = root.querySelector("#write-status");
  const briefEl = root.querySelector("#entry-brief");
  const headlineField = root.querySelector("#headline-field");
  const entryLabel = root.querySelector("#entry-label");
  const editTools = root.querySelector("#write-edit-tools");
  const entryView = root.querySelector("#entry-view");
  const editTextToggle = root.querySelector("#edit-text-toggle");
  wireReps(entryView);
  let currentSummarized = true; // mode of the loaded entry (edit mode)
  let inEditMode = false;
  let editingText = false; // in edit mode: showing the raw text box vs the formatted view

  // A saved summary (prose/outline) shows as formatted rich text; the raw box is for
  // capture and hand-editing. Verbatim/compose keep the plain box.
  function applyEntryLayout() {
    // In edit mode, show the entry exactly like the Journal view (all representations).
    const showView = inEditMode && !editingText;
    entryView.hidden = !showView;
    textEl.hidden = showView;
    editTextToggle.hidden = !inEditMode;
    editTextToggle.textContent = editingText ? "Done editing" : "✎ Edit text";
    if (showView) entryView.innerHTML = renderReps(loadedEntry ? repsOf(loadedEntry) : {});
    syncDeleteBtn();
  }
  // Delete lives only here, in the editor: shown when editing an existing day (inEditMode) or an
  // existing memory (editingMemId). Composing something new has nothing to delete.
  function syncDeleteBtn() {
    if (!deleteBtn) return;
    const editingDay = inEditMode && loadedEntry;
    deleteBtn.hidden = !(editingDay || editingMemId);
    deleteBtn.textContent = editingMemId ? "Delete memory" : "Delete entry";
  }
  function toggleEditText() {
    editingText = !editingText;
    applyEntryLayout();
    if (editingText) {
      textEl.focus();
      const len = textEl.value.length;
      textEl.setSelectionRange(len, len);
    }
  }

  // Summary voice is set in Settings; here we just read the current value.
  const currentStyle = () => localStorage.getItem("summary-style") || "";

  // One control, three ways to capture: verbatim (no LLM), prose, or outline.
  const resummarizeBtn = root.querySelector("#write-resummarize");
  const editHint = root.querySelector("#write-edit-tools .edit-hint");

  // The source Re-summarize regenerates from: the original raw text (kept ~1 week),
  // or a verbatim entry's own words. Empty when neither is available.
  function resummarizeSource() {
    if (rawFresh(loadedEntry)) return loadedEntry.raw;
    if (loadedEntry && loadedEntry.summarized === false) return loadedEntry.full || "";
    return "";
  }

  function updateModeUI() {
    editTools.hidden = !inEditMode || !rawFresh(loadedEntry); // regeneration needs the raw source
    resummarizeBtn.textContent = "↻ Regenerate summaries";
    if (editHint) editHint.textContent = "Regenerates prose and outline from your original words.";
  }
  updateModeUI();

  let pendingPhotos = []; // { blob, url }
  let loadedEntry = null; // the saved entry for the currently selected date

  // ---- Memory fields — this same form also files a past memory (category/subject/year). A
  // filled-in category makes it a memory instead of a dated journal entry.
  const moreEl = root.querySelector("#write-more");
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
  async function queryLocations(q) {
    if (locCtrl) locCtrl.abort();
    locCtrl = new AbortController();
    try {
      const url = `https://photon.komoot.io/api/?limit=6&q=${encodeURIComponent(q)}`;
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
  const renderCategoryChips = () => { catChips.innerHTML = chipsHtml(uniq(allMems.map((m) => m.category)), catEl.value.trim()); };
  const renderSubjectChips = () => {
    const cat = catEl.value.trim().toLowerCase();
    subChips.innerHTML = chipsHtml(uniq(allMems.filter((m) => !cat || (m.category || "").toLowerCase() === cat).map((m) => m.subject)), subjectEl.value.trim());
  };
  async function loadMemLists() { allMems = await getAllMemories(); renderCategoryChips(); renderSubjectChips(); }
  loadMemLists();
  catEl.addEventListener("input", () => { renderCategoryChips(); renderSubjectChips(); });
  subjectEl.addEventListener("input", renderSubjectChips);
  catChips.addEventListener("click", (e) => { const b = e.target.closest(".chip"); if (!b) return; catEl.value = b.dataset.val; renderCategoryChips(); renderSubjectChips(); });
  subChips.addEventListener("click", (e) => { const b = e.target.closest(".chip"); if (!b) return; subjectEl.value = b.dataset.val; renderSubjectChips(); });

  // Opening "add a memory" → a memory is placed by its year, not a calendar date, so blank the
  // date field. And starting a memory from a saved day begins with a BLANK box (don't carry the
  // day's text into it); a fresh unsaved draft is left alone so you can turn it into a memory.
  moreEl.addEventListener("toggle", () => {
    if (moreEl.open) {
      dateEl.value = "";
      briefEl.value = ""; headlineField.hidden = true; // headline belongs to a dated entry, not a memory
      if (inEditMode && !editingMemId) {
        loadedEntry = null; inEditMode = false; editingText = false;
        textEl.value = "";
        pendingPhotos = []; renderThumbs();
        entryLabel.textContent = "The memory";
        saveBtn.textContent = "Save memory";
        applyEntryLayout();
        refreshSaveState();
        textEl.focus();
      }
    } else if (!dateEl.value) {
      dateEl.value = todayISO(); // closed again → back to a dated journal entry (today by default)
    }
  });

  function refreshSaveState() {
    saveBtn.disabled = !(textEl.value.trim() || pendingPhotos.length);
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
    textEl.value = entry?.raw ?? entry?.full ?? ""; // edit the original words, not the summary

    // Day has data → the editor (Re-summarize, literal save). No data → compose.
    const editMode = !!entry;
    inEditMode = editMode;
    editingText = false;
    headlineField.hidden = !editMode;
    entryLabel.textContent = editMode ? "Entry" : "What happened?";
    briefEl.value = entry?.brief ?? "";
    currentSummarized = entry ? entry.summarized !== false : true;
    saveBtn.textContent = editMode ? "Update entry" : "Save entry";
    updateModeUI();
    applyEntryLayout();
    refreshSaveState();
    if (focus && !textEl.hidden) {
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

  textEl.addEventListener("input", refreshSaveState);
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

  // In-app dictation for desktop (no keyboard mic). Uses the Web Speech API where
  // available (Chrome/Edge; partial in Safari). Final results are appended to the box.
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRec && micBtn) {
    micBtn.hidden = false;
    let recog = null;
    const setIdle = () => { micBtn.classList.remove("listening"); micBtn.querySelector("span").textContent = "🎤 Dictate"; };
    const setLive = () => { micBtn.classList.add("listening"); micBtn.querySelector("span").textContent = "⏹ Stop"; };
    micBtn.addEventListener("click", () => {
      if (recog) { recog.stop(); return; }
      recog = new SpeechRec();
      recog.lang = navigator.language || "en-US";
      recog.interimResults = true;
      recog.continuous = true;
      // Text already in the box before we start; dictation is appended after it.
      let base = textEl.value;
      let settled = "";
      recog.onresult = (e) => {
        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const chunk = e.results[i][0].transcript;
          if (e.results[i].isFinal) settled += chunk; else interim += chunk;
        }
        const sep = base && !/\s$/.test(base) ? " " : "";
        textEl.value = base + sep + (settled + interim).replace(/^\s+/, "");
        refreshSaveState();
      };
      recog.onerror = (e) => {
        if (statusEl && e.error !== "aborted" && e.error !== "no-speech") {
          statusEl.textContent = e.error === "not-allowed"
            ? "Microphone blocked — allow mic access for this site."
            : `Dictation error: ${e.error}`;
          statusEl.className = "write-status error";
        }
      };
      recog.onend = () => { recog = null; setIdle(); textEl.value = textEl.value.trimEnd(); refreshSaveState(); textEl.focus(); };
      setLive();
      try { recog.start(); } catch { recog = null; setIdle(); }
    });
  }

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

  // Regenerate both summaries from the original raw text, then save.
  async function resummarizeWrite() {
    const btn = root.querySelector("#write-resummarize");
    const source = resummarizeSource().trim();
    if (!source) {
      statusEl.textContent = "The original text for this day is no longer available.";
      statusEl.className = "write-status error";
      return;
    }
    const date = dateEl.value || todayISO();
    btn.disabled = true;
    statusEl.textContent = "Regenerating prose + outline…";
    statusEl.className = "write-status";
    try {
      const { prose, outline } = await summarizeBoth(date, source);
      const existing = loadedEntry ?? (await getEntry(date));
      const updated = {
        ...(existing || {}),
        date, dayOfWeek: dayOfWeek(date),
        raw: source, rawSavedAt: existing?.rawSavedAt ?? Date.now(),
        prose, outline, updatedAt: Date.now(),
      };
      await putEntry(withMode(updated, existing?.mode || "prose"));
      statusEl.textContent = "Regenerated ✓";
      statusEl.className = "write-status ok";
      await loadDraft();
    } catch (err) {
      statusEl.textContent = `Couldn't regenerate: ${err.message}`;
      statusEl.className = "write-status error";
    } finally {
      btn.disabled = false;
    }
  }
  root.querySelector("#write-resummarize").addEventListener("click", resummarizeWrite);

  // Save as a memory (category filled) — stored whole; the Journal's background pass summarizes.
  async function saveMemory() {
    const text = textEl.value.trim();
    if (!text) { statusEl.textContent = "Add the memory text first."; statusEl.className = "write-status error"; return; }
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
    moreEl.open = false;
    catEl.value = ""; subjectEl.value = ""; startYearEl.value = ""; endYearEl.value = ""; ongoingEl.checked = false;
    locationEl.value = ""; chosenLocation = null; locSuggest.hidden = true; setLocHint("", false);
    renderCategoryChips(); renderSubjectChips();
  }

  // Load an existing memory into this form for editing (called from the Journal's ✎ button).
  function editMemory(mem) {
    editingMemId = mem.id; editingMemOrig = mem;
    // Leave day-edit mode (a day may have been loaded first) so the plain memory text box shows,
    // not the day's formatted entry-view.
    loadedEntry = null; inEditMode = false; editingText = false;
    dateEl.value = ""; briefEl.value = ""; headlineField.hidden = true;
    entryLabel.textContent = "The memory";
    pendingPhotos = (mem.photos ?? []).map((ph) => { const b = storedToBlob(ph); return { blob: b, url: URL.createObjectURL(b) }; });
    renderThumbs();
    moreEl.open = true;
    catEl.value = mem.category || ""; subjectEl.value = mem.subject || "";
    startYearEl.value = mem.startYear ?? ""; endYearEl.value = mem.endYear ?? ""; ongoingEl.checked = !!mem.ongoing;
    locationEl.value = mem.place || ""; chosenLocation = null; locSuggest.hidden = true;
    setLocHint(mem.place ? "✓ Location set." : "", !!mem.place);
    textEl.value = mem.text || "";
    renderCategoryChips(); renderSubjectChips();
    applyEntryLayout(); // inEditMode is false now → shows the text box
    refreshSaveState();
    saveBtn.textContent = "Update memory";
    statusEl.textContent = `Editing “${mem.subject || mem.category || mem.label || "memory"}” — change anything, then Save.`;
    statusEl.className = "write-status";
    textEl.focus();
  }

  root.querySelector("#write-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (catEl.value.trim() || editingMemId) { await saveMemory(); return; } // category filled → a memory
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
    briefEl.value = ""; headlineField.hidden = true;
    catEl.value = seed.category || "";
    subjectEl.value = seed.subject || "";
    startYearEl.value = ""; endYearEl.value = ""; ongoingEl.checked = false;
    moreEl.open = true;
    renderCategoryChips(); renderSubjectChips();
    entryLabel.textContent = "The memory";
    saveBtn.textContent = "Save memory";
    applyEntryLayout();
    refreshSaveState();
    (seed.subject ? textEl : subjectEl).focus();
  }

  return {
    refresh: (arg) => {
      if (arg && typeof arg === "object") {
        // An object with an id → edit that memory; without → start a new memory pre-filled from it.
        return loadDraft({ focus: false }).then(() => { loadMemLists(); arg.id ? editMemory(arg) : newMemory(arg); });
      }
      resetMemoryFields();
      if (arg) dateEl.value = arg;
      return loadDraft({ focus: true }).then(() => loadMemLists());
    },
    editMemory,
  };
}
