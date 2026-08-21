import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { callLLM, contentHash, loadEnv, hasLLMKey, getProviderInfo } from "./lib/llm.js";
import { sundayWeekKey, monthKey, yearKey } from "./lib/dates.js";
import { weekLabelFromStart } from "./lib/docs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CACHE_PATH = join(ROOT, "data", "summaries-cache.json");

const DAY_SYSTEM = `You are an editor turning voice-memo journal entries into readable prose.
The source is messy speech-to-text. Your job is to compress and polish it — NOT to paraphrase every thought.

Return ONLY valid JSON: {"brief":"...","full":"..."}

- brief: one sentence, past tense, max 20 words — the headline of what happened
- full: 3-4 SHORT paragraphs (2-4 sentences each). Separate with \\n\\n in the JSON string.
  Each paragraph covers one part of the day: morning/plans, main events, evening/reflection.
  Write in past tense with a calm editorial voice (avoid first-person "I").
  Cut repetition, filler, false starts, and meta-commentary about journaling itself.
  Keep: people, events, places, decisions, emotions, and specific details worth remembering.
  Target 150-250 words total for full.`;

const MAX_PARAGRAPH_CHARS = 320;

function structureFull(text) {
  let t = text.replace(/\\n/g, "\n").trim();
  let paras = t.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);

  const splitLongParagraph = (para) => {
    if (para.length <= MAX_PARAGRAPH_CHARS) return [para];
    const sentences = para.match(/[^.!?]+[.!?]+(?:\s+|$)/g) || [para];
    const chunks = [];
    let current = "";
    for (const sentence of sentences) {
      if (current.length + sentence.length > MAX_PARAGRAPH_CHARS && current) {
        chunks.push(current.trim());
        current = sentence;
      } else {
        current += sentence;
      }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks.length ? chunks : [para];
  };

  paras = paras.flatMap(splitLongParagraph);

  if (paras.length < 3 && t.length > 350) {
    const sentences = t.match(/[^.!?]+[.!?]+(?:\s+|$)/g) || [t];
    const target = Math.min(4, Math.max(3, Math.ceil(sentences.length / 3)));
    const size = Math.ceil(sentences.length / target);
    paras = [];
    for (let i = 0; i < sentences.length; i += size) {
      paras.push(sentences.slice(i, i + size).join("").trim());
    }
  }

  return paras.filter(Boolean).join("\n\n");
}

function normalizeFull(text) {
  return structureFull(text);
}

const PERIOD_SYSTEM = `You summarize journal entries spanning multiple days.
Return ONLY valid JSON with no markdown: {"brief":"...","full":"..."}
- brief: one sentence overview
- full: 2-3 paragraphs on themes, people, and what happened
Escape any double quotes inside strings with backslash.`;

function loadCache() {
  if (!existsSync(CACHE_PATH)) return { days: {}, periods: {} };
  return JSON.parse(readFileSync(CACHE_PATH, "utf8"));
}

function saveCache(cache) {
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), "utf8");
}

async function summarizeDay(date, rawText, cache) {
  const hash = contentHash(rawText);
  const cached = cache.days[date];
  if (cached?.hash === hash) {
    console.log(`  ${date}: cached`);
    return cached;
  }

  console.log(`  ${date}: summarizing...`);
  const result = await callLLM({
    system: DAY_SYSTEM,
    user: `Date: ${date}\n\nRaw journal text:\n\n${rawText.slice(0, 12000)}`,
  });

  const entry = {
    hash,
    brief: result.brief,
    full: normalizeFull(result.full),
    summarizedAt: new Date().toISOString(),
  };
  cache.days[date] = entry;
  return entry;
}

