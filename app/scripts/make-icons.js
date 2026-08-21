// Generates the home-screen / PWA icons into app/icons/.
//   node app/scripts/make-icons.js
// Uses sharp from the parent project's node_modules.

import sharp from "sharp";
import { mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "icons");
mkdirSync(OUT, { recursive: true });

// Warm paper background with an accent sun + rays — matches the app's palette.
const cx = 256, cy = 252;
const rays = Array.from({ length: 12 }, (_, i) => {
  const a = (i * Math.PI * 2) / 12 - Math.PI / 2;
  const r1 = 132, r2 = 168;
  return `<line x1="${cx + Math.cos(a) * r1}" y1="${cy + Math.sin(a) * r1}" x2="${cx + Math.cos(a) * r2}" y2="${cy + Math.sin(a) * r2}"/>`;
}).join("");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#efe4d2"/>
  <g stroke="#c45c26" stroke-width="20" stroke-linecap="round">${rays}</g>
  <circle cx="${cx}" cy="${cy}" r="92" fill="#c45c26"/>
</svg>`;

const buf = Buffer.from(svg);

async function png(size, name) {
  await sharp(buf).resize(size, size).png().toFile(join(OUT, name));
  console.log(`  ${name} (${size}×${size})`);
}

await png(192, "icon-192.png");
await png(512, "icon-512.png");
await png(512, "icon-maskable-512.png"); // design sits inside the safe zone already
await png(180, "apple-touch-icon.png");
console.log(`Icons written to ${OUT}`);
