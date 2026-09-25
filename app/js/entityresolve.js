// Shared entity resolution: turn extracted names ([{name, kind}]) into entity ids, matching existing
// entities by NORMALIZED name/alias and creating new ones as needed. Used both by the summarization
// pass (NER now rides along with each entry's summary) and the manual "Scan" — one code path, one
// in-memory index, and creation is serialized so concurrent callers can't make duplicate entities.

import { getAllEntities, putEntity, deleteEntity } from "./db.js";

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "e" + Date.now() + Math.random().toString(36).slice(2));

export function normName(s) {
  return String(s || "").toLowerCase().replace(/['’]s\b/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

// A name must never be a reference token. If the model hands back "{{e:id|Luann}}" (it saw a token in
// tokenized rollup text), keep only the embedded name; strip any leftover braces.
export function cleanName(n) {
  let s = String(n || "");
  const tok = s.match(/\{\{(?:e:)?[A-Za-z0-9_:-]+\|([^{}]*)\}\}/); // {{e:id|Name}} → Name
  if (tok) s = tok[1];
  s = s.replace(/\{\{[^{}]*\}\}/g, " ").replace(/[{}]/g, " ").replace(/\s+/g, " ").trim();
  return s;
}

// One-time cleanup: fix (or drop) any entity whose canonical is a leftover token, and dedupe.
export async function sanitizeEntities() {
  const all = await getAllEntities();
  let changed = false;
  for (const e of all) {
    if (!e || !e.canonical || !/[{}]/.test(e.canonical)) continue;
    const fixed = cleanName(e.canonical);
    if (fixed) { await putEntity({ ...e, canonical: fixed, updatedAt: Date.now() }); }
    else { await deleteEntity(e.id); } // pure garbage, no salvageable name
    changed = true;
  }
  if (changed) resetEntityIndex();
  return changed;
}

let index = null;      // normalized name → entity
let loadPromise = null;
let chain = Promise.resolve(); // serializes creation across concurrent callers

function indexEntity(e) { for (const n of [e.canonical, ...(e.aliases || [])]) { const k = normName(n); if (k) index.set(k, e); } }

async function ensureIndex() {
  if (index) return;
  if (!loadPromise) loadPromise = getAllEntities().then((list) => { index = new Map(); list.forEach(indexEntity); });
  await loadPromise;
}

// Call whenever entities change out-of-band (merge, delete, rename, alias edit) so the next resolve
// rebuilds from storage.
export function resetEntityIndex() { index = null; loadPromise = null; }

// Resolve [{name, kind}] → [entityId], creating new entities as needed. Serialized to avoid dupes.
export function resolveEntityNames(mentions) {
  const list = Array.isArray(mentions) ? mentions : [];
  const p = chain.then(async () => {
    await ensureIndex();
    const refs = [];
    for (const m of list) {
      if (!m || !m.name) continue;
      const name = cleanName(m.name); // never let a {{token}} become a name
      const k = normName(name);
      if (!k) continue;
      let e = index.get(k);
      if (!e) {
        e = { id: uid(), entityKind: m.kind || "person", canonical: name, aliases: [], note: "", createdAt: Date.now(), updatedAt: Date.now() };
        await putEntity(e);
        indexEntity(e);
      }
      if (!refs.includes(e.id)) refs.push(e.id);
    }
    return refs;
  });
  chain = p.catch(() => {}); // keep the chain alive even if one resolve throws
  return p;
}
