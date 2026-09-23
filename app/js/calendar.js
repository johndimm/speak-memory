// "Journal" view — the year / month / week zoom calendar, sourced from IndexedDB.
// Day summaries are made at capture time. Period summaries (week/month/year/decade/life)
// are generated automatically in the background: each completed period is summarized once
// it ends (a week when the next week starts, etc.), and higher levels update as their
// children change. No manual button — see autoSummarize().

import { getAllEntries, getEntry, putEntry, deleteEntry, getPeriod, getAllPeriods, putPeriod, deletePeriod, getAllMemories, putMemory, getAllEntities, storedToBlob } from "./db.js";
import { escapeHtml, renderFull, renderOutlineTree, renderReps, wireReps, isOutlineText, resolveEntityTokens, setEntityMap } from "./render.js";
import { withMode, availableModes, repsOf } from "./entry.js";
import { renderGraphSvg } from "./graph.js";
import { jkey } from "./journal.js";
import { add as logAdd, set as logSet } from "./llmlog.js";
import { setupDictation } from "./dictation.js";

const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Initial zoom = the "Opens on" setting (Settings › Journal); defaults to the latest week.
const state = { zoom: localStorage.getItem("journal-landing") || "week", focusDate: null, category: null, subject: null, memoryId: null };

// Remember where in the Journal you were, so a reload (or re-opening the tab) lands you back on the
// same page instead of resetting. Saved per journal.
const POS_KEY = jkey("journal-pos");
function savePos() {
  try { localStorage.setItem(POS_KEY, JSON.stringify({ zoom: state.zoom, focusDate: state.focusDate, category: state.category, subject: state.subject, memoryId: state.memoryId })); } catch { /* ignore */ }
}
export function restoreJournalPos() {
  try {
    const p = JSON.parse(localStorage.getItem(POS_KEY) || "null");
    if (p && p.zoom) { Object.assign(state, { focusDate: null, category: null, subject: null, memoryId: null }, p); return true; }
  } catch { /* ignore */ }
  return false;
}
let journal = { days: {}, dateRange: null };
let entityRoster = []; // [{id, canonical, aliases, kind, note}] — full cast (kept in memory)
let entityById = new Map(); // id → roster entry, for scoping a leaf's summary to just its own names
// The entities a specific leaf mentions (from its entityRefs) — a small, bounded set, so the
// summarization prompt never carries the whole (growing) cast.
function rosterFor(refs) {
  return (Array.isArray(refs) ? refs : []).map((id) => entityById.get(id)).filter(Boolean);
}
let objectUrls = [];
let els = {};
let detailIso = null;        // day currently open in the panel
let onEditRequested = null;  // callback → open this day in the Write editor
let onEditMemoryRequested = null; // callback → open this memory in the Write form
let onAddMemoryRequested = null;  // callback → open Write on a NEW memory, pre-filled category/subject
let allMemories = [];        // range-based memories, shown on year pages

function parseDate(iso) {
  return new Date(iso + "T12:00:00");
}
function formatDate(iso, style = "long") {
  return parseDate(iso).toLocaleDateString("en-US", style === "long"
    ? { weekday: "long", month: "long", day: "numeric", year: "numeric" }
    : { month: "short", day: "numeric" });
}
function monthLabel(key) {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}
function sundayWeekStart(iso) {
  const d = parseDate(iso);
  d.setDate(d.getDate() - d.getDay());
  return d.toISOString().slice(0, 10);
}
function weekDates(iso) {
  const start = parseDate(iso);
  start.setDate(start.getDate() - start.getDay());
  return Array.from({ length: 7 }, (_, i) => {
    const x = new Date(start);
    x.setDate(start.getDate() + i);
    return x.toISOString().slice(0, 10);
  });
}
function weekLabel(dates) {
  const [start, end] = [dates[0], dates[dates.length - 1]];
  return start === end ? formatDate(start, "long") : `${formatDate(start, "short")} – ${formatDate(end, "short")}`;
}
function excerpt(text, maxChars) {
  const raw = String(text).replace(/\r/g, "");
  let first;
  if (/^\s*-\s+/m.test(raw)) {
    const line = raw.split("\n").find((l) => /^\s*-\s+/.test(l)) || "";
    first = line.replace(/^\s*-\s+/, "").trim();
  } else {
    first = raw.split("\n\n").find(Boolean) ?? "";
  }
  if (first.length <= maxChars) return first;
  const cut = first.slice(0, maxChars);
  const end = cut.lastIndexOf(" ");
  return (end > 80 ? cut.slice(0, end) : cut).trim() + "…";
}

// Bump when the summary PROMPTS change (e.g. prose -> first person) so every cached
// summary is treated as stale and the background pass regenerates it.
const SUMMARY_VERSION = "5-levels";

function hashBriefs(days) {
  // Fold prompt version + current voice into staleness, so changing either regenerates
  // every summary (prose is voiced/first-person; the outline re-derives harmlessly).
  const style = localStorage.getItem("summary-style") || "";
  const s = SUMMARY_VERSION + "|" + style + "|" + days.map((d) => d.date + "|" + d.brief).join("~");
  let h = 0;
  for (let k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) | 0;
  return String(h);
}

async function load() {
  objectUrls.forEach(URL.revokeObjectURL);
  objectUrls = [];
  allMemories = await getAllMemories();
  // Keep the entity registry in memory: a map (id → canonical) so summary tokens resolve at render,
  // and a roster passed into summarization so new summaries EMIT {{e:id|Name}} tokens.
  try {
    const ents = await getAllEntities();
    setEntityMap(new Map(ents.map((e) => [e.id, e.canonical])));
    entityRoster = ents.map((e) => ({ id: e.id, canonical: e.canonical, aliases: e.aliases || [], kind: e.entityKind || "person", note: e.note || "" }));
    entityById = new Map(entityRoster.map((e) => [e.id, e]));
  } catch { entityRoster = []; entityById = new Map(); }
  const entries = await getAllEntries();
  const days = {};
  for (const e of entries) {
    const images = (e.photos ?? []).map((ph) => {
      const b = storedToBlob(ph);
      const url = URL.createObjectURL(b);
      objectUrls.push(url);
      return { url, video: (b.type || "").startsWith("video/") };
    });
    // Sample lives carry image URLs (Wikimedia Commons) instead of stored blobs.
    if (Array.isArray(e.imageUrls)) for (const u of e.imageUrls) if (u) images.push({ url: u, video: false });
    const mode = e.mode || (e.summarized === false ? "verbatim" : (isOutlineText(e.full || "") ? "outline" : "prose"));
    days[e.date] = {
      brief: e.brief, full: e.full, dayOfWeek: e.dayOfWeek, summarized: e.summarized !== false,
      mode, modes: availableModes(e), reps: repsOf(e), images, levels: e.levels, entityRefs: e.entityRefs || [],
    };
  }
  const dates = Object.keys(days).sort();
  journal = { days, dateRange: dates.length ? { start: dates[0], end: dates[dates.length - 1] } : null };
  // Keep the user where they are across reloads. Only jump to the latest entry / today
  // when there's no focus yet, or the focused YEAR no longer has any content — otherwise
  // deleting a memory (whose year has no journal day) would yank the view to this year.
  const focusYear = state.focusDate ? +state.focusDate.slice(0, 4) : null;
  if (!state.focusDate || !yearsWithContent().includes(focusYear)) {
    state.focusDate = journal.dateRange?.end ?? new Date().toISOString().slice(0, 10);
  }
}

function daysInPeriod() {
  const { zoom, focusDate } = state;
  if (zoom === "life") return Object.keys(journal.days).sort();
  if (zoom === "decade") { const d = bucketStart(focusDate.slice(0, 4)); return Object.keys(journal.days).filter((iso) => bucketStart(+iso.slice(0, 4)) === d).sort(); }
  if (zoom === "week") return weekDates(focusDate).filter((iso) => journal.days[iso]);
  const prefix = zoom === "month" ? focusDate.slice(0, 7) : focusDate.slice(0, 4);
  return Object.keys(journal.days).filter((d) => d.startsWith(prefix)).sort();
}
function periodKey() {
  const { zoom, focusDate } = state;
  if (zoom === "life") return "LIFE";
  if (zoom === "decade") return bucketKey(bucketStart(focusDate.slice(0, 4)));
  if (zoom === "week") return "W" + sundayWeekStart(focusDate);
  if (zoom === "month") return "M" + focusDate.slice(0, 7);
  return "Y" + focusDate.slice(0, 4);
}
function periodTypeLabel() {
  const { zoom, focusDate } = state;
  if (zoom === "life") return { type: "life", label: "A life" };
  if (zoom === "decade") return { type: "decade", label: bucketLabel(bucketStart(focusDate.slice(0, 4))) };
  if (zoom === "week") return { type: "week", label: `Week of ${formatDate(weekDates(focusDate)[0])}` };
  if (zoom === "month") return { type: "month", label: monthLabel(focusDate.slice(0, 7)) };
  return { type: "year", label: focusDate.slice(0, 4) };
}
// ---- Decade buckets: calendar decades (1970s…) OR life decades (childhood, teens, my 20s…) ----
// The "decade" level groups years. Two modes, chosen in Settings:
//   calendar → floor(year/10)*10, labelled "1970s"
//   life     → relative to your birth year: Childhood (0–12), Teenage years (13–19), then My 20s,
//              My 30s… (each a 10-year age span). Needs a birth year; falls back to calendar without.
// A bucket is identified by its START year everywhere; these helpers translate that start into a
// span, a label, and a cache key. Life buckets get their own key namespace ("L…") so toggling
// modes never clobbers the calendar-decade summaries and vice versa.
function yearGrouping() { return localStorage.getItem(jkey("year-grouping")) === "life" ? "life" : "calendar"; }
function birthYear() { const v = Number(localStorage.getItem(jkey("birth-year"))); return Number.isFinite(v) && v > 1000 && v < 2200 ? v : null; }
function lifeDecades() { return yearGrouping() === "life" && birthYear() != null; }
function decadeStart(year) { return Math.floor(Number(year) / 10) * 10; }
function bucketStart(year) {
  year = Number(year);
  if (lifeDecades()) {
    const age = year - birthYear();
    if (age <= 12) return birthYear();          // childhood: birth … age 12
    if (age <= 19) return birthYear() + 13;     // teenage years: 13 … 19
    return birthYear() + Math.floor(age / 10) * 10; // my 20s, 30s, …
  }
  return decadeStart(year);
}
function bucketEnd(start) {
  start = Number(start);
  if (lifeDecades()) {
    const age = start - birthYear();
    if (age <= 0) return birthYear() + 12;      // childhood ends at 12
    if (age === 13) return birthYear() + 19;    // teens end at 19
    return start + 9;                            // age-decades are 10 wide
  }
  return start + 9;
}
function bucketLabel(start) {
  start = Number(start);
  if (lifeDecades()) {
    const age = start - birthYear();
    if (age <= 0) return "Childhood";
    if (age === 13) return "Teenage years";
    return `My ${age}s`;
  }
  return `${start}s`;
}
function bucketKey(start) { return (lifeDecades() ? "L" : "D") + Number(start); }

// The Journal's calendar side is journal entries only; memories live under categories.
function yearsWithContent() {
  return [...new Set(Object.keys(journal.days).map((iso) => +iso.slice(0, 4)))].sort((a, b) => a - b);
}
function periodChildren() {
  const days = daysInPeriod().map((iso) => ({ date: iso, brief: journal.days[iso].brief, full: journal.days[iso].full }));
  // Decades also summarize the memories that touch them (so a memory-only decade still
  // gets a summary — used on the page and to inform Life).
  if (state.zoom === "decade") return days.concat(memoriesInDecade(bucketStart(state.focusDate.slice(0, 4))).map(memChild));
  return days;
}

// Memories are grouped category → subject → memory. A memory becomes a summary "child"
// via its own prose (falling back to the raw text before the write-up lands).
function catOf(m) { return (m.category || "").trim() || "Uncategorized"; }
function subjOf(m) { return (m.subject || "").trim(); }
function memChild(m) { return { date: m.label || String(m.startYear || ""), brief: (m.prose && m.prose.brief) || m.text, full: (m.prose && m.prose.full) || m.text, levels: m.levels }; }
function categoriesWithContent() { return [...new Set(allMemories.map(catOf))].sort((a, b) => a.localeCompare(b)); }
function memoriesInCategory(cat) { return allMemories.filter((m) => catOf(m) === cat).sort((a, b) => (a.startYear ?? Infinity) - (b.startYear ?? Infinity) || (a.createdAt || 0) - (b.createdAt || 0)); }
// Subjects in first-appearance order — memoriesInCategory is sorted by year, so this is chronological.
function subjectsInCategory(cat) { return [...new Set(memoriesInCategory(cat).map(subjOf).filter(Boolean))]; }
function memoriesInSubject(cat, subj) { return memoriesInCategory(cat).filter((m) => subjOf(m) === subj); }
function catKey(cat) { return "CAT:" + cat; }
function subKey(cat, subj) { return "SUB:" + cat + " " + subj; }
// Memories are also browsable by time: a memory covers every decade its span touches.
function memoryDecades() {
  const set = new Set();
  for (const m of allMemories) {
    if (m.startYear == null) continue;
    const end = m.endYear || m.startYear;
    for (let y = m.startYear; y <= end; y++) set.add(bucketStart(y)); // buckets vary in span (life mode)
  }
  return set;
}
function memoriesInDecade(dd) {
  const end = bucketEnd(dd);
  return allMemories.filter((m) => {
    if (m.startYear == null) return false;
    return m.startYear <= end && (m.endYear || m.startYear) >= dd;
  }).sort((a, b) => (a.startYear || 0) - (b.startYear || 0) || (a.createdAt || 0) - (b.createdAt || 0));
}

