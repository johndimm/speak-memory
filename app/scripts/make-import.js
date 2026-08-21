// Run on the notebook: turns the old pipeline's processed entries + photos into
// a single days-import.json you can AirDrop/email to your phone and load with the
// app's Import button. Nothing here is uploaded to Vercel — it's a local file.
//
//   node app/scripts/make-import.js
//
// Writes ./days-import.json at the repo root.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", ".."); // repo root

const journal = JSON.parse(readFileSync(join(ROOT, "data", "journal.json"), "utf8"));
const images = existsSync(join(ROOT, "data", "images.json"))
  ? JSON.parse(readFileSync(join(ROOT, "data", "images.json"), "utf8"))
  : { byDate: {} };

const IMG_DIR = join(ROOT, "web", "data", "images");

function photoDataURLs(date) {
  const list = images.byDate?.[date] ?? [];
  const out = [];
  for (const img of list) {
    const path = join(IMG_DIR, img.filename);
    if (!existsSync(path)) continue;
    const b64 = readFileSync(path).toString("base64");
    out.push(`data:${img.mime || "image/jpeg"};base64,${b64}`);
  }
  return out;
}

const entries = Object.values(journal.days)
  .filter((d) => d.date && d.date !== "undated")
  .sort((a, b) => a.date.localeCompare(b.date))
  .map((d) => ({
    date: d.date,
    dayOfWeek: d.dayOfWeek,
    brief: d.brief,
    full: d.full,
    photos: photoDataURLs(d.date),
  }));

const bundle = { version: 1, exportedAt: new Date().toISOString(), entries };
const outPath = join(ROOT, "days-import.json");
writeFileSync(outPath, JSON.stringify(bundle), "utf8");

const photoCount = entries.reduce((n, e) => n + e.photos.length, 0);
const sizeMB = (Buffer.byteLength(JSON.stringify(bundle)) / 1024 / 1024).toFixed(2);
console.log(`Wrote ${outPath}`);
console.log(`  ${entries.length} entries, ${photoCount} photos, ${sizeMB} MB`);
console.log(`  Dates: ${entries.map((e) => e.date).join(", ")}`);
