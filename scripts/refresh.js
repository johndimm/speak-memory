import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const STEPS = [
  ["fetch", "Fetching Google Doc..."],
  ["parse", "Parsing dates..."],
  ["extract-images", "Extracting images..."],
  ["summarize", "Summarizing with LLM..."],
  ["build", "Building journal.json..."],
];

function run(script) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [join(ROOT, "scripts", `${script}.js`)], {
      cwd: ROOT,
      stdio: "inherit",
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited with code ${code}`));
    });
  });
}

async function main() {
  console.log("=== Journal refresh ===\n");
  const start = Date.now();

  await run("fetch");
  await run("parse");
  await run("extract-images");

  try {
    await run("summarize");
  } catch (err) {
    console.warn(`Summarize step: ${err.message}`);
    console.warn("Continuing with cached summaries...");
  }

  // build-summaries only (parse already ran)
  await run("build-summaries");

  const secs = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n=== Done in ${secs}s ===`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
