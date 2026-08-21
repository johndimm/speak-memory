import { mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { loadDocs, getFetchableDocs } from "./lib/docs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const RAW_DIR = join(ROOT, "data", "raw");

async function fetchOne(doc) {
  const txtUrl = `https://docs.google.com/document/d/${doc.id}/export?format=txt`;
  const htmlUrl = `https://docs.google.com/document/d/${doc.id}/export?format=html`;
  const key = doc.weekStart;

  const [txtRes, htmlRes] = await Promise.all([fetch(txtUrl), fetch(htmlUrl)]);
  if (!txtRes.ok) throw new Error(`${key}: text export failed (${txtRes.status})`);
  if (!htmlRes.ok) throw new Error(`${key}: HTML export failed (${htmlRes.status})`);

  const text = await txtRes.text();
  const html = await htmlRes.text();

  mkdirSync(RAW_DIR, { recursive: true });
  const txtPath = join(RAW_DIR, `${key}.txt`);
  const htmlPath = join(RAW_DIR, `${key}.html`);
  writeFileSync(txtPath, text, "utf8");
  writeFileSync(htmlPath, html, "utf8");

  const tag = doc.status === "active" ? "active" : "archived";
  console.log(`  [${tag}] ${doc.label ?? key}: txt ${text.length}, html ${html.length} bytes`);
  return { key, text, html, doc };
}

async function main() {
  const config = loadDocs();
  const docs = getFetchableDocs(config);

  if (!docs.length) {
    console.log("No Google Docs configured.");
    if (config.active && !config.active.id) {
      console.log("\nActive week has no doc ID yet.");
      console.log("1. Create a new Google Doc (anyone with link can view)");
      console.log(`2. Title suggestion: The Days of our lives — ${config.active.label}`);
      console.log("3. Run: npm run set-doc -- <DOC_ID>");
    }
    return;
  }

  console.log(`Fetching ${docs.length} doc(s)...`);
  const fetched = [];
  for (const doc of docs.sort((a, b) => a.weekStart.localeCompare(b.weekStart))) {
    fetched.push(await fetchOne(doc));
  }

  const combined = fetched.map((f) => f.text).join("\n\n");
  writeFileSync(join(ROOT, "journal-raw.txt"), combined, "utf8");
  console.log(`\nCombined journal-raw.txt (${combined.length} bytes)`);

  if (config.active && !config.active.id) {
    console.log("\nNote: active week doc not set — new entries won't be captured until you run:");
    console.log("  npm run set-doc -- <DOC_ID>");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
