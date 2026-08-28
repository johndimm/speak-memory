// Memories input — a simple structured form the user fills in directly (no LLM extraction):
//   • category  — free text, with the categories you've used offered for quick reuse
//   • start year — required
//   • end year   — optional (leave blank for a single-year memory, fill for a span)
//   • the memory — typed or dictated
// Each memory is stored whole and summarized (first-person prose + outline) in the
// background. Browsing happens in the Journal, where memories are grouped by category.

import { putMemory, getAllMemories } from "./db.js";
import { escapeHtml } from "./render.js";
import { setupDictation } from "./dictation.js";

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function currentStyle() { return localStorage.getItem("summary-style") || ""; }

export function initMemories(root, { onChanged, onOpenMemory } = {}) {
  root.innerHTML = `
    <form class="mem-form" id="mem-form">
      <h2 class="view-intro">Add a memory</h2>
      <div class="field">
        <span class="field-label">Category</span>
        <input type="text" id="mem-category" autocomplete="off"
          placeholder="childhood, schools, girlfriends…">
        <div class="chip-row" id="mem-category-chips"></div>
        <span class="field-hint">Tap one you've used, or type a new one.</span>
      </div>

      <div class="field">
        <span class="field-label">Subject <em>(optional)</em></span>
        <input type="text" id="mem-subject" autocomplete="off"
          placeholder="a name — Deena, Roosevelt High, the Elm St. house">
        <div class="chip-row" id="mem-subject-chips"></div>
        <span class="field-hint">Who or what it's about, within the category.</span>
      </div>

      <fieldset class="mem-years">
        <label class="field mem-year-field">
          <span class="field-label">Year <em>(optional)</em></span>
          <input type="number" id="mem-start" min="1900" max="2100" placeholder="1971" inputmode="numeric">
        </label>
        <span class="mem-year-dash">–</span>
        <label class="field mem-year-field">
          <span class="field-label">End year <em>(optional)</em></span>
          <input type="number" id="mem-end" min="1900" max="2100" placeholder="1974" inputmode="numeric">
        </label>
      </fieldset>
      <span class="field-hint">Only the memory itself is required. A year (or span) places it on the decade timeline; leave it blank if you're unsure.</span>

      <label class="field">
        <span class="field-label">The memory</span>
        <textarea id="mem-text" rows="8" placeholder="Tell it whole — talk or type. Keep the color and the detail."></textarea>
      </label>
      <button type="button" class="photo-add mic-btn" id="mem-mic" hidden><span>🎤 Dictate</span></button>

      <button type="submit" class="save-btn" id="mem-save" disabled>Save memory</button>
      <p class="write-status" id="mem-status"></p>
      <p class="nav-hint">Saved memories appear in the <strong>Journal</strong>, grouped by category.</p>
    </form>
  `;

  const catEl = root.querySelector("#mem-category");
  const catChips = root.querySelector("#mem-category-chips");
  const subjectEl = root.querySelector("#mem-subject");
  const subChips = root.querySelector("#mem-subject-chips");
  const startEl = root.querySelector("#mem-start");
  const endEl = root.querySelector("#mem-end");
  const textEl = root.querySelector("#mem-text");
  const micBtn = root.querySelector("#mem-mic");
  const saveBtn = root.querySelector("#mem-save");
  const status = root.querySelector("#mem-status");

  let allMems = [];
  let lastSaved = null;
  let editingId = null;   // set when editing an existing memory
  let editingOrig = null;
  status.addEventListener("click", (e) => {
    if (e.target.closest(".mem-goto") && lastSaved) onOpenMemory?.(lastSaved);
  });
  const uniq = (vals) => [...new Set(vals.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const chipsHtml = (vals, current) => vals.map((v) =>
    `<button type="button" class="chip${v.toLowerCase() === current.toLowerCase() ? " chip-on" : ""}" data-val="${escapeHtml(v)}">${escapeHtml(v)}</button>`).join("");
  function renderSubjects() {
    const cat = catEl.value.trim().toLowerCase();
    const subs = uniq(allMems.filter((m) => !cat || (m.category || "").toLowerCase() === cat).map((m) => m.subject));
    subChips.innerHTML = chipsHtml(subs, subjectEl.value.trim());
  }
  function renderCategories() {
    catChips.innerHTML = chipsHtml(uniq(allMems.map((m) => m.category)), catEl.value.trim());
  }
  async function loadLists() {
    allMems = await getAllMemories();
    renderCategories();
    renderSubjects();
  }
  loadLists();
  catEl.addEventListener("input", () => { renderCategories(); renderSubjects(); }); // subjects follow the category
  subjectEl.addEventListener("input", renderSubjects);
  catChips.addEventListener("click", (e) => {
    const b = e.target.closest(".chip"); if (!b) return;
    catEl.value = b.dataset.val; renderCategories(); renderSubjects();
  });
  subChips.addEventListener("click", (e) => {
    const b = e.target.closest(".chip"); if (!b) return;
    subjectEl.value = b.dataset.val; renderSubjects();
  });

  const canSave = () => !!textEl.value.trim(); // only the memory text is required
  const refreshSave = () => { saveBtn.disabled = !canSave(); };
  textEl.addEventListener("input", refreshSave);

  setupDictation(micBtn, textEl, status, refreshSave);

  root.querySelector("#mem-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!canSave()) return;
    const startYear = startEl.value.trim() ? parseInt(startEl.value, 10) : null;
    const endYearRaw = endEl.value.trim() ? parseInt(endEl.value, 10) : null;
    const endYear = startYear != null && endYearRaw && endYearRaw !== startYear ? endYearRaw : null;
    const category = catEl.value.trim();
    const subject = subjectEl.value.trim();
    const text = textEl.value.trim();
    const label = startYear == null
      ? "sometime"
      : (endYear ? `${Math.min(startYear, endYear)}–${Math.max(startYear, endYear)}` : String(startYear));
    // needsSummary tells the Journal's background pass to (re)generate prose + outline.
    // Editing keeps the same id + createdAt and shows the old summary until the new one lands.
    const mem = { id: editingId || uid(), category, subject, startYear, endYear, label, text, needsSummary: true, createdAt: editingOrig?.createdAt || Date.now(), updatedAt: Date.now() };
    if (editingOrig?.prose) mem.prose = editingOrig.prose;
    if (editingOrig?.outline) mem.outline = editingOrig.outline;
    const wasEditing = !!editingId;

    saveBtn.disabled = true;
    try {
      await putMemory(mem);
      lastSaved = mem;
      editingId = null; editingOrig = null;
      saveBtn.textContent = "Save memory";
      const where = subject ? `${escapeHtml(subject)}` : (category ? escapeHtml(category) : label);
      status.innerHTML = `${wasEditing ? "Updated" : "Saved"}${subject ? ` — ${escapeHtml(subject)}` : ""}${category ? ` (${escapeHtml(category)})` : ""} · ${label}. `
        + `<button type="button" class="mem-goto" id="mem-see">See “${where}” in the Journal ›</button>`;
      status.className = "write-status ok";
      // Keep category + subject for rapid entry; clear the year(s) and text.
      textEl.value = ""; startEl.value = ""; endEl.value = "";
      refreshSave();
      loadLists();
      onChanged?.(); // the Journal's background pass will write the summary
    } catch (err) {
      status.textContent = `Couldn't save: ${err.message}`;
      status.className = "write-status error";
      refreshSave();
    }
  });

  // Load an existing memory into the form for editing (called from the Journal's ✎ button).
  function editMemory(mem) {
    editingId = mem.id;
    editingOrig = mem;
    catEl.value = mem.category || "";
    subjectEl.value = mem.subject || "";
    renderCategories();
    renderSubjects();
    startEl.value = mem.startYear ?? "";
    endEl.value = mem.endYear ?? "";
    textEl.value = mem.text || "";
    saveBtn.textContent = "Update memory";
    status.textContent = `Editing “${mem.subject || mem.category || mem.label || "memory"}” — change anything, then Update.`;
    status.className = "write-status";
    refreshSave();
    textEl.focus();
  }

  return { refresh: () => loadLists(), editMemory };
}