// Page layout for a period: title → prose summary (here) → elements (the child cards,
// rendered into calendar-root) → outline (in #period-outline, below the cards).
// The page body (name, ladder, elements, outline, verbatim) is built by the shared node
// scaffold in calendar-root. The header only clears its old fields and keeps the delete
// button for journal periods that contain days (breadcrumb + prev/next live elsewhere).
function renderPeriodHeader() {
  if (els.periodSummary) els.periodSummary.innerHTML = "";
  if (els.periodOutline) { els.periodOutline.innerHTML = ""; els.periodOutline.hidden = true; }
  if (els.periodLabel) els.periodLabel.textContent = "";
  if (els.periodBrief) els.periodBrief.textContent = "";
  els.periodSummarize.hidden = true;
  const showDelete = ["decade", "year", "month", "week"].includes(state.zoom) && daysInPeriod().length;
  els.periodDelete.hidden = !showDelete;
  if (showDelete) els.periodDelete.textContent = `Delete this ${periodTypeLabel().type}`;
}

async function deletePeriodEntries() {
  const dates = daysInPeriod();
  if (!dates.length) return;
  const { type, label } = periodTypeLabel();
  const n = dates.length;
  if (!confirm(`Delete all ${n} ${n === 1 ? "entry" : "entries"} in ${label}? This can't be undone.`)) return;
  for (const iso of dates) await deleteEntry(iso);
  await deletePeriod(periodKey());
  closeDetail();
  await reloadAndRender();
}

function periodKeysWithEntries(zoom) {
  if (zoom === "year") return yearsWithContent().map(String);
  if (zoom === "decade") return [...new Set([...yearsWithContent().map((y) => bucketStart(y)), ...memoryDecades()])].sort((a, b) => a - b).map(String);
  const set = new Set();
  for (const iso of Object.keys(journal.days)) {
    if (zoom === "week") set.add(sundayWeekStart(iso));
    else set.add(iso.slice(0, 7)); // month
  }
  return [...set].sort();
}
function currentPeriodId(zoom, focusDate) {
  if (zoom === "week") return sundayWeekStart(focusDate);
  if (zoom === "month") return focusDate.slice(0, 7);
  if (zoom === "decade") return String(bucketStart(focusDate.slice(0, 4)));
  return focusDate.slice(0, 4);
}
function firstEntryDateIn(zoom, periodId) {
  if (zoom === "decade") { const d = +periodId; return Object.keys(journal.days).filter((iso) => bucketStart(+iso.slice(0, 4)) === d).sort()[0] ?? `${d}-01-01`; }
  if (zoom === "year") return Object.keys(journal.days).filter((iso) => iso.startsWith(periodId)).sort()[0] ?? `${periodId}-01-01`;
  const dates = zoom === "week"
    ? weekDates(periodId).filter((iso) => journal.days[iso])
    : Object.keys(journal.days).filter((d) => d.startsWith(periodId)).sort();
  return dates[0];
}
function updatePeriodNav() {
  if (!["decade", "year", "month", "week", "day"].includes(state.zoom)) {
    els.periodPrev.hidden = true; els.periodNext.hidden = true; return;
  }
  if (state.zoom === "day") {
    const dates = Object.keys(journal.days).sort();
    const i = dates.indexOf(state.focusDate);
    const prev = i > 0 ? dates[i - 1] : null;
    const next = i >= 0 && i < dates.length - 1 ? dates[i + 1] : null;
    els.periodPrev.hidden = !prev; els.periodNext.hidden = !next;
    els.periodPrev.textContent = prev ? `← ${formatDate(prev, "short")}` : "";
    els.periodNext.textContent = next ? `${formatDate(next, "short")} →` : "";
    els.periodPrev.dataset.target = prev || "";
    els.periodNext.dataset.target = next || "";
    return;
  }
  const zoom = state.zoom;
  const noun = zoom === "week" ? "week" : zoom === "month" ? "month" : zoom === "decade" ? "decade" : "year";
  const keys = periodKeysWithEntries(zoom);
  const cur = currentPeriodId(zoom, state.focusDate);
  const idx = keys.indexOf(cur);
  const prevKey = idx > 0 ? keys[idx - 1] : (idx === -1 ? keys.filter((k) => k < cur).pop() : null);
  const nextKey = idx >= 0 && idx < keys.length - 1 ? keys[idx + 1] : (idx === -1 ? keys.find((k) => k > cur) : null);

  els.periodPrev.hidden = !prevKey;
  els.periodNext.hidden = !nextKey;
  els.periodPrev.textContent = `← Previous ${noun}`;
  els.periodNext.textContent = `Next ${noun} →`;
  els.periodPrev.dataset.target = prevKey ? firstEntryDateIn(zoom, prevKey) : "";
  els.periodNext.dataset.target = nextKey ? firstEntryDateIn(zoom, nextKey) : "";
}

function firstImageIn(dates) {
  for (const iso of dates) {
    const img = (journal.days[iso]?.images || []).find((im) => !im.video);
    if (img) return img.url;
  }
  return null;
}


