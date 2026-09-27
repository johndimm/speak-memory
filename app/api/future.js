// Vercel serverless function — imagine the journal's FUTURE.
// The browser sends every entry plus an optional "nudge". This endpoint does ONLY the first
// step of the real pipeline: it makes up RAW diary days, as if future-you had spoken them into
// the app. The browser then runs each raw day back through /api/summarize (mode:"day"), exactly
// like a real entry, so a future renders with the same outline/prose/verbatim UI as any day.
// Same DeepSeek plumbing as chat.js; the key stays here.

// One long LLM call generates many days at once, so give the function room (default timeouts are
// far too short — even a small future takes 20–30s). Vercel clamps this to the plan's ceiling.
export const config = { maxDuration: 300 };

const API_URL = "https://api.deepseek.com/v1/chat/completions";
const DEFAULT_MODEL = "deepseek-v4-flash";
const CONTEXT_BUDGET = 30000; // ~chars of entry text to ground on (kept modest so a big journal
                              // doesn't make this single generation call slow enough to time out)

const FUTURE_SYSTEM = `You are the author of the journal below, writing FUTURE entries — as if the journal simply kept going.
You have read the whole journal (every entry, with its date), so you know your own voice, your people, your
places, your work, your habits, hopes, fears, health, and the ordinary shape of your days.

Your task: make up RAW diary entries for a sample of days across the coming {YEARS} years, exactly the way you
already write in this journal — a voice-memo poured out at the end of the day. Later these get summarized like
any other day, so write them RAW: first person, unpolished, specific, the texture of a real spoken entry.

Rules:
- It starts TOMORROW, {START_DATE}: the FIRST entry is within a few weeks of that date, picking up right where the
  journal leaves off. Then choose about {DAYS} days total, spread roughly evenly out to {END_YEAR} — about one every
  {GAP} — never skipping years at the start or clustering at the end. Give each a real, plausible calendar date.
- Ground everything in the real journal: name the ACTUAL people, places, and running threads that appear in it,
  and let them evolve plausibly over the years — people age, move, arrive, drift away; projects finish or fade;
  the body and the seasons keep turning. New things may enter, but they should grow out of what is already there.
- Match your own voice, rhythm, vocabulary, and preoccupations from the journal. Keep it mundane and felt — a real
  day, not a highlight reel. Some entries can be small and quiet.
- Extrapolate honestly from the trajectory the journal actually shows — the most PLAUSIBLE arc — unless the note
  below asks you to steer it a certain way.
- The people in WHO'S WHO are exactly who they are described as: never change or invent anyone's gender or their
  relationship to you (a daughter stays a daughter). If a relationship isn't stated, don't assign one — just use the name.
- Never break character or mention being an AI, a model, or a prediction. You are the journal, continuing.

Also imagine the enduring STATES of this future life — the parallel tracks that span years, not single
days: where you live, your work, your relationships, your health, ongoing projects, anything with a
duration. Each state is a span with a start and (usually) end year across {START_YEAR}–{END_YEAR},
growing out of where the journal leaves off. These populate a life timeline, so give real year spans.

Return ONLY valid JSON, no markdown fence, in exactly this shape:
{"bridge":"<one or two short sentences: how you got from now to this stretch of years>",
 "days":[{"date":"YYYY-MM-DD","raw":"<the raw diary entry for that day, first person>"}, ...],
 "states":[{"category":"Home|Work|Relationship|Health|Project|Place","subject":"<short label, e.g. 'the house on Pine St' or 'teaching at the college'>","startYear":YYYY,"endYear":YYYY,"text":"<a sentence or two, first person, on this chapter>"}, ...]}
Order "days" chronologically. Give about {DAYS} states across the span. Escape any double quotes inside strings with a backslash.`;

function buildContext(entries) {
  const sorted = [...entries].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  let used = 0;
  const fullDates = new Set();
  for (let i = sorted.length - 1; i >= 0; i--) {
    const e = sorted[i];
    const full = e.full || e.brief || "";
    if (used + full.length + 40 <= CONTEXT_BUDGET) {
      fullDates.add(e.date);
      used += full.length + 40;
    } else {
      used += (e.brief || "").length + 40;
    }
  }
  return sorted
    .map((e) => {
      const body = fullDates.has(e.date) ? (e.full || e.brief || "") : (e.brief || "(entry omitted for length)");
      return `### ${e.date}${e.dayOfWeek ? ` (${e.dayOfWeek})` : ""}\n${body}`;
    })
    .join("\n\n");
}

