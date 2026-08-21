import { loadDocs, saveDocs, sundayWeekStart, weekLabelFromStart } from "./lib/docs.js";

const config = loadDocs();
const today = sundayWeekStart(new Date());

if (config.active?.id) {
  const existing = config.docs.find((d) => d.id === config.active.id);
  if (!existing) {
    config.docs.push({
      id: config.active.id,
      weekStart: config.active.weekStart,
      label: config.active.label ?? weekLabelFromStart(config.active.weekStart),
      status: "archived",
      archivedAt: new Date().toISOString().slice(0, 10),
    });
    config.docs.sort((a, b) => a.weekStart.localeCompare(b.weekStart));
    console.log(`Archived: ${config.active.label} (${config.active.id})`);
  }
}

config.active = {
  id: null,
  weekStart: today,
  label: `Week of ${new Date(today + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`,
};

saveDocs(config);

console.log(`\nNew week started: ${config.active.label} (${today})`);
console.log("\nNext steps:");
console.log("1. In Google Drive, create a new Doc:");
console.log(`   Title: The Days of our lives — ${config.active.label}`);
console.log("   Sharing: Anyone with the link can view");
console.log("2. Copy the doc ID from the URL");
console.log("3. Run: npm run set-doc -- <DOC_ID>");
console.log("4. Run: npm run refresh");