async function renderYear() {
  const year = state.focusDate.slice(0, 4);
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`)
    .filter((mk) => Object.keys(journal.days).some((d) => d.startsWith(mk)));
  if (!months.length) { els.root.innerHTML = `<p class="nav-hint">Nothing recorded in ${year} yet.</p>`; return; }
  const yr = await getPeriod("Y" + year);
  const monthRecs = await Promise.all(months.map((mk) => getPeriod("M" + mk)));
  const links = nodeLinksHtml(months.map((mk, i) => ({ label: monthLabel(mk), sentence: levelsOf(monthRecs[i]).sentence, attrs: { month: mk }, thumb: repImage(Object.keys(journal.days).filter((x) => x.startsWith(mk)), memsCovering(+year), +year) })));
  els.root.innerHTML = nodeScaffold({ name: year, levels: levelsOf(yr), elementsHtml: `<p class="nav-hint">Months</p>${links}` });
}

async function renderMonth() {
  const monthKey = state.focusDate.slice(0, 7);
  const byWeek = new Map();
  for (const iso of Object.keys(journal.days).filter((d) => d.startsWith(monthKey)).sort()) {
    const key = sundayWeekStart(iso);
    if (!byWeek.has(key)) byWeek.set(key, []);
    byWeek.get(key).push(iso);
  }
  const weeks = [...byWeek.entries()].map(([key, dates]) => ({ key, dates })).sort((a, b) => a.key.localeCompare(b.key));
  if (!weeks.length) { els.root.innerHTML = `<p class="nav-hint">No entries this month.</p>`; return; }
  const mo = await getPeriod("M" + monthKey);
  const weekRecs = await Promise.all(weeks.map((w) => getPeriod("W" + w.key)));
  const yr = +monthKey.slice(0, 4);
  const links = nodeLinksHtml(weeks.map((w, i) => ({ label: `Week of ${formatDate(w.dates[0], "short")}`, sentence: levelsOf(weekRecs[i]).sentence, attrs: { week: w.dates[0] }, thumb: repImage(w.dates, memsCovering(yr), yr) })));
  els.root.innerHTML = nodeScaffold({ name: monthLabel(monthKey), levels: levelsOf(mo), elementsHtml: `<p class="nav-hint">Weeks</p>${links}` });
}

async function renderWeek() {
  const entryDays = weekDates(state.focusDate).filter((iso) => journal.days[iso]);
  if (!entryDays.length) { els.root.innerHTML = `<p class="nav-hint">No entries this week.</p>`; return; }
  const wk = await getPeriod("W" + sundayWeekStart(state.focusDate));
  const links = nodeLinksHtml(entryDays.map((iso) => {
    const day = journal.days[iso];
    return { label: `${day.dayOfWeek} · ${formatDate(iso, "short")}`, sentence: (day.levels && day.levels.sentence) || day.brief, attrs: { day: iso }, thumb: imgFromDay(iso) };
  }));
  els.root.innerHTML = nodeScaffold({ name: `Week of ${formatDate(entryDays[0], "short")}`, levels: levelsOf(wk), elementsHtml: `<p class="nav-hint">Days</p>${links}` });
}

// A single day — a leaf page (its transcript is the verbatim).
function renderDay() {
  const iso = state.focusDate;
  const day = journal.days[iso];
  if (!day) { els.root.innerHTML = `<p class="nav-hint">No entry for this day.</p>`; return; }
  const imagesHtml = day.images?.length
    ? `<div class="detail-images">${day.images.map((img) => img.video
        ? `<figure><video src="${img.url}" controls playsinline preload="metadata"></video></figure>`
        : `<figure><img src="${img.url}" alt="Journal photo" loading="lazy"></figure>`).join("")}</div>`
    : "";
  const actions = `<div class="day-actions">
    <button type="button" class="detail-nav-btn" id="day-edit">✎ Edit</button>
  </div>`;
  const verbatim = (day.reps && day.reps.verbatim) || "";
  setLazyDay(day, iso);
  els.root.innerHTML = actions + nodeScaffold({ name: formatDate(iso), levels: levelsOf(day), images: imagesHtml, isLeaf: true, verbatim, correction: day.correction || "" });
  els.root.querySelector("#day-edit").addEventListener("click", () => onEditRequested?.(iso));
  if (lazyLeaf) generateLeafDetail(); // build the leading outline right away, not on a click
}

function openDetail(iso) {
  const day = journal.days[iso];
  if (!day) return;
  detailIso = iso;
  els.detailDate.textContent = formatDate(iso);

  els.detailModes.hidden = true;
  els.detailBadge.hidden = true;
  els.detailBrief.textContent = resolveEntityTokens(day.brief);

  const imagesHtml = day.images?.length
    ? `<div class="detail-images">${day.images.map((img) => img.video
        ? `<figure><video src="${img.url}" controls playsinline preload="metadata"></video></figure>`
        : `<figure><img src="${img.url}" alt="Journal photo" loading="lazy"></figure>`).join("")}</div>`
    : "";

  els.detailFull.innerHTML = renderReps(day.reps, imagesHtml);

  const dates = Object.keys(journal.days).sort();
  const idx = dates.indexOf(iso);
  const prev = idx > 0 ? dates[idx - 1] : null;
  const next = idx >= 0 && idx < dates.length - 1 ? dates[idx + 1] : null;
  els.detailPrev.hidden = !prev;
  els.detailNext.hidden = !next;
  els.detailPrev.dataset.target = prev || "";
  els.detailNext.dataset.target = next || "";
  els.detailPrev.textContent = prev ? `← ${formatDate(prev, "short")}` : "";
  els.detailNext.textContent = next ? `${formatDate(next, "short")} →` : "";

  els.detailPanel.scrollTop = 0;
  els.detailPanel.hidden = false;
  els.detailBackdrop.hidden = false;
}
async function switchDetailMode(mode) {
  if (!detailIso) return;
  const iso = detailIso;
  const entry = await getEntry(iso);
  if (!entry) return;
  await putEntry(withMode(entry, mode));
  await reloadAndRender();
  openDetail(iso);
}

function closeDetail() {
  detailIso = null;
  els.detailPanel.hidden = true;
  els.detailBackdrop.hidden = true;
}

// ---- Outline expansion: remember which outline nodes are open, per node page ---------------
// The outline renders collapsed to its top level; as the reader drills in, we remember which
// nodes they opened (keyed by the page and each node's stable path) and restore it next time.
const OLX_KEY = jkey("outline-expansion");
let olSaveTimer = null;
function loadOlx() { try { return JSON.parse(localStorage.getItem(OLX_KEY) || "{}"); } catch { return {}; } }
function saveOlx(o) { try { localStorage.setItem(OLX_KEY, JSON.stringify(o)); } catch { /* full/blocked */ } }
function outlinePageKey() {
  return [state.zoom, state.focusDate || "", state.category || "", state.subject || "", state.memoryId || ""].join("|");
}
function restoreOutline() {
  const open = new Set(loadOlx()[outlinePageKey()] || []);
  els.root.querySelectorAll(".ol-node[data-ol-key]").forEach((d) => { d.open = open.has(d.dataset.olKey); });
}
function saveOutlineState() {
  const open = [...els.root.querySelectorAll(".ol-node[data-ol-key]")].filter((x) => x.open).map((x) => x.dataset.olKey);
  const all = loadOlx();
  all[outlinePageKey()] = open;
  const keys = Object.keys(all);
  if (keys.length > 150) delete all[keys[0]]; // keep the map bounded
  saveOlx(all);
}
function scheduleSaveOutline() { clearTimeout(olSaveTimer); olSaveTimer = setTimeout(saveOutlineState, 150); }

// ---- Single-child collapse ---------------------------------------------------------------
// Drilling into a period that has exactly one child skips straight through to the first branch
// (2+ children) or the leaf day, so you never click through a chain of levels that all show the
// same copied-up summary.
function timeChildren(zoom, focus) {
  const days = Object.keys(journal.days);
  if (zoom === "decade") {
    const dd = bucketStart(+String(focus).slice(0, 4));
    const years = [...new Set(days.map((d) => +d.slice(0, 4)).filter((y) => bucketStart(y) === dd))].sort((a, b) => a - b);
    return years.map((y) => ({ zoom: "year", focusDate: firstEntryDateIn("year", String(y)) }));
  }
  if (zoom === "year") {
    const y = String(focus).slice(0, 4);
    const months = [...new Set(days.filter((d) => d.startsWith(y)).map((d) => d.slice(0, 7)))].sort();
    return months.map((mk) => ({ zoom: "month", focusDate: firstEntryDateIn("month", mk) }));
  }
  if (zoom === "month") {
    const mk = String(focus).slice(0, 7);
    const starts = [...new Set(days.filter((d) => d.startsWith(mk)).map(sundayWeekStart))].sort();
    return starts.map((ws) => {
      const firstDay = days.filter((d) => d.startsWith(mk) && sundayWeekStart(d) === ws).sort()[0] || ws;
      return { zoom: "week", focusDate: firstDay };
    });
  }
  if (zoom === "week") {
    return weekDates(focus).filter((iso) => journal.days[iso]).map((iso) => ({ zoom: "day", focusDate: iso }));
  }
  return []; // day is a leaf
}
function descend(zoom, focusDate) {
  for (let guard = 0; guard < 12; guard++) {
    const kids = timeChildren(zoom, focusDate);
    if (kids.length !== 1) break;
    ({ zoom, focusDate } = kids[0]);
    if (zoom === "day") break;
  }
  return { zoom, focusDate };
}
// Drill DOWN into a time node, collapsing any single-child chain first.
function navDown(zoom, focusDate) {
  const t = descend(zoom, focusDate);
  state.zoom = t.zoom;
  state.focusDate = t.focusDate;
  render();
}

// True while the reader is typing in an editable field on the node page — so a background
// re-render (from the summarization pass) can't wipe the box out from under them.
function isEditingNodeField() {
  const a = document.activeElement;
  return a && els.root.contains(a) && a.matches(".node-comment-input, .verbatim-input, .correct-input");
}
let pendingRender = false;

// Image URLs already shown on the current page — reset each render so no picture repeats within
// one page (e.g. several memories that fall back to the same portrait).
let shownImages = new Set();
function render() {
  // Don't rebuild the page while the reader is mid-edit — defer until they leave the field.
  if (isEditingNodeField()) { pendingRender = true; return; }
  pendingRender = false;
  shownImages = new Set();
  savePos(); // remember this page so a reload returns here
  renderBreadcrumb();
  updatePeriodNav();
  renderPeriodHeader();
  if (state.zoom === "life") renderLife();
  else if (state.zoom === "category") renderCategory();
  else if (state.zoom === "subject") renderSubject();
  else if (state.zoom === "memory") renderMemory();
  else if (state.zoom === "decade") renderDecade();
  else if (state.zoom === "year") renderYear();
  else if (state.zoom === "month") renderMonth();
  else if (state.zoom === "day") renderDay();
  else renderWeek();
}

// Breadcrumb = the path from Life down to where you are, e.g. Life › 1950s › 1954 › March.
// Every ancestor is a button that jumps UP to that level (focusDate stays put — it belongs
// to all of its ancestors); the last crumb is the current level. Drilling DOWN happens by
// clicking the child cards below.
function breadcrumbCrumbs() {
  const { zoom, focusDate, category, subject } = state;
  // Memory branch: Life › category › subject › memory.
  if (zoom === "category" || zoom === "subject" || zoom === "memory") {
    const crumbs = [{ zoom: "life", label: "Life" }, { zoom: "category", label: category }];
    if (subject && (zoom === "subject" || zoom === "memory")) crumbs.push({ zoom: "subject", label: subject });
    if (zoom === "memory") {
      const m = allMemories.find((x) => x.id === state.memoryId);
      crumbs.push({ zoom: "memory", label: (m && m.label) || "memory" });
    }
    return crumbs;
  }
  const y = focusDate.slice(0, 4);
  const idx = ["life", "decade", "year", "month", "week", "day"].indexOf(zoom);
  const crumbs = [{ zoom: "life", label: "Life" }];
  if (idx >= 1) crumbs.push({ zoom: "decade", label: bucketLabel(bucketStart(y)) });
  if (idx >= 2) crumbs.push({ zoom: "year", label: y });
  if (idx >= 3) crumbs.push({ zoom: "month", label: new Date(+y, +focusDate.slice(5, 7) - 1, 1).toLocaleDateString("en-US", { month: "long" }) });
  if (idx >= 4) crumbs.push({ zoom: "week", label: weekLabel(weekDates(focusDate)) });
  if (idx >= 5) crumbs.push({ zoom: "day", label: formatDate(focusDate, "short") });
  return crumbs;
}

function renderBreadcrumb() {
  if (!els.breadcrumb) return;
  const crumbs = breadcrumbCrumbs();
  if (crumbs.length <= 1) { els.breadcrumb.innerHTML = ""; return; } // no breadcrumb at the root (Life)
  els.breadcrumb.innerHTML = crumbs.map((c, i) => {
    // The "Life" root gets a home-anchor style so it reads as the way back to everything.
    const root = c.zoom === "life" ? " crumb-root" : "";
    return (i === crumbs.length - 1)
      ? `<span class="crumb crumb-current${root}">${escapeHtml(c.label)}</span>`
      : `<button type="button" class="crumb${root}" data-zoom="${c.zoom}">${escapeHtml(c.label)}</button>`;
  }).join(`<span class="crumb-sep" aria-hidden="true">›</span>`);
}

// One timeline row: a colored bar over the years the memory covers, with its label placed BESIDE
// the bar (right of it, or left when the bar sits near the far edge) so a thin single-year bar
// never clips the text. The whole row is clickable → jumps to the memory.
function mtlTrack(m, left, width, trackStyle = "") {
  const label = m.subject || m.category || m.label || "";
  const title = escapeHtml((m.label || label) + (m.category ? " · " + m.category : ""));
  const barEnd = left + width;
  const labelPos = barEnd <= 68 ? `left:calc(${barEnd}% + 6px)` : `right:calc(${100 - left}% + 6px);text-align:right`;
  return `<div class="mtl-track"${trackStyle ? ` style="${trackStyle}"` : ""}>`
    + `<button type="button" class="mtl-bar" data-mem-id="${m.id}" style="left:${left}%;width:${width}%" title="${title}"></button>`
    + `<span class="mtl-bar-label" data-mem-id="${m.id}" style="${labelPos}">${escapeHtml(label)}</span></div>`;
}

// A timeline band for a decade: each memory drawn as a bar spanning the years it covers
// (clamped to the decade). Clicking a bar scrolls to that memory's card below.
function memoryTimelineHtml(dd, mems) {
  if (!mems.length) return "";
  const end = bucketEnd(dd);                 // life buckets vary in width (childhood 13, teens 7…)
  const span = end - dd + 1;
  const years = Array.from({ length: span }, (_, i) => dd + i);
  const axis = `<div class="mtl-axis">${years.map((y) => `<span class="mtl-year">${String(y).slice(2)}</span>`).join("")}</div>`;
  const tracks = mems.map((m) => {
    const s = Math.max(m.startYear, dd);
    const e = Math.min(m.endYear || m.startYear, end);
    return mtlTrack(m, ((s - dd) / span) * 100, ((e - s + 1) / span) * 100);
  }).join("");
  return `<div class="mtl"><div class="mtl-grid">${axis}${tracks}</div></div>`;
}

// A timeline spanning the full year range of a set of memories (e.g., a whole category), each
// memory a bar over the years it covers. Year ticks thin out as the span grows. Clicking a bar
// jumps to that memory.
function memoryTimelineSpan(mems) {
  const withYear = mems.filter((m) => m.startYear != null);
  if (!withYear.length) return "";
  const minY = Math.min(...withYear.map((m) => m.startYear));
  const maxY = Math.max(...withYear.map((m) => m.endYear || m.startYear));
  const span = Math.max(1, maxY - minY + 1);
  // A few nicely-rounded, evenly-spaced ticks (≤6) — no forced endpoints, so labels never collide.
  const step = [1, 2, 5, 10, 20, 25, 50, 100].find((s) => span / s <= 6) || 100;
  const ticks = [];
  for (let y = Math.ceil(minY / step) * step; y <= maxY; y += step) ticks.push(y);
  if (!ticks.length) ticks.push(minY);
  const axis = ticks.map((y) => {
    const pct = ((y - minY) / span) * 100;
    return `<span class="mtl-tick" style="${pct >= 99 ? "right:0" : `left:${pct}%`}">${y}</span>`;
  }).join("");
  const gridPct = (step / span) * 100;
  const tracks = [...withYear].sort((a, b) => a.startYear - b.startYear || (a.endYear || a.startYear) - (b.endYear || b.startYear)).map((m) => {
    const s = m.startYear, e = m.endYear || m.startYear;
    return mtlTrack(m, ((s - minY) / span) * 100, ((e - s + 1) / span) * 100, `background-size:${gridPct}% 100%`);
  }).join("");
  return `<div class="mtl"><div class="mtl-grid"><div class="mtl-axis-span">${axis}</div>${tracks}</div></div>`;
}

async function renderDecade() {
  const d = bucketStart(state.focusDate.slice(0, 4));
  const label = bucketLabel(d);
  const years = yearsWithContent().filter((y) => bucketStart(y) === d);
  const mems = memoriesInDecade(d);
  if (!years.length && !mems.length) { els.root.innerHTML = `<p class="nav-hint">Nothing recorded in ${label} yet.</p>`; return; }

  const dec = await getPeriod(bucketKey(d));
  const yearRecs = await Promise.all(years.map((y) => getPeriod("Y" + y)));
  const yearLinks = nodeLinksHtml(years.map((y, i) => ({ label: String(y), sentence: levelsOf(yearRecs[i]).sentence, attrs: { year: y }, thumb: repImage(Object.keys(journal.days).filter((x) => +x.slice(0, 4) === y), memsCovering(y), y) })));
  const memLinks = nodeLinksHtml(mems.map((m) => ({ label: m.label || "", sentence: levelsOf(m).sentence, attrs: { mem: m.id }, thumb: memImageUrls(m)[0] })));
  els.root.innerHTML = nodeScaffold({
    name: label, levels: levelsOf(dec),
    elementsHtml: (years.length ? `<p class="nav-hint">Years</p>${yearLinks}` : "")
      + (mems.length ? `<p class="nav-hint">Memories across ${escapeHtml(label)}</p>${memoryTimelineHtml(d, mems)}${memLinks}` : ""),
  });
}

// ---- Unified node page ----------------------------------------------------------------
// Every page: name → word → phrase → sentence → paragraph (+complete) → elements → outline
// → verbatim (leaf only). Distilled first; the long prose and transcript stay folded away.
function levelsOf(rec) {
  if (!rec) return {};
  if (rec.levels) return rec.levels;
  return { word: rec.word || "", phrase: rec.phrase || "", sentence: rec.sentence || rec.brief || "", paragraph: rec.paragraph || "", summary: rec.full || (rec.prose && rec.prose.full) || "", outline: rec.outlineFull || (rec.outline && rec.outline.full) || "", rewrite: (rec.levels && rec.levels.rewrite) || "" };
}
// One-line links to child elements. Each item: { label, sentence, attrs:{decade|year|month|week|day|category|subject|mem} }.
// A memory with picked coordinates gets a Street View photo of that spot (via our proxy), used in
// the Journal wherever memory images appear. The <img> carries onerror to drop itself if there's
// no coverage (the proxy 404s), so no broken-image icon.
function memStreetView(m) {
  return (m && Number.isFinite(m.lat) && Number.isFinite(m.lng)) ? `./api/streetview?lat=${m.lat}&lng=${m.lng}&size=480x360` : null;
}
// A memory's era-sequence of images: [{url, year}] (Wikimedia Commons, on sample lives). Falls back
// to a flat imageUrls list, then to the location's Street View. Blank on a memory with no photo/place.
function memImageList(m) {
  if (Array.isArray(m?.images) && m.images.length) return m.images.filter((i) => i && i.url).map((i) => ({ url: i.url, year: i.year ?? m.startYear ?? 2000 }));
  const urls = (Array.isArray(m?.imageUrls) ? m.imageUrls.filter(Boolean) : []);
  if (urls.length) return urls.map((u) => ({ url: u, year: m?.startYear ?? 2000 }));
  const sv = memStreetView(m);
  return sv ? [{ url: sv, year: m?.startYear ?? 2000 }] : [];
}
function memImageUrls(m) { return memImageList(m).map((i) => i.url); }
// The image "in effect" at `year` — the latest one that had appeared by then (else the earliest).
function memImageAsOf(m, year) {
  const list = memImageList(m).sort((a, b) => a.year - b.year);
  if (!list.length) return null;
  const past = list.filter((i) => i.year <= year);
  return (past.length ? past[past.length - 1] : list[0]).url;
}
function imagesHtmlFrom(urls) {
  const uniq = (urls || []).filter((u) => u && !shownImages.has(u));
  uniq.forEach((u) => shownImages.add(u)); // dedupe within the page
  return uniq.length
    ? `<div class="detail-images">${uniq.map((u) => `<figure><img src="${escapeHtml(u)}" alt="" loading="lazy" onerror="this.closest('figure').remove()"></figure>`).join("")}</div>`
    : "";
}
function imgFromDay(iso) { const im = (journal.days[iso]?.images || []).find((x) => !x.video); return im ? im.url : null; }
// Memories whose span covers a given year — so a year/month/week within a memory's range can show
// that memory's image (most time units have no day of their own).
function memsCovering(year) { return allMemories.filter((m) => m.startYear != null && year >= m.startYear && year <= (m.endYear || m.startYear)); }
// One representative image URL bubbled up from a child's descendant days + memories — used as the
// THUMBNAIL on the link to that child (images live on leaves and surface upward through the links,
// never as free-floating art on the parent page itself). Returns the latest image as-of the child's
// point in time, or null when the subtree has no image.
function repImage(dates = [], mems = [], asOfYear = null) {
  const items = [];
  for (const iso of dates) { const u = imgFromDay(iso); if (u) items.push([iso, u]); }
  for (const m of mems) {
    const u = asOfYear != null ? memImageAsOf(m, asOfYear) : memImageUrls(m)[0];
    if (u) items.push([`${asOfYear ?? m.startYear ?? 2000}-06-30`, u]);
  }
  if (!items.length) return null;
  items.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return items[items.length - 1][1]; // latest representative
}
function nodeLinksHtml(items) {
  if (!items.length) return "";
  return `<div class="node-links">${items.map((it) => {
    const attrs = Object.entries(it.attrs || {}).map(([k, val]) => `data-${k}="${escapeHtml(String(val))}"`).join(" ");
    const showThumb = it.thumb && !shownImages.has(it.thumb); // no repeats on the page
    if (showThumb) shownImages.add(it.thumb);
    const thumb = showThumb ? `<img class="node-link-thumb" src="${escapeHtml(it.thumb)}" alt="" loading="lazy" onerror="this.remove()">` : "";
    return `<button type="button" class="node-link${showThumb ? " has-thumb" : ""}" ${attrs}>${thumb}<span class="node-link-text"><span class="node-link-name">${escapeHtml(it.label)}</span>${it.sentence ? `<span class="node-link-line">${escapeHtml(resolveEntityTokens(it.sentence))}</span>` : ""}</span></button>`;
  }).join("")}</div>`;
}
function nodeScaffold({ name, subtitle = "", levels = {}, elementsHtml = "", elementsLabel = "", images = "", isLeaf = false, verbatim = "", correction = "" }) {
  const v = levels || {};
  const summarizing = !v.sentence && !v.paragraph && !v.summary;
  const hasSummary = !!v.summary;
  const canSummary = hasSummary || isLeaf;

  // 1) The summary sits at the top, expanded. Show the best summary we already have (full, else the
  //    paragraph, else the sentence) right away; a leaf then upgrades it to the full summary on load
  //    (generateLeafDetail targets [data-detail="summary"]) — so there's no bare "writing…" wait.
  const summaryText = v.summary || v.paragraph || v.sentence || "";
  const summaryHtml = `<div class="node-summary" data-detail="summary">`
    + (summaryText ? renderFull(summaryText)
        : canSummary ? `<p class="lazy-hint">✦ Writing the summary…</p>` : "")
    + `</div>`;

  // 2) On a leaf, the verbatim transcript is shown right after the summary, open (still collapsible).
  //    It's directly editable — fix a mistake in the raw words and re-summarize (works on futures too).
  const verbatimHtml = (isLeaf && verbatim)
    ? `<details class="node-fold node-verbatim-fold" open><summary>Verbatim transcript</summary>`
      + `<div class="node-fold-body">`
      + `<div class="node-verbatim" data-verbatim>${escapeHtml(verbatim)}</div>`
      + `<div class="verbatim-tools"><button type="button" class="verbatim-edit">✎ Edit transcript</button></div>`
      + `</div></details>`
    : "";

  // 3) The outline lives at the BOTTOM for every node, as a drill-down tree collapsed to its top
  //    level (its expansion is saved/restored per page — see restoreOutline/saveOutline).
  const hasOutline = !!v.outline;
  const outlineHtml = (hasOutline || (isLeaf && canSummary))
    ? `<section class="node-outline"><p class="nav-hint">Outline</p>`
      + `<div class="node-outline-body" data-detail="outline">`
      + (hasOutline ? renderOutlineTree(v.outline) : `<p class="lazy-hint">✦ Building the outline…</p>`)
      + `</div></section>`
    : "";

  return `${name ? `<h2 class="node-name">${escapeHtml(name)}</h2>` : ""}`
    + (subtitle ? `<p class="node-subtitle">${escapeHtml(subtitle)}</p>` : "")
    + (summarizing ? summarizingNote() : "")
    + (!isLeaf && v.word ? `<p class="node-word">${escapeHtml(resolveEntityTokens(v.word))}</p>` : "")   // zoom-OUT rungs, non-leaf
    + (!isLeaf && v.phrase ? `<p class="node-phrase">${escapeHtml(resolveEntityTokens(v.phrase))}</p>` : "")
    + summaryHtml               // full summary at the top
    + verbatimHtml              // leaf: transcript right after the summary
    + images
    + (elementsHtml ? `${elementsLabel ? `<p class="nav-hint">${escapeHtml(elementsLabel)}</p>` : ""}${elementsHtml}` : "")
    + outlineHtml               // outline at the bottom
    // Speak/type your own take, below the outline. It's added to this node's text (a leaf's
    // transcript; a roll-up's note) and folded into its summary. Mic is desktop-only (mobile uses
    // the keyboard mic); the textarea works everywhere.
    + `<section class="node-comment">`
      + `<p class="nav-hint">${isLeaf ? "Add to this day — speak or type; it joins the transcript and re-summarizes." : "Add your take — speak or type; it folds into this summary."}</p>`
      + `<div class="node-comment-row">`
      + `<textarea class="node-comment-input" rows="2" placeholder="As I see it…"></textarea>`
      + `<button type="button" class="node-comment-mic" hidden aria-label="Dictate">🎙</button>`
      + `</div>`
      + `<div class="node-comment-actions"><button type="button" class="node-comment-add">Add &amp; re-summarize</button><span class="node-comment-status"></span></div>`
      + `</section>`;
}

async function renderLife() {
  const years = yearsWithContent();
  const cats = categoriesWithContent();
  if (!years.length && !cats.length) {
    els.root.innerHTML = `<p class="nav-hint">Nothing recorded yet — write a day or add a memory, and your life begins here.</p>`;
    return;
  }

  const life = await getPeriod("LIFE");
  const decades = [...new Set([...years.map((y) => bucketStart(y)), ...memoryDecades()])].sort((a, b) => a - b);
  const decRecs = await Promise.all(decades.map((dd) => getPeriod(bucketKey(dd))));
  const catRecs = await Promise.all(cats.map((c) => getPeriod(catKey(c))));
  const decadeLinks = nodeLinksHtml(decades.map((dd, i) => ({ label: bucketLabel(dd), sentence: levelsOf(decRecs[i]).sentence, attrs: { decade: dd }, thumb: repImage(Object.keys(journal.days).filter((x) => bucketStart(+x.slice(0, 4)) === dd), memoriesInDecade(dd), bucketEnd(dd)) })));
  const categoryLinks = nodeLinksHtml(cats.map((c, i) => ({ label: c, sentence: levelsOf(catRecs[i]).sentence, attrs: { category: c }, thumb: repImage([], memoriesInCategory(c)) })));

  els.root.innerHTML = nodeScaffold({
    name: "Life",
    levels: levelsOf(life),
    elementsHtml: (decades.length ? `<p class="nav-hint">Your decades</p>${decadeLinks}` : "")
      + (cats.length ? `<p class="nav-hint">Your memories, by category</p>${categoryLinks}` : ""),
  });
}

// ---- Leaf: lazy detail + corrections ---------------------------------------------------
// `currentLeaf` is the leaf on screen (its raw text + how to persist new levels). `lazyLeaf`
// is that same object while its heavy summary is still ungenerated (else null). A saved
// `correction` note is fed into every (re)summarization of the item so the fix sticks.
let currentLeaf = null;
let lazyLeaf = null;
let lazyBusy = false;
function makeDayLeaf(day, iso) {
  return {
    ctx: { type: "day", label: iso, date: iso },
    refs: day.entityRefs || [],
    correction: day.correction || "",
    getRaw: async () => (day.reps && day.reps.verbatim) || (await getEntry(iso))?.raw || "",
    applyLevels: async (patch, correction) => {
      const base = (await getEntry(iso)) || { date: iso, dayOfWeek: day.dayOfWeek };
      const levels = { ...(base.levels || day.levels || {}), ...patch };
      const updated = withMode({
        ...base, levels,
        prose: { brief: levels.sentence || "", full: levels.summary || base.prose?.full || "" },
        outline: { brief: base.outline?.brief || "", full: levels.outline || base.outline?.full || "" },
        ...(correction !== undefined ? { correction } : {}), updatedAt: Date.now(),
      }, "prose");
      await putEntry(updated);
      journal.days[iso] = { ...day, brief: updated.brief, full: updated.full, mode: "prose", levels, reps: repsOf(updated), correction: correction ?? day.correction };
    },
  };
}
function makeMemoryLeaf(m) {
  return {
    ctx: { type: "memory", label: m.label || String(m.startYear || ""), subject: m.subject || "", date: `${m.startYear || 2000}-01-01` },
    refs: m.entityRefs || [],
    correction: m.correction || "",
    getRaw: async () => m.text || "",
    applyLevels: async (patch, correction) => {
      const levels = { ...(m.levels || {}), ...patch };
      const updated = { ...m, levels, prose: { brief: levels.sentence || "", full: levels.summary || m.prose?.full || "" }, outline: { brief: m.outline?.brief || "", full: levels.outline || m.outline?.full || "" }, ...(correction !== undefined ? { correction } : {}) };
      const i = allMemories.findIndex((x) => x.id === m.id);
      if (i >= 0) allMemories[i] = updated;
      await putMemory(updated);
    },
  };
}
function setLazyDay(day, iso) { currentLeaf = makeDayLeaf(day, iso); lazyLeaf = (day.levels && day.levels.summary) ? null : currentLeaf; }
function setLazyMemory(m) { currentLeaf = makeMemoryLeaf(m); lazyLeaf = (m.levels && m.levels.summary) ? null : currentLeaf; }

// Generate the complete summary + outline for the current leaf and drop them into the open
// summary/outline bodies (one call fills both). No-op once done — lazyLeaf is cleared.
async function generateLeafDetail() {
  if (!lazyLeaf || lazyBusy) return;
  const sBody = els.root.querySelector('[data-detail="summary"]');
  const oBody = els.root.querySelector('[data-detail="outline"]');
  lazyBusy = true;
  // Show this on-demand summary in Activity too — otherwise the page says "Writing…" while the
  // Activity queue looks empty (the batch pass logs there; this per-leaf call did not, until now).
  const label = lazyLeaf.ctx && lazyLeaf.ctx.type === "day" ? formatDate(lazyLeaf.ctx.date, "short") : (lazyLeaf.ctx && lazyLeaf.ctx.label) || "this entry";
  const jid = logAdd(label, (lazyLeaf.ctx && lazyLeaf.ctx.type) || "detail");
  logSet(jid, "running");
  const spin = `<p class="lazy-hint">✦ Writing…</p>`;
  if (sBody) sBody.innerHTML = spin;
  if (oBody) oBody.innerHTML = spin;
  try {
    const raw = await lazyLeaf.getRaw();
    if (!raw) {
      const msg = `<p class="lazy-hint">The full text isn't stored for this entry anymore.</p>`;
      if (sBody) sBody.innerHTML = msg;
      if (oBody) oBody.innerHTML = msg;
      logSet(jid, "error", { error: "no source text" });
      return;
    }
    const style = localStorage.getItem("summary-style") || "";
    const d = await postSummarize({ mode: "detail", text: raw, style, correction: lazyLeaf.correction, entities: rosterFor(lazyLeaf.refs), ...lazyLeaf.ctx });
    await lazyLeaf.applyLevels({ summary: d.summary || "", outline: d.outline || "" });
    if (sBody) sBody.innerHTML = renderFull(d.summary || "");
    if (oBody) oBody.innerHTML = renderOutlineTree(d.outline || ""); // collapsed tree at the bottom
    els.root.querySelectorAll("[data-lazy]").forEach((el) => el.removeAttribute("data-lazy"));
    lazyLeaf = null;
    logSet(jid, "done");
  } catch (e) {
    const msg = `<p class="lazy-hint">Couldn't generate right now — tap again to retry.</p>`;
    if (sBody) sBody.innerHTML = msg;
    if (oBody) oBody.innerHTML = msg;
    logSet(jid, "error", { error: (e && e.message) || "failed" });
  } finally { lazyBusy = false; }
}

