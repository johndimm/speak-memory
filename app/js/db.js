// IndexedDB wrapper. Everything the user sees lives here, on this device's browser.
//
// Storage is unified: journal entries and memories are both rows in ONE `items` store,
// distinguished by `kind` ("journal" | "memory"). A journal item is keyed by its date
// ("2026-08-03"); a memory keeps its own generated id. The old per-kind stores (`entries`,
// `memories`) are migrated into `items` once and then left in place as an untouched backup.
//   items:   { id, kind, category, subject, ... }  (journal: id=date; memory: id=uuid)
//   periods: cached week/month/year/… summaries  { key, type, label, brief, full, hash, levels }

import { dbNameFor } from "./journal.js";

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
export function seedJournal(dbName, { entries = [], memories = [] }) {
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
const getAllItems = () => tx(ITEMS, "readonly", (s) => reqToPromise(s.getAll())).then((r) => r || []);

// ---- Journal entries (kind "journal", keyed by date) -----------------------------------
export function getEntry(date) {
  return tx(ITEMS, "readonly", (s) => reqToPromise(s.get(date))).then((i) => (i && kindOf(i) === "journal" ? i : undefined));
}

export function getAllEntries() {
  return getAllItems().then((rows) =>
    rows.filter((i) => kindOf(i) === "journal").sort((a, b) => String(a.date).localeCompare(String(b.date))),
  );
}

export function putEntry(entry) {
  const item = { category: "journal", subject: "today", ...entry, id: entry.date, kind: "journal" };
  return tx(ITEMS, "readwrite", (s) => reqToPromise(s.put(item)));
}

export function deleteEntry(date) {
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
export function getPeriod(key) {
  return tx("periods", "readonly", (s) => reqToPromise(s.get(key)));
}

export function getAllPeriods() {
  return tx("periods", "readonly", (s) => reqToPromise(s.getAll())).then((r) => r || []);
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
export function putMemory(m) {
  return tx(ITEMS, "readwrite", (s) => reqToPromise(s.put({ ...m, kind: "memory" })));
}
export function getAllMemories() {
  return getAllItems().then((r) => r.filter((i) => kindOf(i) === "memory"));
}
export function deleteMemory(id) {
  return tx(ITEMS, "readwrite", (s) => reqToPromise(s.delete(id)));
}
export async function clearAllMemories() {
  const mems = (await getAllItems()).filter((i) => kindOf(i) === "memory");
  await tx(ITEMS, "readwrite", (s) => Promise.all(mems.map((i) => reqToPromise(s.delete(i.id)))));
}
