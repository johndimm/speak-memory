import { initRecord } from "./record.js";
import { initCalendar, initGraphView, restoreJournalPos } from "./calendar.js";
import { initSettings } from "./settings.js";
import { renderJournalsSection, wireJournalsSection } from "./samples.js";
import { initPlaces } from "./places.js";
import { initTimeline } from "./timeline.js";
import { initFutures } from "./futures.js";
import { initActivity } from "./activity.js";
import { initEntities } from "./entities.js";
import { purgeRaw, getAllMemories } from "./db.js";
import { jkey, isSampleJournal, activeJournalId } from "./journal.js";
import { triptychHtml, wireTriptych } from "./triptych.js";

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
const timelineView = document.getElementById("timeline-view");
const futuresView = document.getElementById("futures-view");
const activityView = document.getElementById("activity-view");
const peopleView = document.getElementById("people-view");
const modeBtns = [...document.querySelectorAll(".mode-btn")];

// The "Lives" tab: your own journal + the sample-lives gallery (switching journals reloads).
function renderLives() {
  livesView.innerHTML = renderJournalsSection();
  wireJournalsSection(livesView);
}
const places = initPlaces(placesView); // map of a life; opened lazily (loads Leaflet on first open)
const timeline = initTimeline(timelineView, {
  onEditMemory: (mem) => setMode("write", mem),      // "Edit full ›" opens the memory in Write
  onOpenMemory: (mem) => openMemoryInJournal(mem),   // tap a bar → read that state's full page (works read-only)
  onChanged: () => { /* memories changed inline; Journal reloads on its next open */ },
});
const futures = initFutures(futuresView); // imagine the journal continuing; several futures to compare
const activity = initActivity(activityView, { onRetry: () => calendar.prime() }); // live queue; Retry re-runs the pass
const people = initEntities(peopleView, {
  onOpenDay: (date) => setMode("browse", date, "day"),          // a mention → open that day in the Journal
  onOpenMemory: async (id) => { const m = (await getAllMemories()).find((x) => x.id === id); if (m) openMemoryInJournal(m); },
});

// Open a memory's page in the Journal (after saving/editing it in Write).
function openMemoryInJournal(mem) {
  modeBtns.forEach((b) => b.classList.toggle("active", b.dataset.mode === "browse"));
  writeView.hidden = true; settingsView.hidden = true; graphView.hidden = true; livesView.hidden = true; placesView.hidden = true; timelineView.hidden = true;
  futuresView.hidden = true; activityView.hidden = true; peopleView.hidden = true;
  if (activitySubnav) activitySubnav.hidden = true;
  browseView.hidden = false;
  graph.close(); timeline.close();
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
  onOpenEntity: (id) => { setMode("people"); people.openEntity(id); }, // tap a name in a summary → its page
});

const LAST_MODE_KEY = jkey("last-mode");
const activitySubnav = document.getElementById("activity-subnav");
let activitySub = "queue"; // which face of the Activity tab: the queue list, or the node graph
function setMode(mode, arg, zoom) {
  try { if (mode !== "settings") localStorage.setItem(LAST_MODE_KEY, mode); } catch { /* ignore */ } // remember the tab for reload
  modeBtns.forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  // Graph now lives inside the Activity tab as a sub-view (Queue | Graph).
  const showGraph = mode === "activity" && activitySub === "graph";
  const showQueue = mode === "activity" && activitySub === "queue";
  writeView.hidden = mode !== "write";
  browseView.hidden = mode !== "browse";
  settingsView.hidden = mode !== "settings";
  graphView.hidden = !showGraph;
  livesView.hidden = mode !== "lives";
  placesView.hidden = mode !== "places";
  timelineView.hidden = mode !== "timeline";
  futuresView.hidden = mode !== "futures";
  activityView.hidden = !showQueue;
  peopleView.hidden = mode !== "people";
  if (activitySubnav) {
    activitySubnav.hidden = mode !== "activity";
    activitySubnav.querySelectorAll(".subnav-btn").forEach((b) => b.classList.toggle("active", b.dataset.sub === activitySub));
  }
  if (!showGraph) graph.close(); // stop live graph updates when its sub-view isn't showing
  if (mode !== "places") places.close(); // tear down the map when leaving
  if (mode !== "timeline") timeline.close(); // drop the timeline's tooltip/observer when leaving
  if (mode !== "futures") futures.close();
  if (mode !== "activity") activity.close();
  if (mode !== "people") people.close();
  if (mode === "browse") calendar.reload(arg, zoom);
  else if (mode === "settings") settings.refresh();
  else if (mode === "lives") renderLives();
  else if (mode === "places") places.open();
  else if (mode === "timeline") timeline.open();
  else if (mode === "futures") futures.open();
  else if (mode === "activity") { calendar.prime(); if (showGraph) { activity.close(); graph.open(); } else { activity.open(); } } // pass runs; show queue or graph
  else if (mode === "people") people.open();
  else recorder.refresh(arg); // arg = date (day) or memory object to edit
}
if (activitySubnav) activitySubnav.addEventListener("click", (e) => {
  const b = e.target.closest(".subnav-btn");
  if (!b) return;
  activitySub = b.dataset.sub === "graph" ? "graph" : "queue";
  setMode("activity");
});