// Re-summarize the current leaf, telling the model what was wrong. The note is saved on the
// item so future regenerations (voice change, edits, roll-ups) keep honoring it.
async function correctLeaf(correctionText, statusEl) {
  if (!currentLeaf || lazyBusy) return;
  lazyBusy = true;
  if (statusEl) { statusEl.textContent = "Re-summarizing with your note…"; statusEl.className = "correct-status"; }
  try {
    const raw = await currentLeaf.getRaw();
    if (!raw) { if (statusEl) { statusEl.textContent = "The full text isn't stored anymore — can't redo this one."; statusEl.className = "correct-status error"; } return; }
    const style = localStorage.getItem("summary-style") || "";
    const lv = await postSummarize({ mode: "levels", text: raw, style, distilled: true, correction: correctionText, ...currentLeaf.ctx });
    await currentLeaf.applyLevels({ word: lv.word, phrase: lv.phrase, sentence: lv.sentence, paragraph: lv.paragraph, summary: "", outline: "" }, correctionText);
    render(); // the heavy summary/outline regenerate lazily, honoring the same note
  } catch {
    if (statusEl) { statusEl.textContent = "Couldn't re-summarize — try again."; statusEl.className = "correct-status error"; }
  } finally { lazyBusy = false; }
}

// ---- Edit the verbatim transcript inline (leaf pages) → re-summarize from the fixed words ----
function beginVerbatimEdit(body) {
  if (!body) return;
  const view = body.querySelector("[data-verbatim]");
  const tools = body.querySelector(".verbatim-tools");
  if (!view || view.dataset.editing) return;
  const raw = view.textContent;
  view.dataset.editing = "1";
  view.innerHTML = `<textarea class="verbatim-input" rows="8"></textarea>`;
  view.querySelector(".verbatim-input").value = raw;
  if (tools) tools.innerHTML = `<button type="button" class="verbatim-save">Save &amp; re-summarize</button>`
    + `<button type="button" class="verbatim-cancel">Cancel</button>`
    + `<span class="verbatim-status"></span>`;
  view.querySelector(".verbatim-input").focus();
}
async function saveVerbatimEdit(body) {
  if (!body) return;
  const ta = body.querySelector(".verbatim-input");
  const statusEl = body.querySelector(".verbatim-status");
  if (!ta) return;
  const text = ta.value.trim();
  if (!text) { if (statusEl) statusEl.textContent = "Transcript can't be empty."; return; }
  const ref = currentNodeRef();
  if (!ref || (ref.kind !== "day" && ref.kind !== "mem")) { if (statusEl) statusEl.textContent = "Can only edit a day or memory transcript."; return; }
  if (statusEl) statusEl.textContent = "Saving…";
  try {
    if (ref.kind === "day") {
      const e = (await getEntry(ref.date)) || { date: ref.date };
      const next = { ...e, raw: text, rawSavedAt: Date.now(), updatedAt: Date.now() };
      delete next.levels; delete next.prose; delete next.outline; delete next.brief; delete next.full;
      await putEntry(next);
    } else {
      const m = allMemories.find((x) => x.id === ref.id);
      if (!m) throw new Error("memory not found");
      const next = { ...m, text, needsSummary: true, updatedAt: Date.now() };
      delete next.levels; delete next.prose; delete next.outline;
      await putMemory(next);
    }
    await reloadAndRender(); // re-summarize this leaf from the edited words, and roll it up (see Activity)
  } catch (err) {
    if (statusEl) statusEl.textContent = `Couldn't save: ${(err && err.message) || err}`;
  }
}

