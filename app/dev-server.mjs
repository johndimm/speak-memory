// Minimal local dev server — serves the static app and runs /api functions directly.
// Avoids `vercel dev` (which fails on Node 25). Loads the key from .env.local.
//   node dev-server.mjs        → http://localhost:3000
import { createServer } from "http";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { extname, join, normalize, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

// Load .env.local into process.env for the API handlers.
try {
  const env = await readFile(join(ROOT, ".env.local"), "utf8");
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
} catch { /* no .env.local */ }

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};

function readBody(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
  });
}

async function runApi(name, req, res) {
  const mod = await import(`./api/${name}.js`);
  const body = await readBody(req);
  let code = 200, payload;
  const vres = { status(c) { code = c; return this; }, json(o) { payload = o; return this; } };
  try {
    await mod.default({ method: req.method, body }, vres);
  } catch (err) {
    code = 500;
    payload = { error: err.message };
    console.error(`/api/${name} crashed:`, err);
  }
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload ?? {}));
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let path = decodeURIComponent(url.pathname);

  if (path.startsWith("/api/")) {
    const name = path.slice(5);
    if (name === "summarize" || name === "chat") return runApi(name, req, res);
    res.writeHead(404); return res.end("Not found");
  }

  if (path === "/") path = "/index.html";
  const file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404); return res.end("Not found"); }
  const data = await readFile(file);
  res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
  res.end(data);
}).listen(PORT, () => {
  console.log(`Local dev server → http://localhost:${PORT}`);
  console.log(process.env.DEEPSEEK_API_KEY ? "DEEPSEEK_API_KEY loaded ✓" : "⚠ DEEPSEEK_API_KEY missing — add it to app/.env.local");
});
