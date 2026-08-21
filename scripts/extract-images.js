import { createHash } from "crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  unlinkSync,
  statSync,
} from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { parseDateFromText } from "./lib/dates.js";
import { getFetchableDocs, loadDocs } from "./lib/docs.js";
import { compressImage, formatBytes } from "./lib/images.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_DIR = join(ROOT, "web", "data", "images");
const MANIFEST_PATH = join(ROOT, "data", "images.json");
const RECOMPRESS_ABOVE_BYTES = 200 * 1024;

function decodeHtml(text) {
  return text
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isHashFilename(filename) {
  const hash = filename.split(".")[0];
  return hash.length === 16 && /^[a-f0-9]+$/.test(hash);
}

function loadHashIndex() {
  const byHash = {};
  if (!existsSync(OUT_DIR)) return byHash;

  for (const filename of readdirSync(OUT_DIR)) {
    if (!isHashFilename(filename)) continue;
    const hash = filename.split(".")[0];
    const bytes = statSync(join(OUT_DIR, filename)).size;
    const jpgName = `${hash}.jpg`;
    byHash[hash] = {
      hash,
      filename: jpgName,
      url: `data/images/${jpgName}`,
      mime: "image/jpeg",
      bytes,
      onDisk: filename,
    };
  }
  return byHash;
}

async function writeCompressed(hash, rawBuffer) {
  const filename = `${hash}.jpg`;
  const outPath = join(OUT_DIR, filename);
  const before = rawBuffer.length;
  const compressed = await compressImage(rawBuffer);
  writeFileSync(outPath, compressed);
  return { filename, bytes: compressed.length, saved: before - compressed.length };
}

async function extractFromHtml(html, sourceWeek, byHash) {
  const imgRe = /<img[^>]+src="(data:image\/([^;]+);base64,([^"]+))"[^>]*>/gi;
  let match;
  let lastIndex = 0;
  let currentDate = null;
  let added = 0;
  let skipped = 0;
  let savedBytes = 0;

  while ((match = imgRe.exec(html)) !== null) {
    const before = html.slice(lastIndex, match.index);
    for (const bit of before.split(/<\/p>/i).map(decodeHtml).filter(Boolean)) {
      const d = parseDateFromText(bit);
      if (d) currentDate = d;
    }

    const base64 = match[3];
    const hash = createHash("sha256").update(base64).digest("hex").slice(0, 16);
    const rawBuffer = Buffer.from(base64, "base64");

    let existing = byHash[hash];
    if (existing) {
      skipped++;
    } else {
      mkdirSync(OUT_DIR, { recursive: true });
      const { filename, bytes, saved } = await writeCompressed(hash, rawBuffer);
      existing = {
        hash,
        filename,
        sourceWeek,
        date: currentDate,
        mime: "image/jpeg",
        url: `data/images/${filename}`,
        bytes,
      };
      byHash[hash] = existing;
      savedBytes += saved;
      added++;
    }

    if (currentDate && currentDate !== "undated") {
      existing.date = currentDate;
    }

    lastIndex = match.index + match[0].length;
  }

  return { added, skipped, savedBytes };
}

function rebuildByDate(images) {
  const byDate = {};
  for (const img of images) {
    const date = img.date ?? "undated";
    if (!byDate[date]) byDate[date] = [];
    if (!byDate[date].some((i) => i.filename === img.filename)) {
      byDate[date].push({
        filename: img.filename,
        url: img.url,
        mime: img.mime,
      });
    }
  }
  return byDate;
}

function htmlSources() {
  const rawDir = join(ROOT, "data", "raw");
  const config = loadDocs();
  const docs = getFetchableDocs(config);

  if (existsSync(rawDir) && docs.length) {
    return docs
      .sort((a, b) => a.weekStart.localeCompare(b.weekStart))
      .map((d) => ({
        weekStart: d.weekStart,
        path: join(rawDir, `${d.weekStart}.html`),
      }))
      .filter((s) => existsSync(s.path));
  }

  const legacy = join(ROOT, "journal-raw.html");
  if (existsSync(legacy)) return [{ weekStart: "legacy", path: legacy }];
  return [];
}

function removeLegacyFiles() {
  if (!existsSync(OUT_DIR)) return 0;
  let removed = 0;
  for (const filename of readdirSync(OUT_DIR)) {
    if (!filename.startsWith("img-")) continue;
    unlinkSync(join(OUT_DIR, filename));
    removed++;
  }
  return removed;
}

async function recompressExisting(byHash) {
  let count = 0;
  let savedBytes = 0;

  for (const entry of Object.values(byHash)) {
    const onDisk = entry.onDisk ?? entry.filename;
    const path = join(OUT_DIR, onDisk);
    if (!existsSync(path)) continue;

    const before = statSync(path).size;
    if (before <= RECOMPRESS_ABOVE_BYTES && onDisk === entry.filename) {
      entry.bytes = before;
      delete entry.onDisk;
      continue;
    }

    const raw = readFileSync(path);
    const compressed = await compressImage(raw);
    const outPath = join(OUT_DIR, entry.filename);
    writeFileSync(outPath, compressed);

    if (onDisk !== entry.filename && existsSync(path)) {
      unlinkSync(path);
    }

    entry.bytes = compressed.length;
    if (compressed.length < before) {
      savedBytes += before - compressed.length;
      count++;
    }
    delete entry.onDisk;
  }

  return { count, savedBytes };
}

async function main() {
  const sources = htmlSources();
  if (!sources.length) {
    console.log("No HTML exports found — run npm run fetch first.");
    return;
  }

  const byHash = loadHashIndex();
  let totalAdded = 0;
  let totalSkipped = 0;
  let totalSaved = 0;

  for (const { weekStart, path } of sources) {
    const html = readFileSync(path, "utf8");
    const { added, skipped, savedBytes } = await extractFromHtml(html, weekStart, byHash);
    const savedNote = savedBytes > 0 ? `, saved ${formatBytes(savedBytes)}` : "";
    console.log(`  ${weekStart}: ${added} new, ${skipped} cached image(s)${savedNote}`);
    totalAdded += added;
    totalSkipped += skipped;
    totalSaved += savedBytes;
  }

  const { count: recompressed, savedBytes: recompressSaved } = await recompressExisting(byHash);
  if (recompressed) {
    console.log(`  recompressed ${recompressed} existing image(s), saved ${formatBytes(recompressSaved)}`);
    totalSaved += recompressSaved;
  }

  const legacyRemoved = removeLegacyFiles();
  if (legacyRemoved) {
    console.log(`  removed ${legacyRemoved} legacy img-*.jpg file(s)`);
  }

  const images = Object.values(byHash);
  const totalBytes = images.reduce((sum, img) => sum + (img.bytes ?? 0), 0);
  const manifest = {
    images,
    byDate: rebuildByDate(images),
    extractedAt: new Date().toISOString(),
    storageBytes: totalBytes,
  };

  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), "utf8");
  const savedNote = totalSaved > 0 ? `, ${formatBytes(totalSaved)} saved` : "";
  console.log(
    `Images: ${images.length} total (${totalAdded} new, ${totalSkipped} deduped) — ${formatBytes(totalBytes)} on disk${savedNote}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