modeBtns.forEach((btn) => btn.addEventListener("click", () => setMode(btn.dataset.mode)));

// The past·present·future band on the Journal — here none is "active"; all three navigate.
const browseTriptych = document.getElementById("browse-triptych");
if (browseTriptych) {
  browseTriptych.innerHTML = triptychHtml(undefined, "browse");
  // On the Journal the trio BROWSES the journal: Memoir → categories, Diary → recent days,
  // Fortune → the AI-added future section (if this journal has one).
  wireTriptych(browseTriptych, {
    past: () => { setMode("browse"); calendar.goMemoir(); },
    present: () => { setMode("browse"); calendar.goPresent(); },
    future: async () => { setMode("browse"); await calendar.goFuture(); },
  });
}

const recorder = initRecord(writeView, {
  onSaved: (date) => setMode("browse", date, "day"), // a dated entry → its own day page
  onSavedMemory: (mem) => openMemoryInJournal(mem),   // a memory → its category/subject page
  onDeleted: (date) => setMode("browse", date, "week"), // day is gone → land on its week
  onDeletedMemory: (mem) => openMemoryInJournal(mem),   // memory gone → its subject/category list
  onNavigate: (mode) => setMode(mode),                 // past/present/future triptych → jump to a mode
});
const graph = initGraphView(graphView, {
  // "Open ›" in the graph's node preview → jump to that node's page in the Journal.
  onOpen: (nav) => {
    modeBtns.forEach((b) => b.classList.toggle("active", b.dataset.mode === "browse"));
    writeView.hidden = true; settingsView.hidden = true; graphView.hidden = true; livesView.hidden = true; placesView.hidden = true; timelineView.hidden = true;
    futuresView.hidden = true; activityView.hidden = true; peopleView.hidden = true;
    if (activitySubnav) activitySubnav.hidden = true;
    browseView.hidden = false;
    graph.close(); timeline.close();
    calendar.showNode(nav);
  },
});

const settings = initSettings(settingsView, {
  onImported: (date) => setMode("browse", date), // jump to the Journal after an import
  onOpenLives: () => setMode("lives"),           // Lives now lives under Settings (Help), not the top nav
});

// Restore the tab you were last on (per journal) so a reload lands you where you were; for the
// Journal, also restore the exact page (zoom/date/entity) you were viewing.
let savedMode = (() => { try { return localStorage.getItem(LAST_MODE_KEY) || ""; } catch { return ""; } })();
if (savedMode === "graph") { savedMode = "activity"; activitySub = "graph"; } // Graph moved inside Activity
const VALID_MODES = new Set(["write", "browse", "timeline", "futures", "places", "people", "activity"]);

// Stepping into a future via its "▶ Reveal" button asks to auto-play the audio show on load.
try {
  const playReveal = sessionStorage.getItem("play-reveal");
  if (playReveal && playReveal === activeJournalId()) {
    sessionStorage.removeItem("play-reveal");
    import("./audioshow.js").then((m) => m.playFutureShow({})).catch(() => {});
  }
} catch { /* ignore */ }

// A sample life is read-only: it never opens Write; the body class hides write/edit/delete (styles.css).
if (isSampleJournal()) {
  document.body.classList.add("sample-journal");
  // A just-imagined future lands on the Activity page, so you WATCH the summaries run (queued →
  // summarizing → done) instead of staring at a Journal that's silently filling in. Futures sets
  // this flag the first time you step into one; it fires once, then falls back to the Journal.
  const landActivity = sessionStorage.getItem("land-on-graph");
  if (landActivity && landActivity === activeJournalId()) {
    sessionStorage.removeItem("land-on-graph");
    setMode("activity");   // opening Activity primes the pass, then shows the live queue
  } else if (savedMode && savedMode !== "write" && VALID_MODES.has(savedMode)) {
    if (savedMode === "browse") { restoreJournalPos(); setMode("browse"); }
    else setMode(savedMode);
  } else {
    setMode("browse", undefined, "life");
  }
} else if (savedMode && VALID_MODES.has(savedMode)) {
  if (savedMode === "browse") { restoreJournalPos(); setMode("browse"); } // back to the exact Journal page
  else setMode(savedMode);
} else {
  setMode("write"); // first run: your own journal opens on Today
}
