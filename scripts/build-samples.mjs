// Pre-bake "sample lives" so opening one in the app is instant (no model calls at runtime).
//
// For each subject it: (1) asks the model to invent the life (entries + memories), then (2) rolls
// the WHOLE summary ladder up — days/memories → weeks/subjects → months/categories → years →
// decades → life — by calling the app's own /api/summarize handler in-process (zero divergence
// from the live pipeline). The finished, fully-summarized bundle is written to
// app/data/samples/<slug>.json; the client loads it with seedBaked() and never re-summarizes.
//
// Usage:
//   node scripts/build-samples.mjs                 # build every curated subject that's missing
//   node scripts/build-samples.mjs --force         # rebuild all
//   node scripts/build-samples.mjs "Jimi Hendrix"  # build one arbitrary subject
//
// Needs a model key: app/.env.local (DEEPSEEK_API_KEY=…), same as the app.

import { readFile, writeFile, mkdir, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const APP = join(ROOT, "app");
const OUT_DIR = join(APP, "data", "samples");

// ---- Curated subjects (must mirror PICKS in app/js/samples.js) --------------------------------
const SUBJECTS = [
  { name: "Vladimir Nabokov", kind: "person" },
  { name: "Keanu Reeves", kind: "person" },
  { name: "Leonardo DiCaprio", kind: "person" },
  { name: "Jim Carrey", kind: "person" },
  { name: "Donald Trump", kind: "person" },
  { name: "Zohran Mamdani", kind: "person" },
  { name: "The Beatles", kind: "entity" },
  { name: "Saturday Night Live", kind: "entity" },
  { name: "The United States", kind: "entity" },
  { name: "Marvel Comics", kind: "entity" },
];
const slugify = (name) => String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

// ---- Load the model key from app/.env.local, then the real endpoint handler -------------------
async function loadEnv() {
  try {
    const env = await readFile(join(APP, ".env.local"), "utf8");
    for (const line of env.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* rely on ambient env */ }
}

// Call the app's /api/summarize handler in-process with a stub req/res (exact same code path the
// browser hits — same prompts, same JSON repair, same model config).
let handler;
async function api(body) {
  if (!handler) handler = (await import(join(APP, "api", "summarize.js"))).default;
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(obj) {
        if (this.statusCode >= 400) reject(new Error(obj && obj.error ? obj.error : `HTTP ${this.statusCode}`));
        else resolve(obj);
      },
    };
    handler({ method: "POST", body }, res).catch(reject);
  });
}
// A retrying wrapper — the model occasionally fails a JSON parse or times out.
async function apiRetry(body, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await api(body); }
    catch (e) { last = e; await new Promise((r) => setTimeout(r, 1500 * (i + 1))); }
  }
  throw last;
}

// ---- Date / label / bucket helpers (ported verbatim from app/js/calendar.js) -------------------
const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const parseDate = (iso) => new Date(iso + "T12:00:00");
const formatDate = (iso, style = "long") => parseDate(iso).toLocaleDateString("en-US", style === "long"
  ? { weekday: "long", month: "long", day: "numeric", year: "numeric" }
  : { month: "short", day: "numeric" });
