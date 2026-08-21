import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { loadDocs } from "./lib/docs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const MONTHS = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

const DATE_PATTERNS = [
  {
    re: /\b(?:mon|tue|wed|thu|fri|sat|sun)(?:day)?\s+([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/gi,
    needsYear: true,
  },
  {
    re: /\bit'?s\s+([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(20\d{2}))?\b/gi,
    needsYear: false,
  },
  {
    re: /\bokay\s+so\s+this\s+is\s+([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?/gi,
    needsYear: false,
  },
  {
    re: /\b([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})(?:\s+it'?s\s+\w+day)?\b/gi,
    needsYear: true,
  },
];

function parseDateMatch(match, defaultYear = 2026) {
  const monthName = match[1].toLowerCase();
  const month = MONTHS[monthName];
  if (!month) return null;

  const day = parseInt(match[2], 10);
  if (day < 1 || day > 31) return null;

  const yearMatch = match[0].match(/\b(20\d{2})\b/);
  const year = yearMatch ? parseInt(yearMatch[1], 10) : defaultYear;
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

  return { iso, label: match[0].trim(), index: match.index };
}

function findDateMarkers(text) {
  const markers = [];

  for (const { re } of DATE_PATTERNS) {
    const pattern = new RegExp(re.source, re.flags);
    let m;
    while ((m = pattern.exec(text)) !== null) {
      const parsed = parseDateMatch(m);
      if (!parsed) continue;
      const overlaps = markers.some((mk) => Math.abs(mk.index - m.index) < 5);
      if (!overlaps) markers.push({ ...parsed, length: m[0].length });
    }
  }

  return markers.sort((a, b) => a.index - b.index);
}

function splitByDates(text) {
  const markers = findDateMarkers(text);
  if (!markers.length) return [{ date: null, dateLabel: null, text: text.trim() }];

  const segments = [];
  let lastEnd = 0;
  let currentDate = null;
  let currentLabel = null;

  for (const marker of markers) {
    const before = text.slice(lastEnd, marker.index).trim();
    if (before && currentDate) {
      segments.push({ date: currentDate, dateLabel: currentLabel, text: before });
    } else if (before && !currentDate && segments.length === 0) {
      segments.push({ date: null, dateLabel: null, text: before });
    }

    currentDate = marker.iso;
    currentLabel = marker.label;
    lastEnd = marker.index + marker.length;
  }

  const tail = text.slice(lastEnd).trim();
  if (tail && currentDate) {
    segments.push({ date: currentDate, dateLabel: currentLabel, text: tail });
  }

  return segments.filter((s) => s.text.length > 20 || s.date);
}

function groupByDay(segments, sourceWeek) {
  const days = {};

  for (const seg of segments) {
    const date = seg.date ?? "undated";
    if (!days[date]) {
      days[date] = { date, dateLabel: seg.dateLabel, sourceWeek, raw: [] };
    }
    days[date].raw.push(seg.text);
    if (!days[date].dateLabel && seg.dateLabel) {
      days[date].dateLabel = seg.dateLabel;
    }
  }

  return days;
}

function mergeDays(allDays) {
  const merged = {};
  for (const days of allDays) {
    for (const [date, day] of Object.entries(days)) {
      if (!merged[date]) {
        merged[date] = { ...day, raw: [...day.raw] };
        continue;
      }
      merged[date].raw.push(...day.raw);
      if (!merged[date].dateLabel && day.dateLabel) {
        merged[date].dateLabel = day.dateLabel;
      }
    }
  }
  return merged;
}

function loadRawTexts() {
  const rawDir = join(ROOT, "data", "raw");
  if (existsSync(rawDir)) {
    const files = readdirSync(rawDir)
      .filter((f) => f.endsWith(".txt"))
      .sort();
    if (files.length) {
      return files.map((f) => ({
        weekStart: f.replace(".txt", ""),
        text: readFileSync(join(rawDir, f), "utf8"),
      }));
    }
  }

  const legacy = join(ROOT, "journal-raw.txt");
  if (existsSync(legacy)) {
    return [{ weekStart: "legacy", text: readFileSync(legacy, "utf8") }];
  }
  return [];
}

function main() {
  const config = loadDocs();
  const sources = loadRawTexts();

  if (!sources.length) {
    console.log("No raw text found — run npm run fetch first.");
    process.exit(1);
  }

  const allDayMaps = [];
  for (const { weekStart, text } of sources) {
    const body = text.replace(/^The Days of our lives[^\n]*\n?/i, "").trim();
    const segments = splitByDates(body);
    allDayMaps.push(groupByDay(segments, weekStart));
  }

  const days = mergeDays(allDayMaps);
  const dated = Object.values(days)
    .filter((d) => d.date !== "undated")
    .map((d) => d.date)
    .sort();

  const output = {
    meta: {
      title: "The Days of our lives",
      docs: config,
      sourceWeeks: sources.map((s) => s.weekStart),
      parsedAt: new Date().toISOString(),
      dateRange: dated.length ? { start: dated[0], end: dated[dated.length - 1] } : null,
    },
    days,
  };

  writeFileSync(join(ROOT, "data", "parsed.json"), JSON.stringify(output, null, 2), "utf8");
  console.log(`Parsed ${dated.length} days from ${sources.length} doc(s) → data/parsed.json`);
  for (const d of dated) {
    const chunks = days[d].raw.length;
    const src = days[d].sourceWeek ?? "?";
    console.log(`  ${d}: ${chunks} segment(s) [${src}]`);
  }
}

main();