async function summarizePeriod(key, type, label, daySummaries, cache) {
  const combined = daySummaries.map((d) => `${d.date}: ${d.brief}\n${d.full}`).join("\n\n");
  const hash = contentHash(combined);
  const cached = cache.periods[key];
  if (cached?.hash === hash) {
    console.log(`  ${key}: cached`);
    return cached;
  }

  console.log(`  ${key}: summarizing ${type}...`);
  const result = await callLLM({
    system: PERIOD_SYSTEM,
    user: `${type} summary for ${label}:\n\n${combined.slice(0, 16000)}`,
  });

  const entry = {
    hash,
    type,
    label,
    brief: result.brief,
    full: result.full,
    summarizedAt: new Date().toISOString(),
  };
  cache.periods[key] = entry;
  return entry;
}

async function main() {
  loadEnv();
  const parsed = JSON.parse(readFileSync(join(ROOT, "data", "parsed.json"), "utf8"));
  const images = existsSync(join(ROOT, "data", "images.json"))
    ? JSON.parse(readFileSync(join(ROOT, "data", "images.json"), "utf8"))
    : { byDate: {} };

  const cache = loadCache();
  const dayResults = {};

  const dates = Object.entries(parsed.days)
    .filter(([d]) => d !== "undated")
    .sort(([a], [b]) => a.localeCompare(b));

  if (!dates.length) {
    console.log("No dated entries to summarize.");
    return;
  }

  const hasKey = hasLLMKey();
  if (!hasKey) {
    console.log("DEEPSEEK_API_KEY not set — using cached summaries only.");
    console.log("Add your key to .env.local");
  } else {
    const { provider, model } = getProviderInfo();
    console.log(`Summarizing with ${provider} (${model})`);
  }

  for (const [date, day] of dates) {
    const rawText = day.raw.join("\n\n");
    try {
      if (hasKey) {
        dayResults[date] = await summarizeDay(date, rawText, cache);
      } else if (cache.days[date]) {
        dayResults[date] = cache.days[date];
        console.log(`  ${date}: cached (no API key)`);
      } else {
        dayResults[date] = {
          brief: "Summary pending — add DEEPSEEK_API_KEY to .env.local and run npm run refresh.",
          full: rawText.slice(0, 2000) + (rawText.length > 2000 ? "…" : ""),
        };
        console.log(`  ${date}: placeholder (no API key, no cache)`);
      }
    } catch (err) {
      console.error(`  ${date}: failed — ${err.message}`);
      if (cache.days[date]) {
        dayResults[date] = cache.days[date];
        console.log(`  ${date}: using previous cached summary`);
      } else {
        dayResults[date] = {
          brief: "Summary pending — refresh again shortly.",
          full: normalizeFull(rawText.slice(0, 1200) + (rawText.length > 1200 ? "…" : "")),
        };
        console.log(`  ${date}: using truncated raw fallback`);
      }
    }
  }

  let failures = 0;

  if (hasKey) {
    const dayList = dates
      .map(([date]) => ({
        date,
        brief: dayResults[date]?.brief,
        full: dayResults[date]?.full,
      }))
      .filter((d) => d.brief && d.full);

    if (dayList.length < dates.length) {
      failures += dates.length - dayList.length;
    }

    if (dayList.length) {
      const dateStrs = dates.map(([d]) => d);
      const month = monthKey(dateStrs[0]);
      const year = yearKey(dateStrs[0]);
      const weekKeys = [...new Set(dayList.map((d) => sundayWeekKey(d.date)))].sort();
      const monthDates = dayList.filter((d) => monthKey(d.date) === month);

      try {
        for (const week of weekKeys) {
          const weekDates = dayList.filter((d) => sundayWeekKey(d.date) === week);
          await summarizePeriod(week, "week", weekLabelFromStart(week), weekDates, cache);
        }
        await summarizePeriod(month, "month", month.replace("-", " "), monthDates, cache);
        await summarizePeriod(year, "year", year, dayList, cache);
      } catch (err) {
        console.error(`Period summarization failed: ${err.message}`);
        failures++;
      }
    }
  }

  saveCache(cache);
  console.log("Summaries saved to data/summaries-cache.json");
  if (failures) {
    console.warn(`Completed with ${failures} issue(s) — cached/fallback summaries used where needed.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
