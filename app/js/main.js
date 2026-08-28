import { initRecord } from "./record.js";
import { initCalendar, initGraphView } from "./calendar.js";
import { initSettings } from "./settings.js";
import { renderJournalsSection, wireJournalsSection } from "./samples.js";
import { initPlaces } from "./places.js";
import { purgeRaw } from "./db.js";
import { jkey, isSampleJournal } from "./journal.js";

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
const livesView = document.getElementById("lives-view");
const placesView = document.getElementById("places-view");
const modeBtns = [...document.querySelectorAll(".mode-btn")];

// The "Lives" tab: your own journal + the sample-lives gallery (switching journals reloads).
function renderLives() {
  livesView.innerHTML = renderJournalsSection();
  wireJournalsSection(livesView);
}
const places = initPlaces(placesView); // map of a life; opened lazily (loads Leaflet on first open)

// Open a memory's page in the Journal (after saving/editing it in Write).
function openMemoryInJournal(mem) {
  modeBtns.forEach((b) => b.classList.toggle("active", b.dataset.mode === "browse"));
  writeView.hidden = true; settingsView.hidden = true; graphView.hidden = true; livesView.hidden = true; placesView.hidden = true;
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
  livesView.hidden = mode !== "lives";
  placesView.hidden = mode !== "places";
  if (mode !== "graph") graph.close(); // stop live graph updates when leaving the tab
  if (mode !== "places") places.close(); // tear down the map when leaving
  if (mode === "browse") calendar.reload(arg, zoom);
  else if (mode === "graph") graph.open();
  else if (mode === "settings") settings.refresh();
  else if (mode === "lives") renderLives();
  else if (mode === "places") places.open();
  else recorder.refresh(arg); // arg = date (day) or memory object to edit
}

modeBtns.forEach((btn) => btn.addEventListener("click", () => setMode(btn.dataset.mode)));

const recorder = initRecord(writeView, {
  onSaved: (date) => setMode("browse", date, "day"), // a dated entry → its own day page
  onSavedMemory: (mem) => openMemoryInJournal(mem),   // a memory → its category/subject page
  onDeleted: (date) => setMode("browse", date, "week"), // day is gone → land on its week
  onDeletedMemory: (mem) => openMemoryInJournal(mem),   // memory gone → its subject/category list
});
const graph = initGraphView(graphView, {
  // "Open ›" in the graph's node preview → jump to that node's page in the Journal.
  onOpen: (nav) => {
    modeBtns.forEach((b) => b.classList.toggle("active", b.dataset.mode === "browse"));
    writeView.hidden = true; settingsView.hidden = true; graphView.hidden = true; livesView.hidden = true; placesView.hidden = true;
    browseView.hidden = false;
    graph.close();
    calendar.showNode(nav);
  },
});

const settings = initSettings(settingsView, {
  onImported: (date) => setMode("browse", date), // jump to the Journal after an import
});

// A sample life is read-only: open it in the Journal at the whole-life root (never Write), and
// the body class hides the write/edit/delete affordances (see styles.css).
if (isSampleJournal()) {
  document.body.classList.add("sample-journal");
  setMode("browse", undefined, "life");
} else {
  setMode("write"); // your own journal opens on Today
}
