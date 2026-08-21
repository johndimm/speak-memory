import { initRecord } from "./record.js";
import { initCalendar, initGraphView } from "./calendar.js";
import { initSettings } from "./settings.js";
import { purgeRaw } from "./db.js";
import { jkey } from "./journal.js";

// Keep raw text for the most recent entries only; drop older raw (summaries are kept).
purgeRaw().catch(() => {});

// Editable journal title, remembered on this device — per journal (a sample life has its own).
const TITLE_KEY = jkey("journal-title");
const DEFAULT_TITLE = "Speak, Memory";
const titleEl = document.getElementById("app-title");
const titleEditBtn = document.getElementById("title-edit");

function applyTitle(t) {
  const name = (t && t.trim()) || DEFAULT_TITLE;
  titleEl.textContent = name;
  document.title = name;
}
applyTitle(localStorage.getItem(TITLE_KEY));

titleEditBtn.addEventListener("click", () => {
  titleEl.contentEditable = "true";
  titleEl.classList.add("editing");
  titleEl.focus();
  const range = document.createRange();
  range.selectNodeContents(titleEl);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
});
titleEl.addEventListener("blur", () => {
  titleEl.contentEditable = "false";
  titleEl.classList.remove("editing");
  const name = titleEl.textContent.trim() || DEFAULT_TITLE;
  localStorage.setItem(TITLE_KEY, name);
  applyTitle(name);
});
titleEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); titleEl.blur(); }
  else if (e.key === "Escape") { e.preventDefault(); applyTitle(localStorage.getItem(TITLE_KEY)); titleEl.blur(); }
});

const writeView = document.getElementById("write-view");
const browseView = document.getElementById("browse-view");
const settingsView = document.getElementById("settings-view");
const graphView = document.getElementById("graph-view");
const modeBtns = [...document.querySelectorAll(".mode-btn")];

// Open a memory's page in the Journal (after saving/editing it in Write).
function openMemoryInJournal(mem) {
  modeBtns.forEach((b) => b.classList.toggle("active", b.dataset.mode === "browse"));
  writeView.hidden = true; settingsView.hidden = true; graphView.hidden = true;
  browseView.hidden = false;
  graph.close();
  calendar.showMemory(mem);
}

const calendar = initCalendar({
  root: document.getElementById("calendar-root"),
  periodLabel: document.getElementById("period-label"),
  periodBrief: document.getElementById("period-brief"),
  periodSummarize: document.getElementById("period-summarize"),
  periodSummary: document.getElementById("period-summary"),
  periodOutline: document.getElementById("period-outline"),
  periodDelete: document.getElementById("period-delete"),
  periodPrev: document.getElementById("period-prev"),
  periodNext: document.getElementById("period-next"),
  breadcrumb: document.getElementById("breadcrumb"),
  detailPanel: document.getElementById("detail-panel"),
  detailBackdrop: document.getElementById("detail-backdrop"),
  detailDate: document.getElementById("detail-date"),
  detailModes: document.getElementById("detail-modes"),
  detailBadge: document.getElementById("detail-badge"),
  detailBrief: document.getElementById("detail-brief"),
  detailFull: document.getElementById("detail-full"),
  detailPrev: document.getElementById("detail-prev"),
  detailNext: document.getElementById("detail-next"),
  detailActions: document.getElementById("detail-actions"),
  detailNav: document.getElementById("detail-nav"),
  detailEdit: document.getElementById("detail-edit"),
  detailDelete: document.getElementById("detail-delete"),
  closeDetail: document.getElementById("close-detail"),
}, {
  onEdit: (date) => setMode("write", date), // Journal "Edit" opens the day in the Write editor
  onEditMemory: (mem) => setMode("write", mem), // edit a memory in the same Write form
  onAddMemory: (seed) => setMode("write", seed), // "Add another" → Write, pre-filled category/subject
});

function setMode(mode, arg, zoom) {
  modeBtns.forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  writeView.hidden = mode !== "write";
  browseView.hidden = mode !== "browse";
  settingsView.hidden = mode !== "settings";
  graphView.hidden = mode !== "graph";
  if (mode !== "graph") graph.close(); // stop live graph updates when leaving the tab
  if (mode === "browse") calendar.reload(arg, zoom);
  else if (mode === "graph") graph.open();
  else if (mode === "settings") settings.refresh();
  else recorder.refresh(arg); // arg = date (day) or memory object to edit
}

modeBtns.forEach((btn) => btn.addEventListener("click", () => setMode(btn.dataset.mode)));

const recorder = initRecord(writeView, {
  onSaved: (date) => setMode("browse", date, "day"), // a dated entry → its own day page
  onSavedMemory: (mem) => openMemoryInJournal(mem),   // a memory → its category/subject page
});
const graph = initGraphView(graphView, {
  // "Open ›" in the graph's node preview → jump to that node's page in the Journal.
  onOpen: (nav) => {
    modeBtns.forEach((b) => b.classList.toggle("active", b.dataset.mode === "browse"));
    writeView.hidden = true; settingsView.hidden = true; graphView.hidden = true;
    browseView.hidden = false;
    graph.close();
    calendar.showNode(nav);
  },
});

const settings = initSettings(settingsView, {
  onImported: (date) => setMode("browse", date), // jump to the Journal after an import
});

setMode("write"); // open on Today