// ---- Comment box below the outline: your spoken/typed take, folded into this node's summary --
// Leaf: appended to the transcript (raw), then re-summarized. Roll-up: appended to the node's note,
// which storePeriod folds into its rollup. Either way, the text affects this node's summary.
async function addNodeComment(section) {
  const ta = section.querySelector(".node-comment-input");
  const statusEl = section.querySelector(".node-comment-status");
  const text = (ta && ta.value || "").trim();
  if (!text) return;
  const ref = currentNodeRef();
  if (!ref) { if (statusEl) statusEl.textContent = "Nowhere to add this."; return; }
  if (statusEl) statusEl.textContent = "Adding & re-summarizing…";
  try {
    if (ref.kind === "day") {
      const e = (await getEntry(ref.date)) || { date: ref.date };
      const raw = (e.raw ? e.raw + "\n\n" : "") + text;
      const next = { ...e, raw, rawSavedAt: Date.now(), updatedAt: Date.now() };
      delete next.levels; delete next.prose; delete next.outline; delete next.brief; delete next.full;
      await putEntry(next);
    } else if (ref.kind === "mem") {
      const m = allMemories.find((x) => x.id === ref.id);
      if (!m) throw new Error("not found");
      const next = { ...m, text: (m.text ? m.text + "\n\n" : "") + text, needsSummary: true, updatedAt: Date.now() };
      delete next.levels; delete next.prose; delete next.outline;
      await putMemory(next);
    } else {
      const p = (await getPeriod(ref.key)) || { key: ref.key };
      await putPeriod({ ...p, note: (p.note ? p.note + "\n" : "") + text }); // folded into the rollup; hash changes → re-summarized
    }
    await reloadAndRender();
  } catch (err) {
    if (statusEl) statusEl.textContent = `Couldn't add: ${(err && err.message) || err}`;
  }
}

// ---- Report a mistake on any node → attach a note, folded into that node's summary --------
// The reader selects text anywhere and says what's wrong. We store the note ("In reference to
// '<selected>': <note>") on the node they're viewing — a leaf's correction, or a roll-up's note —
// and re-summarize that node so the fix is honored and rolls up. Works at every level: if the
// exact leaf can't be pinned down, the note catches it at the parent.
function currentNodeRef() {
  const s = state;
  if (s.zoom === "day") return { kind: "day", date: s.focusDate };
  if (s.zoom === "memory") return { kind: "mem", id: s.memoryId };
  if (s.zoom === "week") return { kind: "period", key: "W" + sundayWeekStart(s.focusDate) };
  if (s.zoom === "month") return { kind: "period", key: "M" + s.focusDate.slice(0, 7) };
  if (s.zoom === "year") return { kind: "period", key: "Y" + s.focusDate.slice(0, 4) };
  if (s.zoom === "decade") return { kind: "period", key: bucketKey(bucketStart(+s.focusDate.slice(0, 4))) };
  if (s.zoom === "life") return { kind: "period", key: "LIFE" };
  if (s.zoom === "category") return { kind: "period", key: catKey(s.category) };
  if (s.zoom === "subject") return { kind: "period", key: subKey(s.category, s.subject) };
  return null;
}
async function amendReport(selection, note, setStatus) {
  const ref = currentNodeRef();
  const noteT = (note || "").trim();
  const sel = (selection || "").trim();
  const text = (sel ? `In reference to "${sel}": ` : "") + noteT;
  if (!ref || !noteT) { setStatus("Nothing to attach the note to here.", "error"); return; }
  setStatus("Adding your note and re-summarizing…", "working");
  try {
    if (ref.kind === "day") {
      const e = await getEntry(ref.date);
      if (!e) throw new Error("entry not found");
      const correction = (e.correction ? e.correction + "\n" : "") + text;
      const next = { ...e, correction, updatedAt: Date.now() };
      delete next.levels; delete next.prose; delete next.outline; delete next.brief; delete next.full;
      await putEntry(next);
    } else if (ref.kind === "mem") {
      const m = allMemories.find((x) => x.id === ref.id);
      if (!m) throw new Error("memory not found");
      const correction = (m.correction ? m.correction + "\n" : "") + text;
      const next = { ...m, correction, needsSummary: true, updatedAt: Date.now() };
      delete next.levels; delete next.prose; delete next.outline;
      await putMemory(next);
    } else {
      const p = (await getPeriod(ref.key)) || { key: ref.key };
      const noteAll = (p.note ? p.note + "\n" : "") + text;
      await putPeriod({ ...p, note: noteAll }); // hash now differs from inputHash → re-summarized with the note
    }
    setStatus("Re-summarizing — watch Activity…", "ok");
    await reloadAndRender(); // re-summarize this node with the note, and roll the fix up every level
  } catch (e) {
    setStatus(`Couldn't apply: ${(e && e.message) || e}`, "error");
  }
}

// The selection toolbar: a chip that appears when you select text on a node page, opening a small
// panel to say what's wrong. Built once and reused; created lazily on the document body.
function setupFixSelection() {
  let sel = "";
  const bar = document.createElement("button");
  bar.id = "fixsel-bar"; bar.type = "button"; bar.hidden = true;
  const panel = document.createElement("div");
  panel.id = "fixsel-panel"; panel.hidden = true;
  panel.innerHTML = `<div class="fixsel-card">
      <h3 class="fixsel-title">Report a mistake</h3>
      <p class="fixsel-quote"></p>
      <textarea class="fixsel-note" rows="3" placeholder="What's wrong? e.g. “Zay is misspelled — it should be Ze, short for Jose.”"></textarea>
      <div class="fixsel-actions"><button type="button" class="fixsel-cancel">Cancel</button><button type="button" class="fixsel-apply">Fix it</button></div>
      <p class="fixsel-status"></p>
    </div>`;
  document.body.appendChild(bar);
  document.body.appendChild(panel);
  const quote = panel.querySelector(".fixsel-quote");
  const noteEl = panel.querySelector(".fixsel-note");
  const statusEl = panel.querySelector(".fixsel-status");
  const setStatus = (msg, cls = "") => { statusEl.textContent = msg; statusEl.className = "fixsel-status" + (cls ? " " + cls : ""); };

  document.addEventListener("selectionchange", () => {
    if (!panel.hidden) return; // don't fight the open panel
    const s = window.getSelection();
    const text = s && s.toString().trim();
    const anchor = s && s.anchorNode;
    const inContent = anchor && els.root && els.root.contains(anchor.nodeType === 3 ? anchor.parentNode : anchor);
    if (text && text.length >= 2 && inContent) {
      sel = text;
      bar.textContent = `✎ Fix “${text.length > 40 ? text.slice(0, 40) + "…" : text}”`;
      bar.hidden = false;
    } else {
      bar.hidden = true;
    }
  });
  bar.addEventListener("click", () => {
    bar.hidden = true;
    quote.textContent = `“${sel}”`;
    noteEl.value = "";
    setStatus("");
    panel.hidden = false;
    noteEl.focus();
  });
  const close = () => { panel.hidden = true; };
  panel.querySelector(".fixsel-cancel").addEventListener("click", close);
  panel.addEventListener("click", (e) => { if (e.target === panel) close(); });
  panel.querySelector(".fixsel-apply").addEventListener("click", async () => {
    const note = noteEl.value.trim();
    if (!note) { noteEl.focus(); return; }
    await amendReport(sel, note, setStatus);
    if (statusEl.classList.contains("ok")) setTimeout(close, 1400);
  });
}

// A "working on the summary" banner, shown while an item is still just verbatim. When a batch is
// in flight (e.g. you just stepped into a freshly-imagined future), show how far along it is so a
// queued item doesn't look stuck — the page still updates itself the moment this one is ready.
function summarizingNote() {
  const queued = summarizing && passTotal > 1;
  const progress = queued ? ` <span class="sn-count">(${passDone} of ${passTotal} done)</span>` : "";
  const tail = queued
    ? "Working through the queue — this page fills in on its own when its turn comes."
    : "This usually takes 15–30 seconds. The page updates on its own when it's ready.";
  return `<p class="summarizing-note">✦ Writing the summary…${progress} ${tail}</p>`;
}

// Open a memory's own page. Sets its category/subject so the breadcrumb is correct no
// matter where we came from (a subject list, a category, or a decade timeline).
function goToMemory(id) {
  const m = allMemories.find((x) => x.id === id);
  if (m) { state.category = catOf(m); state.subject = subjOf(m); }
  state.zoom = "memory"; state.memoryId = id; render();
}
// A single memory as a leaf page (its text is the verbatim).
// The year(s) a memory covers: "1985", "1980 – 1983", or "1990 – present" (open-ended).
function memYearRange(m) {
  if (m.startYear == null) return "";
  const s = m.startYear;
  if (m.ongoing) return `${s} – present`;
  const e = m.endYear || s;
  return e > s ? `${s} – ${e}` : `${s}`;
}
// The year span covering a set of memories (for a subject/category page).
function memsYearRange(mems) {
  const withYear = mems.filter((m) => m.startYear != null);
  if (!withYear.length) return "";
  const min = Math.min(...withYear.map((m) => m.startYear));
  const max = withYear.some((m) => m.ongoing) ? null : Math.max(...withYear.map((m) => m.endYear || m.startYear));
  if (max == null) return `${min} – present`;
  return max > min ? `${min} – ${max}` : `${min}`;
}

// "Add another" button that opens Write on a fresh memory, pre-filled with this category/subject.
function addMemoryBtn(category, subject) {
  const label = subject ? `＋ Add another to ${subject}` : `＋ Add to ${category}`;
  return `<button type="button" class="detail-nav-btn add-mem" data-add-cat="${escapeHtml(category || "")}" data-add-subj="${escapeHtml(subject || "")}">${escapeHtml(label)}</button>`;
}

function renderSingleMemory(m, name) {
  const actions = `<div class="day-actions">
    <button type="button" class="detail-nav-btn mem-edit" data-mem-id="${m.id}">✎ Edit</button>
    ${addMemoryBtn(catOf(m), subjOf(m))}
  </div>`;
  setLazyMemory(m);
  els.root.innerHTML = actions + nodeScaffold({ name: name || m.subject || m.label || "Memory", subtitle: memYearRange(m), levels: levelsOf(m), images: imagesHtmlFrom(memImageUrls(m)), isLeaf: true, verbatim: m.text, correction: m.correction || "" });
  if (lazyLeaf) generateLeafDetail(); // build the leading outline right away, not on a click
}

// A category: a single memory (no subjects) is shown directly; otherwise its summary +
// subject links + links to any subject-less memories.
async function renderCategory() {
  const cat = state.category;
  const mems = memoriesInCategory(cat);
  if (!mems.length) { els.root.innerHTML = `<p class="nav-hint">No memories in ${escapeHtml(cat)}.</p>`; return; }
  const subjects = subjectsInCategory(cat);
  const loose = mems.filter((m) => !subjOf(m));
  if (!subjects.length && mems.length === 1) { renderSingleMemory(mems[0], cat); return; }

  const rec = await getPeriod(catKey(cat));
  const subRecs = await Promise.all(subjects.map((s) => getPeriod(subKey(cat, s))));
  const subjectLinks = nodeLinksHtml(subjects.map((s, i) => ({ label: s, sentence: levelsOf(subRecs[i]).sentence, attrs: { subject: s }, thumb: repImage([], memoriesInSubject(cat, s)) })));
  const looseLinks = nodeLinksHtml(loose.map((m) => ({ label: m.label || "", sentence: levelsOf(m).sentence, attrs: { mem: m.id }, thumb: memImageUrls(m)[0] })));
  const timeline = memoryTimelineSpan(mems);
  els.root.innerHTML = `<div class="day-actions">${addMemoryBtn(cat, "")}</div>` + nodeScaffold({
    name: cat, levels: levelsOf(rec),
    elementsHtml: (timeline ? `<p class="nav-hint">Timeline</p>${timeline}` : "")
      + (subjects.length ? `<p class="nav-hint">By subject</p>${subjectLinks}` : "")
      + (loose.length ? `<p class="nav-hint">${subjects.length ? "Other memories" : "Memories"}</p>${looseLinks}` : ""),
  });
}