// Tolerant JSON extraction (the model sometimes wraps JSON in prose or a code fence).
function parseJson(text) {
  const raw = String(text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try { return JSON.parse(raw); } catch { /* fall through */ }
  const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
  if (s >= 0 && e > s) {
    try { return JSON.parse(raw.slice(s, e + 1)); } catch { /* give up */ }
  }
  return null;
}

async function callChat(messages, temperature, maxTokens = 8192) { // up to 40 raw days + states in one reply
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY not set in environment");
  const model = process.env.DEEPSEEK_MODEL || DEFAULT_MODEL;
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, temperature, response_format: { type: "json_object" }, messages, max_tokens: maxTokens }),
  });
  if (!res.ok) throw new Error(`DeepSeek API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0]?.message?.content ?? "";
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const entries = Array.isArray(body.entries) ? body.entries : [];
    if (!entries.length) {
      res.status(400).json({ error: "No journal entries yet — write a few days first, then imagine forward." });
      return;
    }
    // Any span up to a whole life (e.g. 15 → 95 is 80 years).
    const years = Math.max(1, Math.min(100, Math.round(Number(body.years)) || 10));
    const nudge = typeof body.prompt === "string" ? body.prompt.trim().slice(0, 2000) : "";
    // How many future diary entries to write. Caller-controlled; default ~1/year, clamped 2–40.
    const requested = Number(body.count);
    const sampleDays = Number.isFinite(requested) && requested > 0
      ? Math.max(2, Math.min(40, Math.round(requested)))
      : Math.max(4, Math.min(12, years));

    // A Future starts TOMORROW (the caller's local date) — no gap after today — and runs `years`.
    const startDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body.startDate || "")) ? String(body.startDate)
      : new Date(Date.now() + 864e5).toISOString().slice(0, 10);
    const baseYear = Number(startDate.slice(0, 4));
    const endYear = baseYear + years;

    const context = buildContext(entries) || "(no entries yet)";
    let system = FUTURE_SYSTEM
      .replace(/{YEARS}/g, String(years))
      .replace(/{DAYS}/g, String(sampleDays))
      .replace(/{START_YEAR}/g, String(baseYear))
      .replace(/{END_YEAR}/g, String(endYear))
      .replace(/{START_DATE}/g, startDate)
      .replace(/{GAP}/g, years / sampleDays <= 1.5 ? "year" : `${Math.round(years / sampleDays)} years`);
    // "Rest of life": the span runs out to the end — let the life actually reach it.
    const toAge = Number(body.toAge), ageNow = Number(body.currentAge);
    if (toAge > 0 && ageNow > 0) {
      system += `\n\nThis future runs for the REST OF MY LIFE: I am ${ageNow} now and it ends around age ${toAge} (${endYear}). Let me grow up and grow old at a believable pace — each entry sounds like me at THAT age (a teenager writes like a teenager, an old person like an old person) — through the big turns a whole life brings: leaving home, work, love, family, loss, and the final years.`;
    }
    if (nudge) {
      system += `\n\nSteer the future this way: "${nudge}"\nHonor that intention, but keep everything else grounded in the journal and its people.`;
    }
    // The enduring life-states/memories (homes, schools, jobs, relationships, decisions) — the richer
    // this is, the more grounded and specific the projected future. Gathered via the life interview.
    const lifeStates = Array.isArray(body.memories) ? body.memories.slice(0, 200) : [];
    if (lifeStates.length) {
      const lines = lifeStates.map((m) => {
        const span = m.startYear ? `${m.startYear}${m.endYear && m.endYear !== m.startYear ? "–" + m.endYear : ""}: ` : "";
        return `- [${m.category || "Life"}] ${span}${m.subject || m.label || ""}${m.text ? ` — ${String(m.text).replace(/\s+/g, " ").slice(0, 500)}` : ""}`;
      }).join("\n");
      system += `\n\n=== MY LIFE SO FAR (homes, schools, jobs, relationships, decisions) ===\n${lines}`;
    }
    const about = String(body.about || "").slice(0, 1500).trim();
    if (about) system += `\n\n=== WHO I AM ===\n${about}`;
    // My life NOW (home, who with, work, fun — each with since when): where the future starts from.
    const selfFacts = String(body.selfFacts || "").slice(0, 1000).trim();
    if (selfFacts) system += `\n\n=== MY LIFE NOW ===\n${selfFacts}`;
    // The whole arc, already summarized: Life, then each decade — the cheapest way to know the shape.
    const arc = Array.isArray(body.arc) ? body.arc : [];
    let arcUsed = 0;
    const arcLines = [];
    for (const a of arc) {
      const t = String((a && a.text) || "").replace(/\s+/g, " ").trim().slice(0, 2500);
      if (!t || arcUsed + t.length > 9000) continue;
      arcUsed += t.length;
      arcLines.push(`## ${String(a.label || "").slice(0, 60)}\n${t}`);
    }
    if (arcLines.length) system += `\n\n=== MY LIFE, SUMMARIZED (the whole arc, then by decade) ===\n${arcLines.join("\n\n")}`;
    // The people, places and things in my life — one sentence each, most-mentioned first.
    const names = Array.isArray(body.names) ? body.names.slice(0, 80) : [];
    const nameLines = names
      .filter((n) => n && n.name && n.about)
      .map((n) => `- ${String(n.name).slice(0, 80)} (${String(n.kind || "person").slice(0, 10)}): ${String(n.about).replace(/\s+/g, " ").slice(0, 220)}`);
    // Things I hope to do while there's time — weave in the ones that fit this future's arc.
    const bucket = Array.isArray(body.bucket) ? body.bucket.filter((x) => typeof x === "string").slice(0, 40) : [];
    if (bucket.length) system += `\n\n=== MY BUCKET LIST (things I hope to do; some may happen, some may not — follow the arc) ===\n${bucket.map((b) => `- ${b.slice(0, 200)}`).join("\n")}`;
    if (nameLines.length) system += `\n\n=== WHO'S WHO (keep these people consistent; use their names) ===\n${nameLines.join("\n")}`;
    system += `\n\n=== JOURNAL ENTRIES ===\n${context}`;

    const userMsg = `Today is the day before ${startDate}. Write my raw future diary days, starting tomorrow${nudge ? ", steered by what I asked" : ""}.`;
    // dryRun: return the assembled prompt without calling the model (to inspect what's sent).
    if (body.dryRun) { res.status(200).json({ system, user: userMsg, chars: system.length }); return; }

    const reply = await callChat(
      [{ role: "system", content: system }, { role: "user", content: userMsg }],
      0.9,
    );
    const parsed = parseJson(reply);
    const days = Array.isArray(parsed?.days)
      ? parsed.days
          .filter((d) => d && d.date && d.raw && String(d.date).slice(0, 10) >= startDate) // never before tomorrow
          .map((d) => ({ date: String(d.date).slice(0, 10), raw: String(d.raw) }))
          .sort((a, b) => a.date.localeCompare(b.date))
      : [];
    if (!days.length) { res.status(502).json({ error: "The model didn't return any days — try again." }); return; }

    // Enduring life-states (year spans) → the future's Timeline lanes.
    const yr = (v) => { const n = parseInt(String(v).slice(0, 4), 10); return Number.isFinite(n) ? n : null; };
    const states = Array.isArray(parsed?.states)
      ? parsed.states
          .filter((s) => s && s.subject && yr(s.startYear))
          .map((s) => ({
            category: String(s.category || "Life").slice(0, 40),
            subject: String(s.subject).slice(0, 120),
            startYear: yr(s.startYear),
            endYear: yr(s.endYear) || yr(s.startYear),
            text: String(s.text || s.subject).slice(0, 2000),
          }))
      : [];

    res.status(200).json({ bridge: String(parsed?.bridge || ""), days, states, years, baseYear, endYear });
  } catch (err) {
    res.status(500).json({ error: err.message || "Could not imagine the future" });
  }
}
