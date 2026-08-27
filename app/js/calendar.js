// "Journal" view — the year / month / week zoom calendar, sourced from IndexedDB.
// Day summaries are made at capture time. Period summaries (week/month/year/decade/life)
// are generated automatically in the background: each completed period is summarized once
// it ends (a week when the next week starts, etc.), and higher levels update as their
// children change. No manual button — see autoSummarize().

import { getAllEntries, getEntry, putEntry, deleteEntry, getPeriod, getAllPeriods, putPeriod, deletePeriod, getAllMemories, putMemory, deleteMemory, storedToBlob } from "./db.js";
import { escapeHtml, renderFull, renderReps, wireReps, isOutlineText } from "./render.js";
import { withMode, availableModes, repsOf } from "./entry.js";
import { renderGraphSvg } from "./graph.js";
import { jkey } from "./journal.js";

const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Initial zoom = the "Opens on" setting (Settings › Journal); defaults to the latest week.
const state = { zoom: localStorage.getItem("journal-landing") || "week", focusDate: null, category: null, subject: null, memoryId: null };
let journal = { days: {}, dateRange: null };
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
      mode, modes: availableModes(e), reps: repsOf(e), images, levels: e.levels,
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
    <button type="button" class="detail-nav-btn day-delete" id="day-delete">Delete…</button>
  </div>`;
  const verbatim = (day.reps && day.reps.verbatim) || "";
  setLazyDay(day, iso);
  els.root.innerHTML = actions + nodeScaffold({ name: `${day.dayOfWeek} · ${formatDate(iso)}`, levels: levelsOf(day), images: imagesHtml, isLeaf: true, verbatim, correction: day.correction || "" });
  els.root.querySelector("#day-edit").addEventListener("click", () => onEditRequested?.(iso));
  els.root.querySelector("#day-delete").addEventListener("click", () => deleteDay(iso));
}

async function deleteDay(iso) {
  if (!confirm(`Delete the entry for ${formatDate(iso)}? This can't be undone.`)) return;
  await deleteEntry(iso);
  state.zoom = "week"; // back to the week it lived in
  await reloadAndRender();
}

