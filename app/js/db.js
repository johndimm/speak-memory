// IndexedDB wrapper. Everything the user sees lives here, on this device's browser.
//
// Storage is unified: journal entries and memories are both rows in ONE `items` store,
// distinguished by `kind` ("journal" | "memory"). A journal item is keyed by its date
// ("2026-08-03"); a memory keeps its own generated id. The old per-kind stores (`entries`,
// `memories`) are migrated into `items` once and then left in place as an untouched backup.
//   items:   { id, kind, category, subject, ... }  (journal: id=date; memory: id=uuid)
//   periods: cached week/month/year/… summaries  { key, type, label, brief, full, hash, levels }

import { dbNameFor, isFutureJournal, BASE_DB_NAME } from "./journal.js";

// The active journal's database (your own, or an isolated "sample life"). Fixed for the life of
// the page — switching journals reloads, so this is re-read fresh each load.
const DB_NAME = dbNameFor();
const DB_VERSION = 3;
const ITEMS = "items";

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Keep the legacy stores around (they're the migration source + a backup); add `items`.
      if (!db.objectStoreNames.contains("entries")) db.createObjectStore("entries", { keyPath: "date" });
      if (!db.objectStoreNames.contains("memories")) db.createObjectStore("memories", { keyPath: "id" });
      if (!db.objectStoreNames.contains("periods")) db.createObjectStore("periods", { keyPath: "key" });
      if (!db.objectStoreNames.contains(ITEMS)) db.createObjectStore(ITEMS, { keyPath: "id" });
    };
    req.onsuccess = () => {
      const db = req.result;
      // Populate `items` from the legacy stores on first run of this version, then resolve.
      migrateToItems(db).catch((e) => console.warn("items migration skipped:", e)).finally(() => resolve(db));
    };
    req.onerror = () => reject(req.error);
    // If another tab holds an older version open, the upgrade blocks and neither success
    // nor error fires — surface it instead of hanging forever.
    req.onblocked = () => reject(new Error("Storage is blocked — close other tabs of this app and try again."));
  });
  dbPromise.catch(() => { dbPromise = null; }); // let a failed open be retried
  return dbPromise;
}

// Copy legacy entries + memories into `items`, but only when `items` is still empty (i.e. the
// first launch after the storage change). Non-destructive: the old stores are left intact.
function migrateToItems(db) {
  const getAll = (store) => new Promise((res, rej) => {
    if (!db.objectStoreNames.contains(store)) return res([]);
    const r = db.transaction(store, "readonly").objectStore(store).getAll();
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => rej(r.error);
  });
  const count = () => new Promise((res, rej) => {
    const r = db.transaction(ITEMS, "readonly").objectStore(ITEMS).count();
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return count().then((n) => {
    if (n > 0) return; // already migrated (items is the source of truth now)
    return Promise.all([getAll("entries"), getAll("memories")]).then(([entries, memories]) => {
      if (!entries.length && !memories.length) return;
      return new Promise((res, rej) => {
        const t = db.transaction(ITEMS, "readwrite");
        const s = t.objectStore(ITEMS);
        for (const e of entries) s.put({ category: "journal", subject: "today", ...e, id: e.date, kind: "journal" });
        for (const m of memories) s.put({ ...m, kind: "memory" });
        t.oncomplete = () => res();
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error);
      });
    });
  });
}

// Populate a DIFFERENT journal's database (a freshly-generated sample life) without switching to
// it. Opens the named database, creates the same stores, and writes generated entries + memories
// straight into `items`; the normal background pass summarizes them once that journal is opened.
export function seedJournal(dbName, { entries = [], memories = [], entities = [], pastEntries = [] }) {
  const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "m" + Date.now() + Math.random().toString(36).slice(2));
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("entries")) db.createObjectStore("entries", { keyPath: "date" });
      if (!db.objectStoreNames.contains("memories")) db.createObjectStore("memories", { keyPath: "id" });
      if (!db.objectStoreNames.contains("periods")) db.createObjectStore("periods", { keyPath: "key" });
      if (!db.objectStoreNames.contains(ITEMS)) db.createObjectStore(ITEMS, { keyPath: "id" });
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("Storage is blocked — close other tabs of this app and try again."));
    req.onsuccess = () => {
      const db = req.result;
      const t = db.transaction(ITEMS, "readwrite");
      const s = t.objectStore(ITEMS);
      const now = Date.now();
      for (const e of entries) {
        if (!e || !e.date || !e.text) continue;
        const dow = DOW[new Date(e.date + "T12:00:00").getDay()] || "";
        s.put({ category: "journal", subject: "today", date: e.date, dayOfWeek: dow, raw: e.text, rawSavedAt: now, createdAt: now, updatedAt: now, id: e.date, kind: "journal" });
      }
      for (const m of memories) {
        if (!m || !m.text) continue;
        s.put({ ...m, id: uid(), kind: "memory", needsSummary: true, createdAt: now, updatedAt: now });
      }
      // Seed the base cast (people/animals/places) so a future starts knowing them; imagined new
      // names get created into this future's own DB only, never back into the base (separate DBs).
      for (const en of entities) {
        if (!en || !en.id || !en.canonical) continue;
        s.put({ ...en, kind: "entity" });
      }
      // The real past, carried in fully-summarized and read-only (a future is a sample journal, so
      // nothing here is editable). This makes a future a continuation of your actual life, not an
      // isolated set of only-future days — the Journal and Timeline span past → future.
      for (const pe of pastEntries) {
        if (!pe || !pe.date) continue;
        s.put({ ...pe, id: pe.date, kind: "journal", fromPast: true });
      }
      t.oncomplete = () => { db.close(); resolve(); };
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    };
  });
}

