import { loadDocs, saveDocs, sundayWeekStart, weekLabelFromStart } from "./lib/docs.js";

const docId = process.argv[2];
if (!docId || docId.length < 20) {
  console.log("Usage: npm run set-doc -- <GOOGLE_DOC_ID>");
  console.log("\nThe ID is the long string in your doc URL:");
  console.log("  https://docs.google.com/document/d/DOC_ID/edit");
  process.exit(1);
}

const config = loadDocs();
if (!config.active) {
  console.error("No active week in docs.json — run npm run new-week first.");
  process.exit(1);
}

config.active.id = docId.trim();
config.active.label = config.active.label ?? weekLabelFromStart(config.active.weekStart);
saveDocs(config);

console.log(`Active doc set for ${config.active.label}`);
console.log(`  ID: ${config.active.id}`);
console.log("\nRun: npm run refresh");
