// Split the Pepys diary into one raw-text import file per day. No LLM — the app
// generates the prose + outline summaries when you import each day.
//   node gen-pepys-days.mjs [count|all] [startIndex]
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = `${ROOT}/pepys-import.json`;
const OUTDIR = `${ROOT}/pepys-days`;

const src = JSON.parse(readFileSync(SRC, "utf8"));
const arg = process.argv[2] || "all";
const START = parseInt(process.argv[3] || "0", 10);
const COUNT = arg === "all" ? src.entries.length : parseInt(arg, 10);
const days = src.entries.slice(START, START + COUNT);

mkdirSync(OUTDIR, { recursive: true });

for (let k = 0; k < days.length; k++) {
  const e = days[k];
  const bundle = {
    version: 1,
    source: "Pepys — one raw day",
    entries: [{ date: e.date, dayOfWeek: e.dayOfWeek, raw: e.full }],
  };
  const seq = String(START + k + 1).padStart(4, "0");
  writeFileSync(`${OUTDIR}/${seq}-${e.date}.json`, JSON.stringify(bundle));
}

console.log(`Wrote ${days.length} raw day file(s) to ${OUTDIR}`);
console.log(`First: 0001-${src.entries[0].date}.json  Last: ${String(START + days.length).padStart(4, "0")}-${days[days.length - 1].date}.json`);
