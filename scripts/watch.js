import { spawn } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { loadEnv } from "./lib/llm.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

loadEnv();

const INTERVAL_MS =
  (parseInt(process.env.REFRESH_INTERVAL_MINUTES || "30", 10) || 30) * 60 * 1000;

function txtHash() {
  const path = join(ROOT, "journal-raw.txt");
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  return text.length + ":" + text.slice(-200);
}

function runRefresh() {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [join(ROOT, "scripts", "refresh.js")], {
      cwd: ROOT,
      stdio: "inherit",
    });
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  });
}

async function poll() {
  const before = txtHash();
  console.log(`\n[${new Date().toLocaleString()}] Checking for doc changes...`);

  try {
    const fetchOnly = spawn("node", [join(ROOT, "scripts", "fetch.js")], {
      cwd: ROOT,
      stdio: "pipe",
    });
    await new Promise((r) => fetchOnly.on("close", r));

    const after = txtHash();
    if (before !== after) {
      console.log("Doc changed — running full refresh...");
      await runRefresh();
    } else {
      console.log("No changes.");
    }
  } catch (err) {
    console.error("Watch error:", err.message);
  }
}

console.log(`Watching Google Doc every ${INTERVAL_MS / 60000} minutes.`);
console.log("Press Ctrl+C to stop.\n");

await runRefresh();

setInterval(poll, INTERVAL_MS);