// A subject: a single memory is the page itself; multiple → summary + links to each memory.
async function renderSubject() {
  const cat = state.category, subj = state.subject;
  const mems = memoriesInSubject(cat, subj);
  if (!mems.length) { els.root.innerHTML = `<p class="nav-hint">No memories for ${escapeHtml(subj)}.</p>`; return; }
  if (mems.length === 1) { renderSingleMemory(mems[0], subj); return; }
  const rec = await getPeriod(subKey(cat, subj));
  const links = nodeLinksHtml(mems.map((m) => ({ label: m.label || "", sentence: levelsOf(m).sentence, attrs: { mem: m.id }, thumb: memImageUrls(m)[0] })));
  const timeline = memoryTimelineSpan(mems);
  els.root.innerHTML = `<div class="day-actions">${addMemoryBtn(cat, subj)}</div>` + nodeScaffold({
    name: subj, subtitle: memsYearRange(mems), levels: levelsOf(rec),
    elementsHtml: (timeline ? `<p class="nav-hint">Timeline</p>${timeline}` : "") + `<p class="nav-hint">Memories</p>${links}`,
  });
}

// A single memory as its own page (reached from a subject/category holding several).
function renderMemory() {
  const m = allMemories.find((x) => x.id === state.memoryId);
  if (!m) { els.root.innerHTML = `<p class="nav-hint">Memory not found.</p>`; return; }
  renderSingleMemory(m, m.subject || m.label || m.category || "Memory");
}

// Automatic summarization. Runs in the background (never blocks the UI) after every
// reload. Guarded so only one pass runs at a time; if content changes while a pass is
// running, one more pass is scheduled when it finishes. Failed periods (a request timed
// out or errored) are retried on a backoff so nothing stays stuck on "Summarizing…".
let summarizing = false;
let rerunPending = false;
let passDone = 0, passTotal = 0; // live progress of the current summarization pass (for placeholders)
let autoRetries = 0;
let retryTimer = null;
const MAX_AUTO_RETRIES = 6;

// How many summarize calls may be in flight at once. The pass is otherwise a long serial
// chain of 15–30s LLM calls; running independent nodes concurrently cuts the wall time.
const AUTO_CONCURRENCY = 4;
// A tiny concurrency gate. `limit(fn)` runs fn when a slot is free. IMPORTANT: never call
// limit() from inside a limit()-wrapped task — a parent holding a slot while awaiting gated
// children would deadlock. Each level is a flat Promise.all of gated leaf/period calls.
// The human word for each node level, shown in the progress toast so the climb is legible.
const LEVEL_WORD = { day: "day", memory: "memory", week: "week", month: "month", year: "year", decade: "decade", subject: "subject", category: "category", life: "life" };

// A small fixed toast (bottom of the screen) that shows summarization progress. It lives on
// <body>, outside the calendar root, so a re-render doesn't wipe it. Pass "" to hide it.
function setProgress(html) {
  let el = document.getElementById("summary-progress");
  if (!html) { if (el) el.hidden = true; return; }
  if (!el) {
    el = document.createElement("div");
    el.id = "summary-progress";
    el.className = "summary-progress";
    document.body.appendChild(el);
  }
  el.hidden = false;
  el.innerHTML = `<span class="sp-spinner" aria-hidden="true"></span><span class="sp-text">${html}</span>`;
}

function makeLimiter(max) {
  let active = 0;
  const queue = [];
  const pump = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; pump(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); });
}

function autoSummarize() {
  if (localStorage.getItem(jkey("baked")) === "1") return; // prebuilt sample: summaries are shipped
  if (summarizing) { rerunPending = true; return; }
  summarizing = true;
  (async () => {
    try { do { rerunPending = false; await runAutoPass(); } while (rerunPending); }
    finally { summarizing = false; }
  })();
}

// POST to /api/summarize with a hard timeout, so one hung request can't block the
// serial build forever. Throws on timeout or a non-OK response.
// The reader's own model/key/endpoint (from Settings), sent with every request. Empty → server default.
function llmOverrides() {
  // Built-in provider (value "") means "use the server's own key/model". Never send a saved
  // apiKey/model/baseUrl in that case — a stale key from a past custom provider would otherwise
  // override the good server key and 401 every call.
  const provider = localStorage.getItem("llm-provider") || "";
  if (!provider) return {};
  return {
    provider,
    apiKey: localStorage.getItem("llm-api-key") || "",
    model: localStorage.getItem("llm-model") || "",
    baseUrl: localStorage.getItem("llm-base-url") || "",
  };
}
async function postSummarize(body, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch("/api/summarize", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...llmOverrides(), ...body }), signal: ctrl.signal,
    });
    if (!r.ok) {
      // Surface the API's own error text (e.g. a DeepSeek rate-limit or a bad-config message),
      // not just the status — otherwise "Server 500" hides the real cause on the Activity page.
      let detail = "";
      try { detail = (await r.json())?.error || ""; } catch { /* body wasn't JSON */ }
      throw new Error(`Server ${r.status}${detail ? ": " + String(detail).slice(0, 100) : ""}`);
    }
    return await r.json();
  } finally { clearTimeout(timer); }
}

const DAY_ID = (iso) => "DAY:" + iso;
const MEM_ID = (id) => "MEM:" + id;