const monthLabel = (key) => { const [y, m] = key.split("-").map(Number); return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" }); };
function sundayWeekStart(iso) { const d = parseDate(iso); d.setDate(d.getDate() - d.getDay()); return d.toISOString().slice(0, 10); }
const SUMMARY_VERSION = "5-levels";
function hashBriefs(children) {
  const s = SUMMARY_VERSION + "||" + children.map((d) => d.id + "|" + d.brief).join("~"); // style is "" for baked
  let h = 0; for (let k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) | 0;
  return String(h);
}
function makeBuckets(grouping, birthYear) {
  const life = grouping === "life" && birthYear != null;
  const start = (year) => {
    year = Number(year);
    if (life) { const age = year - birthYear; if (age <= 12) return birthYear; if (age <= 19) return birthYear + 13; return birthYear + Math.floor(age / 10) * 10; }
    return Math.floor(year / 10) * 10;
  };
  const label = (s) => {
    s = Number(s);
    if (life) { const age = s - birthYear; if (age <= 0) return "Childhood"; if (age === 13) return "Teenage years"; return `My ${age}s`; }
    return `${s}s`;
  };
  const key = (s) => (life ? "L" : "D") + Number(s);
  return { start, label, key };
}

// ---- Ladder helpers (ported from app/js/calendar.js) ------------------------------------------
function legacyFromLevels(v) {
  return { brief: v.sentence || "", full: v.summary || "", outlineFull: v.outline || "", word: v.word || "", phrase: v.phrase || "", sentence: v.sentence || "", paragraph: v.paragraph || "" };
}
const ROLLUP_MAX_CHARS = 14000;
function rollupInput(children) {
  for (const level of ["summary", "paragraph", "sentence", "phrase", "word"]) {
    const joined = children.map((c) => `${c.date || c.label || ""}: ${c.levels[level] || c.levels.sentence || c.levels.phrase || c.levels.word || ""}`).join("\n\n");
    if (joined.length <= ROLLUP_MAX_CHARS || level === "word") return joined;
  }
  return "";
}
// One node's full ladder from the endpoint (word→…→summary→outline).
async function levelsFor(text, opts) {
  const r = await apiRetry({ mode: "levels", text, style: "", distilled: false, ...opts });
  return { word: r.word || "", phrase: r.phrase || "", sentence: r.sentence || "", paragraph: r.paragraph || "", summary: r.summary || "", outline: r.outline || "", rewrite: "" };
}
// Build one period from its children: single child copies up (no call); else summarize.
async function storePeriod(key, type, label, children) {
  const levels = children.length === 1
    ? { ...children[0].levels, rewrite: "" }
    : await levelsFor(rollupInput(children), { type, label, isLeaf: false });
  return { key, type, label, hash: hashBriefs(children), levels, ...legacyFromLevels(levels) };
}

// ---- Build one subject's bundle ---------------------------------------------------------------
async function buildSubject({ name, kind }) {
  const id = slugify(name);
  process.stdout.write(`\n▶ ${name} (${id})\n  generating the life… `);
  const gen = await apiRetry({ mode: "generate", subject: name, kindHint: kind });
  const meta = gen.meta || {};
  const grouping = meta.grouping === "calendar" ? "calendar" : (meta.kind === "entity" ? "calendar" : "life");
  const birthYear = meta.kind === "person" ? (meta.birthYear ?? null) : null;
  const B = makeBuckets(grouping, birthYear);
  const now = Date.now();

  const entries = (gen.entries || []).filter((e) => e && e.date && e.text).sort((a, b) => a.date.localeCompare(b.date));
  const memories = (gen.memories || []).filter((m) => m && m.text).map((m, i) => ({ ...m, id: `mem-${id}-${i}` }));
  console.log(`${entries.length} entries, ${memories.length} memories`);

  // Concurrency pool for the many level calls.
  const pool = (items, n, fn) => new Promise((resolve, reject) => {
    let i = 0, active = 0, done = 0; const out = new Array(items.length);
    const next = () => {
      if (done === items.length) return resolve(out);
      while (active < n && i < items.length) {
        const idx = i++; active++;
        Promise.resolve(fn(items[idx], idx)).then((v) => { out[idx] = v; active--; done++; process.stdout.write("."); next(); }).catch(reject);
      }
    };
    next();
  });

  // ---- Leaves ----
  process.stdout.write("  summarizing days     ");
  const dayLevels = {};
  await pool(entries, 4, async (e) => { dayLevels[e.date] = await levelsFor(e.text, { type: "day", label: formatDate(e.date, "short"), date: e.date }); });
  process.stdout.write("\n  summarizing memories ");
  const memLevels = {};
  await pool(memories, 4, async (m) => { memLevels[m.id] = await levelsFor(m.text, { type: "memory", label: m.label || String(m.startYear || ""), subject: m.subject || "", date: `${m.startYear || 2000}-01-01` }); });
  process.stdout.write("\n");

  // Finished leaf records + child descriptors (id/date/label/levels) used by roll-ups and hashing.
  const entryRecords = entries.map((e) => {
    const lv = dayLevels[e.date];
    return applyMode({
      category: "journal", subject: "today", date: e.date, dayOfWeek: DOW[parseDate(e.date).getDay()],
      raw: e.text, rawSavedAt: now, createdAt: now, updatedAt: now, id: e.date, kind: "journal",
      levels: lv, prose: { brief: lv.sentence, full: lv.summary }, outline: { brief: "", full: lv.outline },
    });
  });
  const memoryRecords = memories.map((m) => {
    const lv = memLevels[m.id];
    return {
      category: m.category, subject: m.subject, startYear: m.startYear, endYear: m.endYear, label: m.label, text: m.text,
      levels: lv, prose: { brief: lv.sentence, full: lv.summary }, outline: { brief: "", full: lv.outline },
      needsSummary: false, createdAt: now, updatedAt: now, id: m.id, kind: "memory",
    };
  });
  const dayChild = (iso) => ({ id: "DAY:" + iso, date: iso, brief: dayLevels[iso].sentence, levels: dayLevels[iso] });
  const memChild = (m) => ({ id: "MEM:" + m.id, date: m.label || String(m.startYear || ""), brief: memLevels[m.id].sentence, levels: memLevels[m.id] });
  const perChild = (p) => ({ id: p.key, date: p.label, brief: p.levels.sentence, levels: p.levels });

  const periods = [];
  const store = async (...args) => { const p = await storePeriod(...args); periods.push(p); return p; };

  const dates = entries.map((e) => e.date);
  const catOf = (m) => (m.category || "").trim() || "Uncategorized";
  const subjOf = (m) => (m.subject || "").trim();

  // ---- Weeks ← days ----
  const weekMap = new Map();
  for (const iso of dates) { const w = sundayWeekStart(iso); (weekMap.get(w) || weekMap.set(w, []).get(w)).push(iso); }
  const weekRecs = {};
  for (const [w, isos] of weekMap) weekRecs[w] = await store("W" + w, "week", `Week of ${formatDate(w, "short")}`, isos.sort().map(dayChild));

  // ---- Subjects ← memories ----
  const cats = [...new Set(memories.map(catOf))];
  const subRecs = {};
  for (const cat of cats) {
    const subs = [...new Set(memories.filter((m) => catOf(m) === cat).map(subjOf).filter(Boolean))];
    for (const subj of subs) {
      const kids = memories.filter((m) => catOf(m) === cat && subjOf(m) === subj);
      subRecs["SUB:" + cat + " " + subj] = await store("SUB:" + cat + " " + subj, "subject", subj, kids.map(memChild));
    }
  }

  // ---- Months ← weeks ----
  const monthKeys = [...new Set(dates.map((d) => d.slice(0, 7)))];
  const monthRecs = {};
  for (const mk of monthKeys) {
    const wk = [...new Set(dates.filter((d) => d.startsWith(mk)).map(sundayWeekStart))].sort();
    monthRecs[mk] = await store("M" + mk, "month", monthLabel(mk), wk.map((w) => perChild(weekRecs[w])));
  }

  // ---- Categories ← subjects + direct memories ----
  const catRecs = {};
  for (const cat of cats) {
    const subs = [...new Set(memories.filter((m) => catOf(m) === cat).map(subjOf).filter(Boolean))];
    const direct = memories.filter((m) => catOf(m) === cat && !subjOf(m));
    const kids = [...subs.map((s) => perChild(subRecs["SUB:" + cat + " " + s])), ...direct.map(memChild)];
    catRecs["CAT:" + cat] = await store("CAT:" + cat, "category", cat, kids);
  }

  // ---- Years ← months + memories(startYear) ----
  const yearSet = new Set([...dates.map((d) => d.slice(0, 4)), ...memories.filter((m) => m.startYear != null).map((m) => String(m.startYear))]);
  const years = [...yearSet].sort();
  const yearRecs = {};
  for (const y of years) {
    const kids = [
      ...monthKeys.filter((mk) => mk.startsWith(y)).sort().map((mk) => perChild(monthRecs[mk])),
      ...memories.filter((m) => String(m.startYear) === y).map(memChild),
    ];
    if (kids.length) yearRecs[y] = await store("Y" + y, "year", y, kids);
  }

  // ---- Decades ← years ----
  const decMap = new Map();
  for (const y of Object.keys(yearRecs)) { const d = B.start(+y); (decMap.get(d) || decMap.set(d, []).get(d)).push(y); }
  const decRecs = {};
  for (const [dd, ys] of [...decMap].sort((a, b) => a[0] - b[0])) decRecs[dd] = await store(B.key(dd), "decade", B.label(dd), ys.sort().map((y) => perChild(yearRecs[y])));

  // ---- Life ← decades + categories ----
  const lifeKids = [...Object.keys(decRecs).map((dd) => perChild(decRecs[dd])), ...cats.map((c) => perChild(catRecs["CAT:" + c]))];
  if (lifeKids.length) await store("LIFE", "life", "A life", lifeKids);

  const bundle = {
    version: 1, sample: true, builtAt: new Date().toISOString(),
    meta: { title: meta.title || name, kind: meta.kind || kind, grouping, birthYear, startYear: meta.startYear ?? birthYear ?? null },
    entries: entryRecords, memories: memoryRecords, periods,
  };
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, `${id}.json`), JSON.stringify(bundle));
  console.log(`  ✓ wrote app/data/samples/${id}.json  (${entryRecords.length} days, ${memoryRecords.length} memories, ${periods.length} periods)`);
  return id;
}

