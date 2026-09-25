// The journal-keeper is just a Name — the first one, there by default. "I", "me", "myself" are its
// aliases; its canonical is your name; its note is who you are. Summaries, futures, and the interviews
// draw on it, and it's edited on its own Name page like anyone else.

import { getEntity, putEntity } from "./db.js";
import { jkey } from "./journal.js";

export const SELF_ID = "self";
const SELF_ALIASES = ["I", "me", "myself"];

export function isSelfEntity(e) { return !!(e && (e.isSelf || e.id === SELF_ID)); }

// Make sure the self entity exists (seeding name/note from any older Settings "About you" values).
export async function ensureSelf() {
  let self = await getEntity(SELF_ID);
  if (!self) {
    const name = (localStorage.getItem(jkey("about-name")) || "").trim();
    const note = localStorage.getItem(jkey("about-me")) || "";
    self = { id: SELF_ID, isSelf: true, entityKind: "person", canonical: name || "Me", aliases: SELF_ALIASES.slice(), note, createdAt: Date.now(), updatedAt: Date.now() };
    await putEntity(self);
  }
  return self;
}

// A first-person context string for the LLM (name + birth year + self-description).
export async function getAboutText() {
  const self = await ensureSelf();
  const by = Number(localStorage.getItem(jkey("birth-year")));
  const birthYear = Number.isFinite(by) && by > 1000 && by < 2200 ? by : null;
  const bits = [];
  if (self.canonical && self.canonical.toLowerCase() !== "me") bits.push(`My name is ${self.canonical}.`);
  if (birthYear) bits.push(`I was born in ${birthYear}.`);
  if (self.note) bits.push(self.note);
  return bits.join(" ").trim();
}

// True when a name still needs the reader to describe it (no note of their own words yet).
export function needsDescription(e) { return !(e && e.note && e.note.trim()); }