function openDetail(iso) {
  const day = journal.days[iso];
  if (!day) return;
  detailIso = iso;
  els.detailDate.textContent = `${day.dayOfWeek} · ${formatDate(iso)}`;

  els.detailModes.hidden = true;
  els.detailBadge.hidden = true;
  els.detailBrief.textContent = day.brief;

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

async function deleteCurrent() {
  if (!detailIso) return;
  if (!confirm(`Delete the entry for ${formatDate(detailIso)}? This can't be undone.`)) return;
  await deleteEntry(detailIso);
  closeDetail();
  await reloadAndRender();
}

// Image URLs already shown on the current page — reset each render so no picture repeats within
// one page (e.g. several memories that fall back to the same portrait).
let shownImages = new Set();
function render() {
  shownImages = new Set();
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
  els.breadcrumb.innerHTML = crumbs.map((c, i) => (i === crumbs.length - 1)
    ? `<span class="crumb crumb-current">${escapeHtml(c.label)}</span>`
    : `<button type="button" class="crumb" data-zoom="${c.zoom}">${escapeHtml(c.label)}</button>`
  ).join(`<span class="crumb-sep" aria-hidden="true">›</span>`);
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
    return `<button type="button" class="node-link${showThumb ? " has-thumb" : ""}" ${attrs}>${thumb}<span class="node-link-text"><span class="node-link-name">${escapeHtml(it.label)}</span>${it.sentence ? `<span class="node-link-line">${escapeHtml(it.sentence)}</span>` : ""}</span></button>`;
  }).join("")}</div>`;
}
function nodeScaffold({ name, subtitle = "", levels = {}, elementsHtml = "", elementsLabel = "", images = "", isLeaf = false, verbatim = "", correction = "" }) {
  const v = levels || {};
  const summarizing = !v.sentence && !v.paragraph && !v.summary;
  // The sentence ZOOMS in place: a "Complete summary" toggle swaps it for the full summary
  // (rather than stacking below). Leaves generate that summary lazily on first open.
  const hasSummary = !!v.summary;
  const canSummary = hasSummary || isLeaf;
  const zoom = v.sentence
    ? `<div class="node-zoom" data-state="brief">`
      + `<p class="node-sentence">${escapeHtml(v.sentence)}</p>`
      + `<div class="node-complete" data-detail="summary" hidden>${hasSummary ? renderFull(v.summary) : `<p class="lazy-hint">Writing the full summary…</p>`}</div>`
      + (canSummary ? `<button type="button" class="zoom-btn" data-zoom="summary"${hasSummary ? "" : ` data-lazy="1"`}>Complete summary</button>` : "")
      + `</div>`
    : "";
  // Outline stays a fold below; for leaves it's generated lazily alongside the summary.
  const outlineFold = v.outline
    ? `<details class="node-fold"><summary>Outline</summary><div class="node-fold-body">${renderFull(v.outline)}</div></details>`
    : (isLeaf ? `<details class="node-fold" data-lazy="1"><summary>Outline</summary><div class="node-fold-body" data-detail="outline"><p class="lazy-hint">Open to build the outline…</p></div></details>` : "");
  return `${name ? `<h2 class="node-name">${escapeHtml(name)}</h2>` : ""}`
    + (subtitle ? `<p class="node-subtitle">${escapeHtml(subtitle)}</p>` : "")
    + (summarizing ? summarizingNote() : "")
    + (v.word ? `<p class="node-word">${escapeHtml(v.word)}</p>` : "")
    + (v.phrase ? `<p class="node-phrase">${escapeHtml(v.phrase)}</p>` : "")
    + zoom
    + images
    + (elementsHtml ? `${elementsLabel ? `<p class="nav-hint">${escapeHtml(elementsLabel)}</p>` : ""}${elementsHtml}` : "")
    + outlineFold
    + ((isLeaf && verbatim) ? `<details class="node-fold"><summary>Verbatim transcript</summary><div class="node-fold-body node-verbatim">${escapeHtml(verbatim)}</div></details>` : "")
    + (isLeaf ? `<details class="node-fold correct-fold"${correction ? " open" : ""}><summary>The summary isn't right?</summary><div class="node-fold-body">`
        + `<textarea class="correct-input" rows="2" placeholder="Say what's wrong — a name, a date, two things mixed up…">${escapeHtml(correction)}</textarea>`
        + `<button type="button" class="correct-btn">Fix the summary</button>`
        + `<p class="correct-status"></p></div></details>` : "");
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
  const sBody = els.root.querySelector('.node-complete[data-detail="summary"]');
  const oBody = els.root.querySelector('.node-fold-body[data-detail="outline"]');
  lazyBusy = true;
  const spin = `<p class="lazy-hint">✦ Writing…</p>`;
  if (sBody) sBody.innerHTML = spin;
  if (oBody) oBody.innerHTML = spin;
  try {
    const raw = await lazyLeaf.getRaw();
    if (!raw) {
      const msg = `<p class="lazy-hint">The full text isn't stored for this entry anymore.</p>`;
      if (sBody) sBody.innerHTML = msg;
      if (oBody) oBody.innerHTML = msg;
      return;
    }
    const style = localStorage.getItem("summary-style") || "";
    const d = await postSummarize({ mode: "detail", text: raw, style, correction: lazyLeaf.correction, ...lazyLeaf.ctx });
    await lazyLeaf.applyLevels({ summary: d.summary || "", outline: d.outline || "" });
    if (sBody) sBody.innerHTML = renderFull(d.summary || "");
    if (oBody) oBody.innerHTML = renderFull(d.outline || "");
    els.root.querySelectorAll("[data-lazy]").forEach((el) => el.removeAttribute("data-lazy"));
    lazyLeaf = null;
  } catch {
    const msg = `<p class="lazy-hint">Couldn't generate right now — tap again to retry.</p>`;
    if (sBody) sBody.innerHTML = msg;
    if (oBody) oBody.innerHTML = msg;
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

// A "working on the summary" banner, shown while an item is still just verbatim.
function summarizingNote() {
  return `<p class="summarizing-note">✦ Writing the summary… this usually takes 15–30 seconds. The page updates on its own when it's ready.</p>`;
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
    <button type="button" class="detail-nav-btn day-delete mem-del" data-mem-id="${m.id}">Delete…</button>
    ${addMemoryBtn(catOf(m), subjOf(m))}
  </div>`;
  setLazyMemory(m);
  els.root.innerHTML = actions + nodeScaffold({ name: name || m.subject || m.label || "Memory", subtitle: memYearRange(m), levels: levelsOf(m), images: imagesHtmlFrom(memImageUrls(m)), isLeaf: true, verbatim: m.text, correction: m.correction || "" });
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
  return {
    provider: localStorage.getItem("llm-provider") || "",
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
    if (!r.ok) throw new Error(`Server ${r.status}`);
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
  const inputHash = (id) => hashBriefs(node(id).children.map((cid) => ({ date: cid, brief: briefOf(cid) })));
  const isDirty = (id) => {
    const n = node(id);
    if (n.type === "day") { const e = entryByDate.get(n.iso), cd = journal.days[n.iso]; return !!(e && e.raw) && !(cd && cd.levels); }
    if (n.type === "memory") { const m = memOf(id); return !!m && (!m.levels || m.needsSummary); }
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
  let doneCount = 0;
  const note = (label, type) => setProgress(
    `Summarizing <span class="sp-now">${escapeHtml(label)}</span>`
    + (type && LEVEL_WORD[type] ? ` <span class="sp-level">${LEVEL_WORD[type]}</span>` : "")
    + (doneCount ? ` <span class="sp-count">· ${doneCount} done</span>` : "")
  );

  // ---- The summarization graph + its dirty/ready calculus (shared with the graph overlay) ---
  const nodes = buildGraph();
  const node = (id) => nodes.get(id);
  // Preload entries (they hold the raw text) and periods so dirty-checks need no extra I/O.
  // process*() mutates these maps in place, so isDirty always reflects the freshest state.
  const entryByDate = new Map((await getAllEntries()).map((e) => [e.date, e]));
  const periodById = new Map((await getAllPeriods()).map((p) => [p.key, p]));
  const { memOf, childObj, inputHash, isDirty, isReady, briefOf } = makeGraphState(nodes, entryByDate, periodById);

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
    const lv = await sumDayLevels(iso, e.raw, e.correction || "");
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
    note(n.label, n.type); // show this node as the one in progress
    activeIds.add(id); publish(); // light it up in the graph overlay
    try {
      if (n.type === "day") await processDay(id);
      else if (n.type === "memory") await processMemory(id);
      else await processPeriod(id);
      doneCount++;
      changed = true;
      render();
    } catch { failed++; failedIds.add(id); }
    finally { activeIds.delete(id); publish(); }
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
async function sumDayLevels(date, text, correction = "") {
  return nodeLevels(text, { type: "day", label: date, isLeaf: true, date, distilled: true, correction });
}
async function sumMemLevels(m) {
  return nodeLevels(m.text, { type: "memory", label: m.label || String(m.startYear || ""), isLeaf: true, subject: m.subject || "", date: `${m.startYear || 2000}-01-01`, distilled: true, correction: m.correction || "" });
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
  let levels;
  if (children.length === 1) {
    levels = { ...childLevels(children[0]), rewrite: "" };
  } else {
    levels = await nodeLevels(rollupInput(children), { type, label, isLeaf: false });
  }
  await putPeriod({ key, type, label, hash, levels, ...legacyFromLevels(levels) });
}


export function initCalendar(elements, { onEdit, onEditMemory, onAddMemory } = {}) {
  els = elements;
  onEditRequested = onEdit;
  onEditMemoryRequested = onEditMemory;
  onAddMemoryRequested = onAddMemory;
  wireReps(els.detailFull);
  wireReps(els.root);
  if (els.periodSummary) wireReps(els.periodSummary);
  els.root.addEventListener("click", async (e) => {
    // Timeline bar → jump to that memory (works on decade/category/subject pages).
    const bar = e.target.closest(".mtl-bar[data-mem-id], .mtl-bar-label[data-mem-id]");
    if (bar) { goToMemory(bar.dataset.memId); return; }
    // "Complete summary" zoom: swap the sentence for the full summary (generate it if lazy).
    const zbtn = e.target.closest(".zoom-btn[data-zoom='summary']");
    if (zbtn) {
      const zoomEl = zbtn.closest(".node-zoom");
      const sentenceEl = zoomEl.querySelector(".node-sentence");
      const completeEl = zoomEl.querySelector(".node-complete");
      if (zoomEl.dataset.state === "full") {
        completeEl.hidden = true; sentenceEl.hidden = false; zoomEl.dataset.state = "brief"; zbtn.textContent = "Complete summary";
      } else {
        sentenceEl.hidden = true; completeEl.hidden = false; zoomEl.dataset.state = "full"; zbtn.textContent = "Show sentence";
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
    // Generic element-link navigation (decade/year/month/week/day/category/subject/memory).
    const link = e.target.closest(".node-link");
    if (link) {
      const d = link.dataset;
      if (d.mem) goToMemory(d.mem);
      else if (d.category != null) { state.zoom = "category"; state.category = d.category; state.subject = null; render(); }
      else if (d.subject != null) { state.zoom = "subject"; state.subject = d.subject; render(); }
      else if (d.decade) { state.zoom = "decade"; state.focusDate = firstEntryDateIn("decade", d.decade); render(); }
      else if (d.year) { state.zoom = "year"; state.focusDate = firstEntryDateIn("year", d.year); render(); }
      else if (d.month) { state.zoom = "month"; state.focusDate = firstEntryDateIn("month", d.month); render(); }
      else if (d.week) { state.zoom = "week"; state.focusDate = d.week; render(); }
      else if (d.day) { state.zoom = "day"; state.focusDate = d.day; render(); }
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
    const del = e.target.closest(".mem-del[data-mem-id]");
    if (!del) return;
    if (!confirm("Delete this memory?")) return;
    await deleteMemory(del.dataset.memId);
    if (state.zoom === "memory") state.zoom = state.subject ? "subject" : "category"; // don't strand on a deleted memory
    await reloadAndRender();
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
  els.detailDelete.addEventListener("click", deleteCurrent);
  els.closeDetail.addEventListener("click", closeDetail);
  els.detailBackdrop.addEventListener("click", closeDetail);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDetail(); });

  return {
    async reload(focusDate, zoom) {
      if (zoom) state.zoom = zoom;
      if (focusDate) state.focusDate = focusDate;
      await reloadAndRender();
    },
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
