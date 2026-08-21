import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const DOCS_PATH = join(ROOT, "data", "docs.json");

export function loadDocs() {
  if (!existsSync(DOCS_PATH)) return { rotation: "sunday", docs: [], active: null };
  return JSON.parse(readFileSync(DOCS_PATH, "utf8"));
}

export function saveDocs(config) {
  writeFileSync(DOCS_PATH, JSON.stringify(config, null, 2), "utf8");
}

export function getFetchableDocs(config = loadDocs()) {
  const list = [...(config.docs ?? [])];
  if (config.active?.id) list.push({ ...config.active, status: "active" });
  return list.filter((d) => d.id && !d.id.startsWith("PASTE_"));
}

export function sundayWeekStart(date = new Date()) {
  const d = new Date(date);
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d.toISOString().slice(0, 10);
}

export function weekLabelFromStart(weekStart) {
  const start = new Date(weekStart + "T12:00:00");
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  const fmt = (dt) => dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${fmt(start)} – ${fmt(end)}, ${start.getFullYear()}`;
}