// ---- entry.js withMode, ported (mode/brief/full mirrored onto the record) ---------------------
function deriveBrief(text) {
  const clean = String(text).replace(/\s+/g, " ").trim();
  const s = (clean.match(/^.*?[.!?](?=\s|$)/) || [clean])[0];
  return s.length > 100 ? (s.slice(0, 100).replace(/\s\S*$/, "") + "…") : s;
}
function applyMode(entry) {
  // Baked entries always have prose → prose mode; mirror brief/full/summarized like withMode("prose").
  const full = entry.prose?.full || "";
  return { ...entry, mode: "prose", brief: entry.prose?.brief || deriveBrief(full), full, summarized: true };
}

// ---- Main -------------------------------------------------------------------------------------
async function main() {
  await loadEnv();
  if (!process.env.DEEPSEEK_API_KEY) { console.error("⚠  No DEEPSEEK_API_KEY (add it to app/.env.local)."); process.exit(1); }
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const named = args.filter((a) => !a.startsWith("--"));

  let todo;
  if (named.length) todo = named.map((n) => ({ name: n, kind: "person" }));
  else {
    await mkdir(OUT_DIR, { recursive: true });
    const have = new Set((existsSync(OUT_DIR) ? await readdir(OUT_DIR) : []).map((f) => f.replace(/\.json$/, "")));
    todo = SUBJECTS.filter((s) => force || !have.has(slugify(s.name)));
  }
  if (!todo.length) { console.log("Nothing to build — all bundles present (use --force to rebuild)."); return; }

  console.log(`Building ${todo.length} sample ${todo.length === 1 ? "life" : "lives"}…`);
  const built = [];
  for (const s of todo) {
    try { built.push(await buildSubject(s)); }
    catch (e) { console.error(`  ✗ ${s.name}: ${e.message}`); }
  }
  console.log(`\nDone. Built: ${built.join(", ") || "(none)"}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