// Build the summarization graph from current data. Nodes: days & memories (leaves), the periods
// (week…life), and the memory groupings (subject, category). `children` are what a node
// summarizes. Memories have TWO parents — their decade AND their subject/category — which this
// DAG handles naturally. Returns Map(id → { id, type, key?, label, children }).
function buildGraph() {
  const dates = Object.keys(journal.days).sort();
  const memories = allMemories;
  const nodes = new Map();
  const add = (id, n) => { nodes.set(id, { id, children: [], ...n }); };
  // `sort` groups each graph row: the memory branch ("0|category|subject|…") clusters on the
  // left by category, the time branch ("1|<chronological>") sits to the right in time order.
  for (const iso of dates) add(DAY_ID(iso), { type: "day", iso, label: formatDate(iso, "short"), nav: { zoom: "day", focusDate: iso }, sort: "1|" + iso });
  for (const m of memories) add(MEM_ID(m.id), { type: "memory", memId: m.id, label: m.subject || m.label || "a memory", nav: { zoom: "memory", memId: m.id }, sort: "0|" + catOf(m) + "|" + (subjOf(m) || "~") + "|" + (m.subject || m.label || "") });
  const weeks = [...new Set(dates.map(sundayWeekStart))].sort();
  const months = [...new Set(dates.map((d) => d.slice(0, 7)))].sort();
  // A memory attaches to its START year (one node per memory) — connecting it to every year it
  // spanned flooded the graph with year nodes. It rolls up year → decade → Life from there.
  const yearMems = new Map(); // year → memory ids
  for (const m of memories) if (m.startYear != null) { const y = String(m.startYear); if (!yearMems.has(y)) yearMems.set(y, []); yearMems.get(y).push(MEM_ID(m.id)); }
  const years = [...new Set([...yearsWithContent().map(String), ...yearMems.keys()])].sort();
  const decades = [...new Set(years.map((y) => bucketStart(+y)))].sort((a, b) => a - b);
  const cats = [...new Set(memories.map(catOf))].sort((a, b) => a.localeCompare(b));
  for (const w of weeks) add("W" + w, { type: "week", key: "W" + w, label: `Week of ${formatDate(w, "short")}`, children: weekDates(w).filter((d) => journal.days[d]).map(DAY_ID), nav: { zoom: "week", focusDate: w }, sort: "1|" + w });
  for (const m of months) { const wk = [...new Set(dates.filter((d) => d.startsWith(m)).map(sundayWeekStart))].sort(); add("M" + m, { type: "month", key: "M" + m, label: monthLabel(m), children: wk.map((w) => "W" + w), nav: { zoom: "month", focusDate: m + "-01" }, sort: "1|" + m }); }
  for (const y of years) add("Y" + y, { type: "year", key: "Y" + y, label: y, children: [...months.filter((mm) => mm.startsWith(y)).map((m) => "M" + m), ...(yearMems.get(y) || [])], nav: { zoom: "year", focusDate: y + "-01-01" }, sort: "1|" + y });
  for (const dd of decades) add(bucketKey(dd), { type: "decade", key: bucketKey(dd), label: bucketLabel(dd), children: years.filter((yy) => bucketStart(+yy) === dd).map((y) => "Y" + y), nav: { zoom: "decade", focusDate: dd + "-01-01" }, sort: "1|" + dd });
  for (const cat of cats) {
    const catMems = memories.filter((m) => catOf(m) === cat);
    const subjects = [...new Set(catMems.map(subjOf).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    for (const subj of subjects) add(subKey(cat, subj), { type: "subject", key: subKey(cat, subj), label: subj, children: catMems.filter((m) => subjOf(m) === subj).map((m) => MEM_ID(m.id)), nav: { zoom: "subject", category: cat, subject: subj }, sort: "0|" + cat + "|" + subj });
    add(catKey(cat), { type: "category", key: catKey(cat), label: cat, children: [...subjects.map((s) => subKey(cat, s)), ...catMems.filter((m) => !subjOf(m)).map((m) => MEM_ID(m.id))], nav: { zoom: "category", category: cat }, sort: "0|" + cat });
  }
  const lifeKids = [...decades.map((dd) => bucketKey(dd)), ...cats.map((cat) => catKey(cat))];
  if (nodes.size) add("LIFE", { type: "life", key: "LIFE", label: "A life", children: lifeKids.length ? lifeKids : dates.map(DAY_ID), nav: { zoom: "life" }, sort: "0" });
  return nodes;
}

// The dirty/ready calculus over a graph, given preloaded entries & periods. Shared by the pass
// (which mutates the live maps) and the graph overlay (a static DB snapshot).
function makeGraphState(nodes, entryByDate, periodById) {
  const node = (id) => nodes.get(id);
  const memOf = (id) => allMemories.find((x) => MEM_ID(x.id) === id);
  const briefOf = (id) => {
    const n = node(id);
    if (n.type === "day") { const cd = journal.days[n.iso]; return (cd && cd.levels && cd.levels.sentence) || (cd && cd.brief) || ""; }
    if (n.type === "memory") { const m = memOf(id); return (m && m.levels && m.levels.sentence) || (m && m.prose && m.prose.brief) || (m && m.text) || ""; }
    const p = periodById.get(n.key); return p ? ((p.levels && p.levels.sentence) || p.brief || "") : "";
  };
  const childObj = (id) => {
    const n = node(id);
    if (n.type === "day") { const cd = journal.days[n.iso]; return { date: n.iso, brief: cd.brief, full: cd.full, levels: cd.levels }; }
    if (n.type === "memory") return memChild(memOf(id));
    const p = periodById.get(n.key); return { date: n.label, brief: p && p.brief, full: p && p.full, levels: p && p.levels };
  };
  // The hash also folds in the node's own note, so attaching/editing a note marks it dirty and it
  // re-summarizes honoring the note (a period's note lives on its stored record).
  const inputHash = (id) => {
    const n = node(id);
    const note = n.key ? (periodById.get(n.key)?.note || "") : "";
    return hashBriefs([...n.children.map((cid) => ({ date: cid, brief: briefOf(cid) })), { date: "__note__", brief: note }]);
  };
  const isDirty = (id) => {
    const n = node(id);
    // A leaf needs (re)summarizing until it has a FULL summary — not just the cheap rungs — so a
    // day/memory is usable the moment you reach it, without a lazy on-open call. (Older entries that
    // only have the distilled rungs get upgraded to the full summary on the next pass.)
    if (n.type === "day") { const e = entryByDate.get(n.iso), cd = journal.days[n.iso]; return !!(e && e.raw) && !(cd && cd.levels && cd.levels.summary); }
    if (n.type === "memory") { const m = memOf(id); return !!m && (!m.levels || !m.levels.summary || m.needsSummary); }
    const p = periodById.get(n.key); return !p || p.hash !== inputHash(id);
  };
  const isClean = (id) => !isDirty(id);
  const isReady = (id) => node(id).children.every(isClean); // leaves have no children → always ready
  return { node, memOf, briefOf, childObj, inputHash, isDirty, isClean, isReady };
}

// The node the user is viewing — used to prioritize its subtree and to center the graph overlay.
function focusNodeId(nodes) {
  const z = state.zoom, fd = state.focusDate;
  let id = null;
  if (z === "day") id = DAY_ID(fd);
  else if (z === "week") id = "W" + sundayWeekStart(fd);
  else if (z === "month") id = "M" + fd.slice(0, 7);
  else if (z === "year") id = "Y" + fd.slice(0, 4);
  else if (z === "decade") id = bucketKey(bucketStart(fd.slice(0, 4)));
  else if (z === "life") id = "LIFE";
  else if (z === "category") id = catKey(state.category);
  else if (z === "subject") id = subKey(state.category, state.subject);
  else if (z === "memory") id = MEM_ID(state.memoryId);
  return id && nodes.has(id) ? id : null;
}

// A plain, serializable snapshot of the graph + each node's dirty/active state + its one-line
// summary and navigation target, for the graph view (tap a node → quick preview + Open).
function graphSnapshot(nodes, isDirty, activeIds, focus, briefOf) {
  return {
    focus,
    nodes: [...nodes.values()].map((n) => ({
      id: n.id, type: n.type, label: n.label, children: n.children, nav: n.nav, sort: n.sort,
      brief: briefOf ? briefOf(n.id) : "", dirty: isDirty(n.id), active: !!(activeIds && activeIds.has(n.id)),
    })),
  };
}
// Compute a fresh snapshot straight from the DB (used when the overlay opens while idle).
async function currentGraphSnapshot() {
  const nodes = buildGraph();
  const entryByDate = new Map((await getAllEntries()).map((e) => [e.date, e]));
  const periodById = new Map((await getAllPeriods()).map((p) => [p.key, p]));
  const { isDirty, briefOf } = makeGraphState(nodes, entryByDate, periodById);
  return graphSnapshot(nodes, isDirty, null, focusNodeId(nodes), briefOf);
}

// The graph overlay subscribes here; the pass publishes as nodes light up and clear.
let lastGraphSnapshot = null;
let graphOnUpdate = null;
function publishGraph(snap) { lastGraphSnapshot = snap; if (graphOnUpdate) graphOnUpdate(snap); }

// Pan/zoom for the graph. The transform lives on `stage` (whose innerHTML is swapped on each
// snapshot), so it survives live re-renders. Coordinates are viewport-relative; transform-origin
// is 0 0 so the zoom-toward-cursor math is a simple similarity transform.
function makePanZoom(viewport, stage, onZoom) {
  let scale = 1, tx = 0, ty = 0;
  const apply = () => { stage.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`; };
  // Semantic zoom: tell the view when the zoom settles so it can re-render at more/less detail.
  let zoomTimer = null;
  const notify = () => { if (!onZoom) return; clearTimeout(zoomTimer); zoomTimer = setTimeout(() => onZoom(scale), 140); };
  const clamp = (s) => Math.min(6, Math.max(0.2, s));
  const zoomAt = (factor, clientX, clientY) => {
    const rect = viewport.getBoundingClientRect();
    const px = clientX - rect.left, py = clientY - rect.top;
    const k = clamp(scale * factor) / scale;
    tx = px - (px - tx) * k; ty = py - (py - ty) * k; scale *= k; apply(); notify();
  };
  const center = () => { const r = viewport.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
  viewport.addEventListener("wheel", (e) => { e.preventDefault(); zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY); }, { passive: false });
  const pointers = new Map();
  let panning = false, lastX = 0, lastY = 0, pinchDist = 0;
  viewport.addEventListener("pointerdown", (e) => {
    pointers.set(e.pointerId, e); viewport.setPointerCapture(e.pointerId);
    if (pointers.size === 1) { panning = true; lastX = e.clientX; lastY = e.clientY; } else { panning = false; pinchDist = 0; }
  });
  viewport.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, e);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (pinchDist) zoomAt(dist / pinchDist, (a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
      pinchDist = dist;
    } else if (panning) { tx += e.clientX - lastX; ty += e.clientY - lastY; lastX = e.clientX; lastY = e.clientY; apply(); }
  });
  const end = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDist = 0;
    if (pointers.size === 1) { const p = [...pointers.values()][0]; panning = true; lastX = p.clientX; lastY = p.clientY; } else if (!pointers.size) panning = false;
  };
  viewport.addEventListener("pointerup", end);
  viewport.addEventListener("pointercancel", end);
  viewport.addEventListener("dblclick", () => { scale = 1; tx = 0; ty = 0; apply(); notify(); });
  apply();
  return {
    reset: () => { scale = 1; tx = 0; ty = 0; apply(); notify(); },
    zoomIn: () => { const [x, y] = center(); zoomAt(1.25, x, y); },
    zoomOut: () => { const [x, y] = center(); zoomAt(1 / 1.25, x, y); },
    getScale: () => scale,
  };
}

// The Graph tab: a pannable/zoomable live view of the node graph with dirty nodes highlighted.
export function initGraphView(root, { onOpen } = {}) {
  root.innerHTML = `
    <div class="graph-view">
      <div class="graph-head">
        <span class="graph-title">Summarization graph</span>
        <div class="graph-legend"><span class="gl clean">processed</span><span class="gl dirty">changed</span><span class="gl active">summarizing</span></div>
        <div class="graph-controls">
          <button class="gc-btn" type="button" data-act="out" aria-label="Zoom out">−</button>
          <button class="gc-btn" type="button" data-act="in" aria-label="Zoom in">+</button>
          <button class="gc-btn gc-reset" type="button" data-act="reset">Reset</button>
          <button class="gc-btn" type="button" data-act="full" aria-label="Full screen">⤢</button>
        </div>
      </div>
      <div class="graph-viewport"><div class="graph-stage"></div></div>
    </div>`;
  const gv = root.querySelector(".graph-view");
  const viewport = root.querySelector(".graph-viewport");
  const stage = root.querySelector(".graph-stage");
  // Semantic zoom: renders carry the current zoom, and a change in detail (how many nodes a row
  // shows / whether crowded rows are labeled) re-renders the live snapshot. `detailSig` buckets the
  // zoom so we only re-render when something visible would actually change.
  let currentZoom = 1, renderedSig = "";
  const detailSig = (z) => `${Math.round(z * 4)}|${z >= 1.6}`;
  const renderSnap = (snap) => { stage.innerHTML = renderGraphSvg({ ...snap, zoom: currentZoom }); renderedSig = detailSig(currentZoom); };
  const pz = makePanZoom(viewport, stage, (z) => {
    currentZoom = z;
    if (lastGraphSnapshot && detailSig(z) !== renderedSig) renderSnap(lastGraphSnapshot);
  });
  root.querySelector('[data-act="in"]').addEventListener("click", () => pz.zoomIn());
  root.querySelector('[data-act="out"]').addEventListener("click", () => pz.zoomOut());
  root.querySelector('[data-act="reset"]').addEventListener("click", () => pz.reset());
  root.querySelector('[data-act="full"]').addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else gv.requestFullscreen?.().catch(() => {});
  });
  // On rotate/resize, iOS Safari doesn't reflow the viewBox-scaled SVG on its own — re-render
  // the current graph and refit so landscape actually redraws.
  let refitTimer = null;
  const refit = () => {
    if (root.hidden) return;
    clearTimeout(refitTimer);
    refitTimer = setTimeout(() => { if (lastGraphSnapshot) renderSnap(lastGraphSnapshot); pz.reset(); }, 120);
  };
  window.addEventListener("resize", refit);
  window.addEventListener("orientationchange", refit);
  document.addEventListener("fullscreenchange", refit); // reflow when entering/leaving full screen

  // Tap a node → a quick preview (name + one-line summary) with an "Open ›" link into the Journal.
  const pop = document.createElement("div");
  pop.className = "graph-pop";
  pop.hidden = true;
  gv.appendChild(pop);
  let popNav = null;
  const hidePop = () => { pop.hidden = true; popNav = null; };
  viewport.addEventListener("click", (e) => {
    const nodeEl = e.target.closest(".gnode[data-node-id]");
    if (!nodeEl) { hidePop(); return; }
    const id = nodeEl.getAttribute("data-node-id");
    const node = (lastGraphSnapshot && lastGraphSnapshot.nodes || []).find((n) => n.id === id);
    if (!node) return;
    popNav = node.nav;
    pop.innerHTML = `<div class="graph-pop-name">${escapeHtml(node.label)}</div>`
      + `<div class="graph-pop-brief${node.brief ? "" : " muted"}">${escapeHtml(node.brief || "Not summarized yet.")}</div>`
      + (popNav ? `<button type="button" class="graph-pop-open">Open ›</button>` : "");
    const gvRect = gv.getBoundingClientRect();
    const c = nodeEl.querySelector("circle").getBoundingClientRect();
    pop.hidden = false;
    const px = c.left + c.width / 2 - gvRect.left;
    pop.style.left = Math.max(8, Math.min(gvRect.width - pop.offsetWidth - 8, px - pop.offsetWidth / 2)) + "px";
    pop.style.top = Math.max(8, c.bottom - gvRect.top + 8) + "px";
  });
  pop.addEventListener("click", (e) => {
    if (e.target.closest(".graph-pop-open") && popNav) { const nav = popNav; hidePop(); onOpen?.(nav); }
  });

  return {
    open: async () => {
      graphOnUpdate = renderSnap; // subscribe to live pass updates
      if (summarizing && lastGraphSnapshot) { renderSnap(lastGraphSnapshot); pz.reset(); return; }
      stage.innerHTML = `<p class="graph-empty">Loading…</p>`;
      // If the Journal hasn't been opened yet this session, load the data so the graph isn't empty.
      if (!Object.keys(journal.days).length && !allMemories.length) await load();
      renderSnap(await currentGraphSnapshot());
      pz.reset();
      autoSummarize(); // drive the pass so dirty nodes actually get summarized while you watch
    },
    close: () => { hidePop(); if (graphOnUpdate === renderSnap) graphOnUpdate = null; },
  };
}

// One background pass: summarize every period that's missing or stale, each level from
// the one below (weeks←days … life←decades). In-progress periods get a running summary
// that updates as entries are added and becomes final once the period ends.
async function runAutoPass() {
  const dates = Object.keys(journal.days).sort();
  const memories = allMemories;
  if (!dates.length && !memories.length) return;

  let changed = false, failed = 0;
  const limit = makeLimiter(AUTO_CONCURRENCY); // caps in-flight summarize calls for this pass
  // Live progress: one clear line — what's summarizing now, at which level, and how many are done.
  let doneCount = 0, totalCount = 0;
  const note = (label, type) => setProgress(
    `Summarizing <span class="sp-now">${escapeHtml(label)}</span>`
    + (type && LEVEL_WORD[type] ? ` <span class="sp-level">${LEVEL_WORD[type]}</span>` : "")
    + (totalCount ? ` <span class="sp-count">· ${doneCount} of ${totalCount} done</span>`
                  : (doneCount ? ` <span class="sp-count">· ${doneCount} done</span>` : ""))
  );

  // ---- The summarization graph + its dirty/ready calculus (shared with the graph overlay) ---
  const nodes = buildGraph();
  const node = (id) => nodes.get(id);
  // Preload entries (they hold the raw text) and periods so dirty-checks need no extra I/O.
  // process*() mutates these maps in place, so isDirty always reflects the freshest state.
  const entryByDate = new Map((await getAllEntries()).map((e) => [e.date, e]));
  const periodById = new Map((await getAllPeriods()).map((p) => [p.key, p]));
  const { memOf, childObj, inputHash, isDirty, isReady, briefOf } = makeGraphState(nodes, entryByDate, periodById);
  totalCount = [...nodes.keys()].filter(isDirty).length; // how many nodes this pass will summarize
  passTotal = totalCount; passDone = 0; // mirror to module scope for the "Writing the summary…" placeholder

  // Log only nodes that will make a REAL LLM call — leaves (day/memory) and multi-child rollups.
  // A single-child period copies up with no call, so it would just clutter the queue as "waiting".
  const jobIds = new Map();
  for (const id of nodes.keys()) {
    if (!isDirty(id)) continue;
    const n = node(id);
    const realCall = n.type === "day" || n.type === "memory" || n.children.length > 1 || !!(n.key && periodById.get(n.key)?.note);
    if (realCall) jobIds.set(id, logAdd(n.label, n.type));
  }

  // Prioritize the subtree the user is looking at so its "writing…" note clears first.
  const focusId = focusNodeId(nodes);
  const focusSet = (() => {
    const seen = new Set(); const stack = focusId ? [focusId] : [];
    while (stack.length) { const id = stack.pop(); if (seen.has(id) || !nodes.has(id)) continue; seen.add(id); for (const c of node(id).children) stack.push(c); }
    return seen;
  })();

  // Live graph state for the overlay: which nodes are dirty, and which are summarizing right now.
  const activeIds = new Set();
  const publish = () => publishGraph(graphSnapshot(nodes, isDirty, activeIds, focusId, briefOf));
  publish();

  // ---- Process one node --------------------------------------------------------------------
  const processDay = async (id) => {
    const iso = node(id).iso, cd = journal.days[iso], e = entryByDate.get(iso);
    const lv = await sumDayLevels(iso, e.raw, e.correction || "", e.entityRefs);
    const updated = withMode({ ...e, levels: lv, prose: { brief: lv.sentence, full: lv.summary }, outline: { brief: "", full: lv.outline }, updatedAt: Date.now() }, "prose");
    await putEntry(updated);
    entryByDate.set(iso, updated);
    journal.days[iso] = { ...cd, brief: updated.brief, full: updated.full, mode: "prose", levels: lv, reps: repsOf(updated) };
  };
  const processMemory = async (id) => {
    const m = memOf(id);
    const lv = await sumMemLevels(m);
    const updated = { ...m, levels: lv, prose: { brief: lv.sentence, full: lv.summary }, outline: { brief: "", full: lv.outline }, needsSummary: false };
    await putMemory(updated);
    const i = allMemories.findIndex((x) => x.id === m.id);
    if (i >= 0) allMemories[i] = updated;
  };
  const processPeriod = async (id) => {
    const n = node(id);
    await storePeriod(n.key, n.type, n.label, n.children.map(childObj), inputHash(id));
    periodById.set(n.key, await getPeriod(n.key));
  };
  const failedIds = new Set(); // failed this pass — skip so the loop can't spin; retried next pass
  const process = async (id) => {
    const n = node(id);
    // A period with a single child is a pure copy-up (storePeriod makes no model call), so don't
    // announce it as "Summarizing", light it up, or force a full re-render — it's instant, and the
    // end-of-pass render covers it. Real work (day/memory leaves, multi-child rollups) still shows.
    const copyUp = n.type !== "day" && n.type !== "memory" && n.children.length === 1 && !(n.key && periodById.get(n.key)?.note);
    const jid = jobIds.get(id);
    if (!copyUp) { note(n.label, n.type); activeIds.add(id); publish(); logSet(jid, "running"); }
    try {
      if (n.type === "day") await processDay(id);
      else if (n.type === "memory") await processMemory(id);
      else await processPeriod(id);
      doneCount++; passDone = doneCount;
      changed = true;
      logSet(jid, copyUp ? "copy" : "done");
      if (!copyUp) render();
    } catch (e) { failed++; failedIds.add(id); logSet(jid, "error", { error: (e && e.message) || "failed" }); }
    finally { if (!copyUp) { activeIds.delete(id); publish(); } }
  };

  // ---- The loop ----------------------------------------------------------------------------
  // Repeatedly take every dirty node whose children are all clean and summarize them
  // concurrently. Each round is a natural dependency wave (leaves first, Life last); the graph's
  // depth bounds the rounds. A node whose child failed stays dirty-but-not-ready and waits for
  // the backoff retry, so a parent is never summarized over an unsummarized child.
  for (;;) {
    const ready = [...nodes.keys()].filter((id) => !failedIds.has(id) && isDirty(id) && isReady(id));
    if (!ready.length) break;
    ready.sort((a, b) => (focusSet.has(b) ? 1 : 0) - (focusSet.has(a) ? 1 : 0));
    for (const id of ready) logSet(jobIds.get(id), "queued"); // ready, now waiting for a slot
    await Promise.all(ready.map((id) => limit(() => process(id))));
  }

  if (changed) render();
  setProgress(""); // pass done — hide the progress toast (a retry pass re-shows it)

  // Self-heal: if anything failed (timeout/error), retry on a growing backoff, up to a
  // cap so a genuinely broken API doesn't loop forever. A clean pass resets the counter.
  clearTimeout(retryTimer);
  if (failed > 0 && autoRetries < MAX_AUTO_RETRIES) {
    autoRetries++;
    retryTimer = setTimeout(() => autoSummarize(), 4000 * autoRetries);
  } else {
    autoRetries = 0;
  }
}

async function reloadAndRender() {
  await load();
  render();
  autoSummarize(); // background: summarize any newly-completed or edited periods
}

// One call → the whole ladder for a node (word→phrase→sentence→paragraph→summary→outline,
// plus a no-condense "rewrite" for leaf nodes). Voice/subject handled server-side.
async function nodeLevels(text, opts) {
  const style = localStorage.getItem("summary-style") || "";
  // `entities` (a small, per-leaf set) comes from opts; roll-ups pass none and let the children's
  // existing {{e:id|Name}} tokens flow through unchanged (see PRESERVE_TOKENS_NOTE on the server).
  return postSummarize({ mode: "levels", text, style, ...opts });
}
// Legacy fields kept in sync with levels so the existing rendering keeps working.
function legacyFromLevels(v) {
  return {
    brief: v.sentence || "", full: v.summary || "", outlineFull: v.outline || "",
    word: v.word || "", phrase: v.phrase || "", sentence: v.sentence || "", paragraph: v.paragraph || "",
  };
}
// A child's levels, deriving a minimal set from legacy fields on older records.
function childLevels(c) {
  if (c.levels) return c.levels;
  return { word: c.word || "", phrase: c.phrase || "", sentence: c.sentence || c.brief || "", paragraph: c.paragraph || c.brief || "", summary: c.full || "", outline: c.outlineFull || "", rewrite: "" };
}
function childPara(c) { const v = childLevels(c); return v.paragraph || v.summary || v.sentence || ""; }

// Leaf summaries (days, memories) — FAST: only the distilled rungs (word/phrase/sentence/
// paragraph). The heavy complete-summary + outline are generated lazily when a reader opens
// those folds (see generateLeafDetail). The memory's subject fixes its name/spelling.
// Leaves get the FULL ladder (summary + outline included) in the pass, so a day is ready to read
// the moment you reach it — no separate lazy "detail" call, no waiting after a click. (distilled:false
// uses LEVELS_SYSTEM, which returns word→paragraph PLUS the complete summary and outline in one call.)
async function sumDayLevels(date, text, correction = "", refs = []) {
  return nodeLevels(text, { type: "day", label: date, isLeaf: true, date, distilled: false, correction, entities: rosterFor(refs) });
}
async function sumMemLevels(m) {
  return nodeLevels(m.text, { type: "memory", label: m.label || String(m.startYear || ""), isLeaf: true, subject: m.subject || "", date: `${m.startYear || 2000}-01-01`, distilled: false, correction: m.correction || "", entities: rosterFor(m.entityRefs) });
}

// Roll-up input: prefer each child's FULL summary; step down to paragraph, then sentence,
// only if the combined text would be too large for the parent's call.
const ROLLUP_MAX_CHARS = 14000;
function rollupInput(children) {
  const steps = ["summary", "paragraph", "sentence", "phrase", "word"];
  for (const level of steps) {
    const joined = children.map((c) => { const v = childLevels(c); return `${c.date || c.label || ""}: ${v[level] || v.sentence || v.phrase || v.word || ""}`; }).join("\n\n");
    if (joined.length <= ROLLUP_MAX_CHARS || level === "word") return joined;
  }
  return "";
}

// Build one period from its children. Copy-up: a single child needs NO call — its levels
// are the period's. Otherwise summarize the children's chosen level. Stores levels + legacy.
async function storePeriod(key, type, label, children, hash) {
  // Preserve any note the reader attached to this roll-up; fold it into the summary as a correction.
  const note = (await getPeriod(key))?.note || "";
  let levels;
  if (children.length === 1 && !note) {
    levels = { ...childLevels(children[0]), rewrite: "" }; // copy-up (no note to apply, no call)
  } else {
    levels = await nodeLevels(rollupInput(children), { type, label, isLeaf: false, correction: note });
  }
  await putPeriod({ key, type, label, hash, levels, note, ...legacyFromLevels(levels) });
}


export function initCalendar(elements, { onEdit, onEditMemory, onAddMemory, onOpenEntity } = {}) {
  els = elements;
  onEditRequested = onEdit;
  onEditMemoryRequested = onEditMemory;
  onAddMemoryRequested = onAddMemory;
  wireReps(els.detailFull);
  wireReps(els.root);
  if (els.periodSummary) wireReps(els.periodSummary);
  // Tapping a name-link in any summary opens that entity's page (all its mentions, in time order).
  const entityClick = (e) => { const a = e.target.closest(".ent-link[data-eid]"); if (a) { e.stopPropagation(); onOpenEntity?.(a.dataset.eid); } };
  els.root.addEventListener("click", entityClick);
  els.detailFull.addEventListener("click", entityClick);
  if (els.periodSummary) els.periodSummary.addEventListener("click", entityClick);
  // Restore saved outline expansion whenever a node page (re)renders; save it when the reader
  // opens/closes an outline node (the `toggle` event doesn't bubble, so listen in the capture phase).
  // Also wire the per-node comment box's dictation mic once it (re)appears.
  new MutationObserver(() => {
    if (els.root.querySelector(".ol-node[data-ol-key]")) restoreOutline();
    const section = els.root.querySelector(".node-comment:not([data-wired])");
    if (section) {
      section.setAttribute("data-wired", "1");
      setupDictation(section.querySelector(".node-comment-mic"), section.querySelector(".node-comment-input"), section.querySelector(".node-comment-status"), () => {});
    }
  }).observe(els.root, { childList: true, subtree: true });
  els.root.addEventListener("toggle", (e) => {
    const d = e.target;
    if (d.classList && d.classList.contains("ol-node") && els.root.contains(d)) scheduleSaveOutline();
  }, true);
  setupFixSelection(); // select text on a node page → "Fix this" → correct it at the source
  // When the reader leaves an edit field, run any render that the summarization pass deferred.
  els.root.addEventListener("focusout", () => {
    setTimeout(() => { if (pendingRender && !isEditingNodeField()) render(); }, 0);
  });
  els.root.addEventListener("click", async (e) => {
    // Timeline bar → jump to that memory (works on decade/category/subject pages).
    const bar = e.target.closest(".mtl-bar[data-mem-id], .mtl-bar-label[data-mem-id]");
    if (bar) { goToMemory(bar.dataset.memId); return; }
    // "More"/"Less" zoom: swap the sentence for the full summary (generate it if lazy) and back.
    const zbtn = e.target.closest("[data-zoom='summary']");
    if (zbtn) {
      const zoomEl = zbtn.closest(".node-zoom");
      const sentenceEl = zoomEl.querySelector(".node-sentence");
      const completeEl = zoomEl.querySelector(".node-complete");
      if (zoomEl.dataset.state === "full") {
        completeEl.hidden = true; sentenceEl.hidden = false; zoomEl.dataset.state = "brief";
      } else {
        sentenceEl.hidden = true; completeEl.hidden = false; zoomEl.dataset.state = "full";
        if (zbtn.dataset.lazy) { zbtn.removeAttribute("data-lazy"); await generateLeafDetail(); }
      }
      return;
    }
    // Opening a lazy fold (the leaf outline) generates the detail on first open.
    if (e.target.closest(".node-fold[data-lazy] > summary")) { generateLeafDetail(); return; }
    // "Fix the summary" — re-summarize this leaf with the reader's correction note.
    const cbtn = e.target.closest(".correct-btn");
    if (cbtn) {
      const body = cbtn.closest(".node-fold-body");
      correctLeaf(body.querySelector(".correct-input").value.trim(), body.querySelector(".correct-status"));
      return;
    }
    // Comment box → add my take to this node and re-summarize.
    const addBtn = e.target.closest(".node-comment-add");
    if (addBtn) { addNodeComment(addBtn.closest(".node-comment")); return; }
    // Edit the verbatim transcript inline → swap the text for a textarea with Save / Cancel.
    const veditBtn = e.target.closest(".verbatim-edit");
    if (veditBtn) { beginVerbatimEdit(veditBtn.closest(".node-fold-body")); return; }
    const vsave = e.target.closest(".verbatim-save");
    if (vsave) { saveVerbatimEdit(vsave.closest(".node-fold-body")); return; }
    const vcancel = e.target.closest(".verbatim-cancel");
    if (vcancel) { render(); return; }
    // Generic element-link navigation (decade/year/month/week/day/category/subject/memory).
    const link = e.target.closest(".node-link");
    if (link) {
      const d = link.dataset;
      if (d.mem) goToMemory(d.mem);
      else if (d.category != null) { state.zoom = "category"; state.category = d.category; state.subject = null; render(); }
      else if (d.subject != null) { state.zoom = "subject"; state.subject = d.subject; render(); }
      else if (d.decade) navDown("decade", firstEntryDateIn("decade", d.decade));
      else if (d.year) navDown("year", firstEntryDateIn("year", d.year));
      else if (d.month) navDown("month", firstEntryDateIn("month", d.month));
      else if (d.week) navDown("week", d.week);
      else if (d.day) navDown("day", d.day);
      return;
    }
    const add = e.target.closest(".add-mem");
    if (add) { onAddMemoryRequested?.({ category: add.dataset.addCat || "", subject: add.dataset.addSubj || "" }); return; }
    const edit = e.target.closest(".mem-edit[data-mem-id]");
    if (edit) {
      const mem = allMemories.find((m) => m.id === edit.dataset.memId);
      if (mem) onEditMemoryRequested?.(mem);
      return;
    }
  });
  if (els.breadcrumb) els.breadcrumb.addEventListener("click", (e) => {
    const crumb = e.target.closest(".crumb[data-zoom]");
    if (!crumb) return;
    state.zoom = crumb.dataset.zoom; // go UP; focusDate stays (it's within every ancestor)
    render();
  });
  els.periodDelete.addEventListener("click", deletePeriodEntries);
  const navTo = (btn) => { if (btn.dataset.target) { state.focusDate = btn.dataset.target; render(); } };
  els.periodPrev.addEventListener("click", () => navTo(els.periodPrev));
  els.periodNext.addEventListener("click", () => navTo(els.periodNext));
  els.detailPrev.addEventListener("click", () => { if (els.detailPrev.dataset.target) openDetail(els.detailPrev.dataset.target); });
  els.detailNext.addEventListener("click", () => { if (els.detailNext.dataset.target) openDetail(els.detailNext.dataset.target); });
  els.detailModes.addEventListener("click", (e) => {
    const chip = e.target.closest(".mode-chip");
    if (chip) switchDetailMode(chip.dataset.mode);
  });
  els.detailEdit.addEventListener("click", () => {
    if (!detailIso) return;
    const iso = detailIso;
    closeDetail();
    onEditRequested?.(iso);
  });
  els.closeDetail.addEventListener("click", closeDetail);
  els.detailBackdrop.addEventListener("click", closeDetail);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDetail(); });

  return {
    async reload(focusDate, zoom) {
      if (zoom) state.zoom = zoom;
      if (focusDate) state.focusDate = focusDate;
      await reloadAndRender();
    },
    // Load data and start the background summarization pass without making the Journal the visible
    // view — used when landing straight on the Activity page (e.g. stepping into a fresh future).
    async prime() { await reloadAndRender(); },
    // Open the Journal on any graph node (from the graph's "Open ›" preview link).
    async showNode(nav) {
      if (!nav) return;
      if (nav.zoom === "memory") {
        const m = allMemories.find((x) => x.id === nav.memId);
        if (m) { state.category = catOf(m); state.subject = subjOf(m); state.zoom = "memory"; state.memoryId = nav.memId; }
      } else if (nav.zoom === "category") {
        state.zoom = "category"; state.category = nav.category; state.subject = null;
      } else if (nav.zoom === "subject") {
        state.zoom = "subject"; state.category = nav.category; state.subject = nav.subject;
      } else {
        state.zoom = nav.zoom; if (nav.focusDate) state.focusDate = nav.focusDate;
      }
      await reloadAndRender();
    },
    // Open the Journal on a memory's category/subject page and flash its card.
    async showMemory(mem) {
      state.category = catOf(mem);
      state.subject = subjOf(mem);
      state.zoom = state.subject ? "subject" : "category";
      await reloadAndRender();
      const id = mem.id ? ((window.CSS && CSS.escape) ? CSS.escape(mem.id) : mem.id) : "";
      const el = id && els.root.querySelector(`#mem-${id}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("mem-flash");
        setTimeout(() => el.classList.remove("mem-flash"), 1600);
      }
    },
  };
}