// Load a fully pre-summarized sample bundle into its own database: finished entries + memories
// (each already carrying its `levels` ladder) plus the rolled-up period summaries. Nothing is left
// dirty, so the client renders it instantly and never calls the model (the journal is flagged
// "baked" so the background pass is skipped). Records already carry their id/kind/key.
export function seedBaked(dbName, { entries = [], memories = [], periods = [] }) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("entries")) db.createObjectStore("entries", { keyPath: "date" });
      if (!db.objectStoreNames.contains("memories")) db.createObjectStore("memories", { keyPath: "id" });
      if (!db.objectStoreNames.contains("periods")) db.createObjectStore("periods", { keyPath: "key" });
      if (!db.objectStoreNames.contains(ITEMS)) db.createObjectStore(ITEMS, { keyPath: "id" });
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("Storage is blocked — close other tabs of this app and try again."));
    req.onsuccess = () => {
      const db = req.result;
      const t = db.transaction([ITEMS, "periods"], "readwrite");
      const items = t.objectStore(ITEMS);
      const periodStore = t.objectStore("periods");
      items.clear(); periodStore.clear(); // re-seed cleanly (an updated bundle replaces the old one)
      for (const e of entries) if (e && e.id) items.put({ ...e, kind: "journal" });
      for (const m of memories) if (m && m.id) items.put({ ...m, kind: "memory" });
      for (const p of periods) if (p && p.key) periodStore.put(p);
      t.oncomplete = () => { db.close(); resolve(); };
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    };
  });
}

