// Story subjects are Names. A story's subject ("the house my dad built", "Agate St", "Luann") is
// something you named yourself, so it gets a card in Names — linked to its story as a mention.
// Kind comes from the story's category; a subject that already matches a name/alias links to it.
// New cards start with the story's one-sentence summary as their description, and are marked
// `fromSubject` so this can be undone in one step (removeStorySubjectNames).
import { getAllMemories, putMemory, getAllEntities, getEntity, putEntity, deleteEntity } from "./db.js";
import { resolveEntityNames, normName, resetEntityIndex } from "./entityresolve.js";

const KIND_BY_CATEGORY = [
  [["homes", "home", "places", "place", "cities", "city", "houses", "travel", "vacations", "trips"], "place"],
  [["relationships", "relationship", "girl friends", "girlfriends", "boyfriends", "friends", "family", "partners", "people"], "person"],
  [["jobs", "job", "work", "career", "careers", "schools", "school", "companies", "clubs", "teams", "bands"], "org"],
  [["pets", "animals"], "animal"],
];
function kindFor(category) {
  const c = String(category || "").trim().toLowerCase();
  for (const [names, kind] of KIND_BY_CATEGORY) if (names.includes(c)) return kind;
  return "thing";
}
const detoken = (t) => String(t || "").replace(/\{\{(?:e:)?[^|{}]+\|([^{}]*)\}\}/g, "$1").trim();

let running = null;
export function syncStorySubjects() {
  if (!running) running = doSync().finally(() => { running = null; });
  return running;
}
async function doSync() {
  const [mems, ents] = await Promise.all([getAllMemories(), getAllEntities()]);
  const known = new Set();
  for (const e of ents) for (const n of [e.canonical, ...(e.aliases || [])]) { const k = normName(n); if (k) known.add(k); }
  let changed = 0;
  for (const m of mems) {
    if (m.fromPast) continue; // a Future's view of your real past is read-only
    const subject = String(m.subject || "").trim();
    if (!subject || subject.length > 60 || normName(subject) === normName(m.category)) continue;
    const isNew = !known.has(normName(subject));
    const kind = kindFor(m.category);
    let id;
    try { [id] = await resolveEntityNames([{ name: subject, kind }]); } catch { continue; }
    if (!id) continue;
    if (isNew) {
      known.add(normName(subject));
      const e = await getEntity(id);
      const about = detoken((m.levels && m.levels.sentence) || (m.prose && m.prose.brief) || "");
      if (e) await putEntity({ ...e, entityKind: kind, fromSubject: true, ...(about && !e.profile ? { profile: about, profileAt: Date.now() } : {}), updatedAt: Date.now() });
      changed++;
    }
    if (!(m.entityRefs || []).includes(id)) { await putMemory({ ...m, entityRefs: [...(m.entityRefs || []), id] }); changed++; }
  }
  if (changed) resetEntityIndex();
  return changed;
}

// Undo: remove every card that was created from a story subject (and its links on the stories).
export async function removeStorySubjectNames() {
  const gone = new Set((await getAllEntities()).filter((e) => e.fromSubject && !e.note).map((e) => e.id));
  for (const m of await getAllMemories()) {
    if (Array.isArray(m.entityRefs) && m.entityRefs.some((r) => gone.has(r))) await putMemory({ ...m, entityRefs: m.entityRefs.filter((r) => !gone.has(r)) });
  }
  for (const id of gone) await deleteEntity(id);
  resetEntityIndex();
  return gone.size;
}
