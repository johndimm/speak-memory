// An entry can hold three representations of a day: the raw words (verbatim), a prose
// summary, and an outline summary. `mode` selects which is shown; the active rep is also
// mirrored into top-level brief/full/summarized so the calendar/period/life code is unchanged.

export const MODES = ["verbatim", "prose", "outline"];

export function deriveBrief(text) {
  const clean = String(text).replace(/\s+/g, " ").trim();
  const sentence = clean.match(/^.*?[.!?](?=\s|$)/);
  let s = sentence ? sentence[0] : clean;
  if (s.length > 100) {
    const cut = s.slice(0, 100);
    const sp = cut.lastIndexOf(" ");
    s = (sp > 60 ? cut.slice(0, sp) : cut) + "…";
  }
  return s;
}

// Which representations does this entry actually have?
export function availableModes(entry) {
  const m = [];
  if (entry.raw || entry.summarized === false) m.push("verbatim");
  if (entry.prose && entry.prose.full) m.push("prose");
  if (entry.outline && entry.outline.full) m.push("outline");
  return m;
}

// Fields for a given mode, falling back gracefully when a rep is missing.
export function repFor(entry, mode) {
  if (mode === "prose" && entry.prose?.full) {
    return { brief: entry.prose.brief || deriveBrief(entry.prose.full), full: entry.prose.full, summarized: true };
  }
  if (mode === "outline" && entry.outline?.full) {
    return { brief: entry.outline.brief || deriveBrief(entry.outline.full), full: entry.outline.full, summarized: true };
  }
  const raw = entry.raw ?? (entry.summarized === false ? entry.full : "") ?? "";
  return { brief: deriveBrief(raw), full: raw, summarized: false };
}

// The text of each representation this entry holds: { outline?, prose?, verbatim? }.
export function repsOf(entry) {
  const reps = {};
  if (entry.outline?.full) reps.outline = entry.outline.full;
  if (entry.prose?.full) reps.prose = entry.prose.full;
  if (entry.raw) reps.verbatim = entry.raw;
  else if (entry.summarized === false && entry.full) reps.verbatim = entry.full;
  if (!Object.keys(reps).length && entry.full) {
    const mode = entry.mode || (entry.summarized === false ? "verbatim" : "prose");
    reps[mode] = entry.full;
  }
  return reps;
}

// Return a normalized entry with `mode` applied and brief/full/summarized mirrored.
export function withMode(entry, mode) {
  const modes = availableModes(entry);
  const m = modes.includes(mode) ? mode : (modes[0] || "verbatim");
  const rep = repFor(entry, m);
  return { ...entry, mode: m, brief: rep.brief, full: rep.full, summarized: rep.summarized };
}