function tx(store, mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        let result;
        Promise.resolve(fn(s)).then((r) => {
          result = r;
        });
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const kindOf = (i) => i.kind || (i.date ? "journal" : "memory"); // defensive for any unlabeled row
const ownItems = () => tx(ITEMS, "readonly", (s) => reqToPromise(s.getAll())).then((r) => r || []);

// ---- A Future sees your real past, live and read-only (nothing is ever copied) -----------
// In a Future, every read also pulls your own journal's database and merges it in, marked
// `fromPast`. Writes only ever go to the Future's own database, and never for a past item — so
// the past can't be copied into (or changed from) a Future. Pure-past summaries (periods) are
// read from your journal too, so they're reused, not redone.
const OVERLAY = isFutureJournal();
let baseDbPromise = null;
function openBase() {
  if (!baseDbPromise) {
    baseDbPromise = new Promise((resolve) => {
      const req = indexedDB.open(BASE_DB_NAME); // no version → never upgrades your journal from here
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
  }
  return baseDbPromise;
}
async function baseAll(store) {
  if (!OVERLAY) return [];
  const db = await openBase();
  if (!db || !db.objectStoreNames.contains(store)) return [];
  return new Promise((res) => {
    const r = db.transaction(store, "readonly").objectStore(store).getAll();
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => res([]);
  });
}
async function baseGet(store, key) {
  if (!OVERLAY) return undefined;
  const db = await openBase();
  if (!db || !db.objectStoreNames.contains(store)) return undefined;
  return new Promise((res) => {
    const r = db.transaction(store, "readonly").objectStore(store).get(key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => res(undefined);
  });
}
let baseIds = null; // ids of your real items — never written from a Future
async function isBaseId(id) {
  if (!OVERLAY) return false;
  if (!baseIds) baseIds = new Set((await baseAll(ITEMS)).map((i) => i.id));
  return baseIds.has(id);
}
// Older Futures were seeded with a COPY of the past; drop those copies once (the live past replaces them).
let cleaned = !OVERLAY;
async function dropPastCopies() {
  if (cleaned) return;
  cleaned = true;
  const base = new Set((await baseAll(ITEMS)).map((i) => i.id));
  const copies = (await ownItems()).filter((i) => i.fromPast || (base.has(i.id) && (i.kind === "journal" || i.kind === "entity")));
  if (copies.length) await tx(ITEMS, "readwrite", (s) => Promise.all(copies.map((i) => reqToPromise(s.delete(i.id)))));
}
// A Future may have made its OWN card for someone you already have (its "Luann" vs your Luann).
// Same name → same person: the Future's card folds into yours, and its references are re-pointed.
const normName = (n) => String(n || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
let dupTo = new Map(); // the Future's entity id → your entity id
function foldDuplicates(mine, past) {
  const yours = new Map();
  for (const e of past) if (kindOf(e) === "entity") for (const n of [e.canonical, ...(e.aliases || [])]) { const k = normName(n); if (k && !yours.has(k)) yours.set(k, e.id); }
  dupTo = new Map();
  for (const e of mine) if (kindOf(e) === "entity") { const to = yours.get(normName(e.canonical)); if (to && to !== e.id) dupTo.set(e.id, to); }
}
const remapRefs = (i) => (Array.isArray(i.entityRefs) && i.entityRefs.some((r) => dupTo.has(r))
  ? { ...i, entityRefs: [...new Set(i.entityRefs.map((r) => dupTo.get(r) || r))] } : i);

async function getAllItems() {
  if (!OVERLAY) return ownItems();
  await dropPastCopies();
  const [mine, past] = await Promise.all([ownItems(), baseAll(ITEMS)]);
  foldDuplicates(mine, past);
  const byId = new Map(past.map((i) => [i.id, { ...i, fromPast: true }]));
  for (const i of mine) {
    if (byId.has(i.id) || dupTo.has(i.id)) continue; // never shadow the past; folded duplicates drop out
    byId.set(i.id, remapRefs(i));
  }
  return [...byId.values()];
}
// A write from a Future: its own items only; the past is read-only.
async function writable(id) { return !(await isBaseId(id)); }

// ---- Journal entries (kind "journal", keyed by date) -----------------------------------
export async function getEntry(date) {
  const past = await baseGet(ITEMS, date);
  if (past && kindOf(past) === "journal") return { ...past, fromPast: true };
  return tx(ITEMS, "readonly", (s) => reqToPromise(s.get(date))).then((i) => (i && kindOf(i) === "journal" ? i : undefined));
}

export function getAllEntries() {
  return getAllItems().then((rows) =>
    rows.filter((i) => kindOf(i) === "journal").sort((a, b) => String(a.date).localeCompare(String(b.date))),
  );
}

export async function putEntry(entry) {
  if (entry.fromPast || !(await writable(entry.date))) return; // the past is read-only in a Future
  const item = { category: "journal", subject: "today", ...entry, id: entry.date, kind: "journal" };
  return tx(ITEMS, "readwrite", (s) => reqToPromise(s.put(item)));
}

export async function deleteEntry(date) {
  if (!(await writable(date))) return;
  return tx(ITEMS, "readwrite", (s) => reqToPromise(s.delete(date)));
}

// iOS Safari can't reliably store Blob/File objects in IndexedDB ("Failed to write
// blobs to disk"). Store bytes as an ArrayBuffer instead, and rebuild the Blob on read.
export async function photoToStored(blob) {
  return { type: blob.type || "image/jpeg", data: await blob.arrayBuffer() };
}
export function storedToBlob(photo) {
  if (photo instanceof Blob) return photo; // legacy entries stored as Blobs
  return new Blob([photo.data], { type: photo.type || "image/jpeg" });
}

// Raw text is kept for the most recent N entries so summaries can be regenerated; older
// raw is physically thrown away (prose/outline summaries are always kept).
export const RAW_KEEP_COUNT = 40;

export async function purgeRaw(keep = RAW_KEEP_COUNT) {
  // Only drop raw from entries that already have a generated complete summary — otherwise the
  // lazy "Complete summary"/"Outline" generation would have nothing to work from.
  const rows = (await getAllEntries()).filter((e) => e.raw && e.levels && e.levels.summary);
  if (rows.length <= keep) return;
  const drop = rows.sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(0, rows.length - keep);
  for (const e of drop) {
    delete e.raw;
    delete e.rawSavedAt;
    await putEntry(e);
  }
}

export async function clearAllEntries() {
  // Remove journal items + the derived period cache (memories are cleared separately).
  const journals = (await getAllItems()).filter((i) => kindOf(i) === "journal");
  await tx(ITEMS, "readwrite", (s) => Promise.all(journals.map((i) => reqToPromise(s.delete(i.id)))));
  await tx("periods", "readwrite", (s) => reqToPromise(s.clear()));
}

// ---- Periods (derived summary cache) ---------------------------------------------------
// A Future's own period summaries (spanning past → future) win; pure-past ones come from your
// journal, so they're reused as-is when their inputs match.
export async function getPeriod(key) {
  const mine = await tx("periods", "readonly", (s) => reqToPromise(s.get(key)));
  return mine || (await baseGet("periods", key));
}

export async function getAllPeriods() {
  const mine = await tx("periods", "readonly", (s) => reqToPromise(s.getAll())).then((r) => r || []);
  if (!OVERLAY) return mine;
  const byKey = new Map((await baseAll("periods")).map((p) => [p.key, p]));
  for (const p of mine) byKey.set(p.key, p);
  return [...byKey.values()];
}

export function putPeriod(period) {
  return tx("periods", "readwrite", (s) => reqToPromise(s.put(period)));
}

export function deletePeriod(key) {
  return tx("periods", "readwrite", (s) => reqToPromise(s.delete(key)));
}

export function clearAllPeriods() {
  return tx("periods", "readwrite", (s) => reqToPromise(s.clear()));
}

// ---- Memories (kind "memory", keyed by their own id) -----------------------------------
export async function putMemory(m) {
  if (m.fromPast || !(await writable(m.id))) return; // the past is read-only in a Future
  return tx(ITEMS, "readwrite", (s) => reqToPromise(s.put({ ...m, kind: "memory" })));
}
export function getAllMemories() {
  return getAllItems().then((r) => r.filter((i) => kindOf(i) === "memory"));
}
export async function deleteMemory(id) {
  if (!(await writable(id))) return;
  return tx(ITEMS, "readwrite", (s) => reqToPromise(s.delete(id)));
}
export async function clearAllMemories() {
  const mems = (await getAllItems()).filter((i) => kindOf(i) === "memory");
  await tx(ITEMS, "readwrite", (s) => Promise.all(mems.map((i) => reqToPromise(s.delete(i.id)))));
}

// ---- Entities (kind "entity") — people, animals, places, things a journal refers to. -----
// Each has a canonical name plus aliases, so every reference resolves to one identity ("Ghost"
// and "Baby Kitty" are the same cat). Stored in the same ITEMS store, so seeding/migration/export
// carry them along. Entries carry an `entityRefs: [entityId]` list of who/what they mention.
export function getAllEntities() {
  return getAllItems().then((r) => r.filter((i) => kindOf(i) === "entity"));
}
export async function getEntity(id) {
  if (OVERLAY && dupTo.has(id)) id = dupTo.get(id); // a folded duplicate opens your real card
  const past = await baseGet(ITEMS, id);
  if (past && kindOf(past) === "entity") return { ...past, fromPast: true };
  return tx(ITEMS, "readonly", (s) => reqToPromise(s.get(id))).then((i) => (i && kindOf(i) === "entity" ? i : undefined));
}
export async function putEntity(ent) {
  if (ent.fromPast || !(await writable(ent.id))) return; // your real names are read-only in a Future
  return tx(ITEMS, "readwrite", (s) => reqToPromise(s.put({ ...ent, kind: "entity" })));
}
export async function deleteEntity(id) {
  if (!(await writable(id))) return;
  return tx(ITEMS, "readwrite", (s) => reqToPromise(s.delete(id)));
}
export async function clearAllEntities() {
  const ents = (await getAllItems()).filter((i) => kindOf(i) === "entity");
  await tx(ITEMS, "readwrite", (s) => Promise.all(ents.map((i) => reqToPromise(s.delete(i.id)))));
}
