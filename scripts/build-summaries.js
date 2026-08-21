import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { sundayWeekKey, monthKey, yearKey } from "./lib/dates.js";
import { weekLabelFromStart } from "./lib/docs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function loadSummaries() {
  const cachePath = join(ROOT, "data", "summaries-cache.json");
  if (!existsSync(cachePath)) return { days: {}, periods: {} };
  return JSON.parse(readFileSync(cachePath, "utf8"));
}

function loadImages() {
  const path = join(ROOT, "data", "images.json");
  if (!existsSync(path)) return { byDate: {} };
  return JSON.parse(readFileSync(path, "utf8"));
}

function buildJournal() {
  const parsed = JSON.parse(readFileSync(join(ROOT, "data", "parsed.json"), "utf8"));
  const summaries = loadSummaries();
  const images = loadImages();
  const days = {};

  for (const [date, day] of Object.entries(parsed.days)) {
    if (date === "undated") continue;
    const summary = summaries.days[date];
    days[date] = {
      date,
      dateLabel: day.dateLabel,
      dayOfWeek: new Date(date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long" }),
      segmentCount: day.raw.length,
      brief: summary?.brief ?? "Summary pending.",
      full: summary?.full ?? day.raw.join("\n\n"),
      images: images.byDate[date] ?? [],
    };
  }

  const dates = Object.keys(days).sort();
  const periods = {};

  for (const date of dates) {
    const week = sundayWeekKey(date);
    const month = monthKey(date);
    const year = yearKey(date);

    for (const [key, type] of [[week, "week"], [month, "month"], [year, "year"]]) {
      if (periods[key]) {
        if (!periods[key].dates.includes(date)) periods[key].dates.push(date);
        continue;
      }
      const cached = summaries.periods[key];
      periods[key] = {
        type,
        label: cached?.label ?? key,
        dates: [date],
        brief: cached?.brief ?? "",
        full: cached?.full ?? "",
      };
    }
  }

  for (const p of Object.values(periods)) {
    p.dates.sort();
    if (!p.label || p.label === p.dates[0]) {
      if (p.type === "week") p.label = weekLabelFromStart(p.dates[0] ? sundayWeekKey(p.dates[0]) : p.dates[0]);
      if (p.type === "month") {
        const [y, m] = p.dates[0].split("-");
        p.label = new Date(+y, +m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
      }
      if (p.type === "year") p.label = p.dates[0].slice(0, 4);
    }
  }

  const output = {
    meta: {
      ...parsed.meta,
      builtAt: new Date().toISOString(),
      entryCount: dates.length,
      imageCount: Object.values(images.byDate).flat().length,
    },
    days,
    periods,
  };

  writeFileSync(join(ROOT, "data", "journal.json"), JSON.stringify(output, null, 2), "utf8");
  writeFileSync(join(ROOT, "web", "data", "journal.json"), JSON.stringify(output, null, 2), "utf8");
  console.log(`Built journal.json — ${dates.length} days, ${output.meta.imageCount} images`);
}

buildJournal();
