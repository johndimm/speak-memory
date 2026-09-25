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
- Choose about {DAYS} days total, spread roughly evenly from {START_YEAR} to {END_YEAR} — a day or two per year,
  never all clustered at the end. Give each a real, plausible calendar date.
- Ground everything in the real journal: name the ACTUAL people, places, and running threads that appear in it,
  and let them evolve plausibly over the years — people age, move, arrive, drift away; projects finish or fade;
  the body and the seasons keep turning. New things may enter, but they should grow out of what is already there.
- Match your own voice, rhythm, vocabulary, and preoccupations from the journal. Keep it mundane and felt — a real
  day, not a highlight reel. Some entries can be small and quiet.
- Extrapolate honestly from the trajectory the journal actually shows — the most PLAUSIBLE arc — unless the note
  below asks you to steer it a certain way.
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

async function callChat(messages, temperature) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY not set in environment");
  const model = process.env.DEEPSEEK_MODEL || DEFAULT_MODEL;
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, temperature, response_format: { type: "json_object" }, messages }),
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
    const years = [5, 10, 20, 30].includes(Number(body.years)) ? Number(body.years) : 10;
    const nudge = typeof body.prompt === "string" ? body.prompt.trim().slice(0, 2000) : "";
    // How many future diary entries to write. Caller-controlled; default ~1/year, clamped 2–40.
    const requested = Number(body.count);
    const sampleDays = Number.isFinite(requested) && requested > 0
      ? Math.max(2, Math.min(40, Math.round(requested)))
      : Math.max(4, Math.min(12, years));

    const lastDate = entries.map((e) => e.date).filter(Boolean).sort().pop();
    const baseYear = (lastDate && Number(lastDate.slice(0, 4))) || new Date().getFullYear();
    const endYear = baseYear + years;

    const context = buildContext(entries) || "(no entries yet)";
    let system = FUTURE_SYSTEM
      .replace(/{YEARS}/g, String(years))
      .replace(/{DAYS}/g, String(sampleDays))
      .replace(/{START_YEAR}/g, String(baseYear + 1))
      .replace(/{END_YEAR}/g, String(endYear));
    if (nudge) {
      system += `\n\nSteer the future this way: "${nudge}"\nHonor that intention, but keep everything else grounded in the journal and its people.`;
    }
    // The enduring life-states/memories (homes, schools, jobs, relationships, decisions) — the richer
    // this is, the more grounded and specific the projected future. Gathered via the life interview.
    const lifeStates = Array.isArray(body.memories) ? body.memories.slice(0, 200) : [];
    if (lifeStates.length) {
      const lines = lifeStates.map((m) => {
        const span = m.startYear ? `${m.startYear}${m.endYear && m.endYear !== m.startYear ? "–" + m.endYear : ""}: ` : "";
        return `- [${m.category || "Life"}] ${span}${m.subject || m.label || ""}${m.text ? ` — ${String(m.text).replace(/\s+/g, " ").slice(0, 300)}` : ""}`;
      }).join("\n");
      system += `\n\n=== MY LIFE SO FAR (homes, schools, jobs, relationships, decisions) ===\n${lines}`;
    }
    const about = String(body.about || "").slice(0, 1500).trim();
    if (about) system += `\n\n=== WHO I AM ===\n${about}`;
    system += `\n\n=== JOURNAL ENTRIES ===\n${context}`;

    const userMsg = `It is now around ${baseYear}. Write my raw future diary days${nudge ? ", steered by what I asked" : ""}.`;

    const reply = await callChat(
      [{ role: "system", content: system }, { role: "user", content: userMsg }],
      0.9,
    );
    const parsed = parseJson(reply);
    const days = Array.isArray(parsed?.days)
      ? parsed.days
          .filter((d) => d && d.date && d.raw)
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
