// Vercel serverless function — chat over the user's journal.
// The browser sends the conversation plus all entries; the DeepSeek key stays here.

const API_URL = "https://api.deepseek.com/v1/chat/completions";
const DEFAULT_MODEL = "deepseek-v4-flash";
const CONTEXT_BUDGET = 60000; // ~chars of entry text to include

const CHAT_SYSTEM = `You are a thoughtful, candid assistant helping someone explore their own personal journal.
You are given the full set of their journal entries below, each with a date. Treat those entries as
the only source of truth about their life — do not invent events, people, or details not present.

How to help:
- SEARCH: when asked to find a word, topic, person, or theme, scan every entry and answer with the
  matching dates, each with a short quote or paraphrase. If nothing matches, say so plainly.
- REFLECT / OPINE: when asked what you think, for patterns, advice, or reflections, you may offer
  them — but ground everything in what the entries actually show, and cite the dates you're drawing on.
- Be concise by default; expand when asked. Refer to dates in a friendly form like "July 8".
- If the journal doesn't contain enough to answer, say what's missing rather than guessing.`;

function buildContext(entries) {
  const sorted = [...entries].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  // Prefer full text for the most recent days; fall back to brief for older ones if over budget.
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

async function callChat(messages) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY not set in environment");
  const model = process.env.DEEPSEEK_MODEL || DEFAULT_MODEL;

  const res = await fetch(API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, temperature: 0.4, messages }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`DeepSeek API error ${res.status}: ${err}`);
  }
  const data = await res.json();
  return data.choices[0]?.message?.content ?? "";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const entries = Array.isArray(body.entries) ? body.entries : [];
    const history = Array.isArray(body.messages) ? body.messages : [];
    if (!history.length) {
      res.status(400).json({ error: "No message provided" });
      return;
    }

    const context = buildContext(entries) || "(no entries yet)";
    // Keep the system prompt (instructions + journal) byte-identical across turns so
    // DeepSeek's automatic prefix caching bills the repeated tokens at the cached rate.
    // The only volatile bit — the current time — rides on the final user message, which
    // is never part of the cached prefix anyway.
    const system = `${CHAT_SYSTEM}\n\n=== JOURNAL ENTRIES ===\n${context}`;

    // Keep the last ~24 turns, sanitized to role/content.
    const trimmed = history
      .slice(-24)
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }));

    const last = trimmed[trimmed.length - 1];
    if (body.localTime && last && last.role === "user") {
      last.content = `${last.content}\n\n(Current local time: ${body.localTime})`;
    }

    const reply = await callChat([{ role: "system", content: system }, ...trimmed]);
    res.status(200).json({ reply });
  } catch (err) {
    res.status(500).json({ error: err.message || "Chat failed" });
  }
}
