// "Sample lives" — famous people and entities whose journals the model invents. Each lives in its
// OWN isolated database and settings (see journal.js), completely separate from your real journal.
// Opening one the first time generates it (entries + memories) and caches it; after that it's
// instant. Nabokov leads the list — a small repayment for borrowing the name of his memoir.

import { escapeHtml } from "./render.js";
import { seedJournal, seedBaked } from "./db.js";
import { dbNameFor, jkey, switchJournal, listJournals, registerJournal, journalExists, deleteJournal, slugify, activeJournalId } from "./journal.js";

// Curated picks. kind is a hint to the model; it decides the final person/entity. `thumb` is an
// emoji shown on the card (offline-safe — the app can't load external images); custom subjects get
// a tinted monogram instead.
const PICKS = [
  { name: "Vladimir Nabokov", kind: "person", note: "the namesake" },
  { name: "Hedy Lamarr", kind: "person" },
  { name: "Samuel Pepys", kind: "person", note: "his real 1660s diary" },
  { name: "Saturday Night Live", kind: "entity" },
];

// A stable, subtle tint from a name (for monogram tiles) and its initials (1–2 letters).
function tint(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h}, 42%, 84%)`;
}
function monogram(name) {
  const words = String(name).replace(/^(the|a)\s+/i, "").trim().split(/\s+/).filter(Boolean);
  const letters = (words.length >= 2 ? words[0][0] + words[1][0] : (words[0] || "?").slice(0, 2));
  return letters.toUpperCase();
}
// The thumbnail starts as a tinted monogram (so cards render instantly and offline); wirePhotos
// then upgrades it to the subject's Wikipedia lead photo when one resolves. Works for curated and
// custom subjects alike; the monogram simply stays when there's no photo.
function thumbHtml(name, id) {
  return `<span class="sample-thumb sample-thumb-mono photo-slot" data-name="${escapeHtml(name)}" style="background:${tint(name)}" aria-hidden="true">${escapeHtml(monogram(name))}</span>`;
}

// Resolve a subject → its Wikipedia lead-image URL (small thumb), cached in localStorage. "" means
// "looked, none found" so we don't re-query. Wikipedia's API allows anonymous CORS via origin=*.
async function wikiThumb(title) {
  const cacheKey = "wikithumb::" + title;
  const cached = localStorage.getItem(cacheKey);
  if (cached !== null) return cached || null;
  try {
    const url = `https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&redirects=1&prop=pageimages&piprop=thumbnail&pithumbsize=200&titles=${encodeURIComponent(title)}`;
    const j = await (await fetch(url)).json();
    const page = Object.values(j.query?.pages || {})[0] || {};
    const src = page.thumbnail?.source || "";
    localStorage.setItem(cacheKey, src);
    return src || null;
  } catch { return null; }
}

function wirePhotos(root) {
  root.querySelectorAll(".photo-slot").forEach(async (slot) => {
    const src = await wikiThumb(slot.dataset.name || "");
    if (!src) return; // keep the monogram
    const img = new Image();
    img.className = "sample-thumb sample-photo";
    img.alt = "";
    img.loading = "lazy";
    img.onload = () => { if (slot.isConnected) slot.replaceWith(img); };
    img.src = src; // if it fails to load, the monogram simply stays
  });
}

function llmOverrides() {
  return {
    provider: localStorage.getItem("llm-provider") || "",
    apiKey: localStorage.getItem("llm-api-key") || "",
    model: localStorage.getItem("llm-model") || "",
    baseUrl: localStorage.getItem("llm-base-url") || "",
  };
}

async function postGenerate(subject, kindHint) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000); // generation is a big single call
  try {
    const r = await fetch("/api/summarize", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...llmOverrides(), mode: "generate", subject, kindHint }), signal: ctrl.signal,
    });
    if (!r.ok) { let msg = `Server ${r.status}`; try { msg = (await r.json()).error || msg; } catch { /* */ } throw new Error(msg); }
    return await r.json();
  } finally { clearTimeout(timer); }
}

export function renderJournalsSection() {
  const active = activeJournalId();
  const registry = listJournals();
  const readyIds = new Set(registry.map((j) => j.id));
  const curatedSlugs = new Set(PICKS.map((p) => slugify(p.name)));
  const custom = registry.filter((j) => !curatedSlugs.has(j.id));

  const ownTitle = localStorage.getItem("journal-title") || "Speak, Memory";
  const ownCard = `<button type="button" class="sample-card${active === "" ? " active" : ""}" data-own="1">
       <span class="sample-thumb sample-thumb-mono" aria-hidden="true" style="background:${tint(ownTitle)}">${escapeHtml(monogram(ownTitle))}</span>
       <span class="sample-text"><span class="sample-name">${escapeHtml(ownTitle)}</span><span class="sample-tag">your journal</span></span>
     </button>`;

  const pickCard = (name, kind, id, ready, note) =>
    `<button type="button" class="sample-card${active === id ? " active" : ""}" data-open="${escapeHtml(id)}" data-name="${escapeHtml(name)}" data-kind="${escapeHtml(kind)}">
       ${thumbHtml(name, id)}
       <span class="sample-text">
         <span class="sample-name">${escapeHtml(name)}</span>
         <span class="sample-tag">${ready ? "ready" : (kind === "entity" ? "entity" : "person")}${note ? ` · ${escapeHtml(note)}` : ""}</span>
       </span>
     </button>`;

  const picks = PICKS.map((p) => { const id = slugify(p.name); return pickCard(p.name, p.kind, id, readyIds.has(id), p.note); }).join("");
  const customCards = custom.map((j) =>
    `<div class="sample-card-wrap">
       ${pickCard(j.title || j.id, j.kind || "person", j.id, true, "")}
       <button type="button" class="sample-del" data-del="${escapeHtml(j.id)}" title="Delete this sample" aria-label="Delete">×</button>
     </div>`).join("");

  return `
    <h2 class="settings-h">Lives</h2>
    <p class="field-hint" style="margin-bottom:1rem">Your own journal, plus fictional lives the app dreams up for famous people and things — each written in the first person across a whole life. Sample lives live in their own separate space; your journal stays private and untouched. The first time you open a sample it's generated (up to a minute), then saved and instant.</p>
    <p class="nav-hint">Your journal</p>
    <div class="sample-grid">${ownCard}</div>
    <p class="nav-hint" style="margin-top:1.2rem">Sample lives</p>
    <div class="sample-grid">${picks}${customCards}</div>
    <label class="field" style="margin-top:1rem">
      <span class="field-label" for="sample-input">Or dream up anyone</span>
      <div class="sample-gen-row">
        <input type="text" id="sample-input" class="settings-input" autocomplete="off" placeholder="a person, band, show, place, company…">
        <button type="button" class="sample-gen-btn" id="sample-gen">Generate</button>
      </div>
    </label>
    <p class="sample-status" id="sample-status" role="status"></p>`;
}

export function wireJournalsSection(root) {
  wirePhotos(root); // upgrade the monogram tiles to Wikipedia photos where available
  const status = root.querySelector("#sample-status");
  let busy = false;
  const setStatus = (msg, kind = "") => { status.textContent = msg; status.className = `sample-status${kind ? " " + kind : ""}`; };

  // A subject's pre-baked bundle, if one was shipped (curated picks). Fully summarized → instant.
  // Revalidate against the server so an updated bundle (e.g. new images) isn't masked by HTTP cache.
  async function fetchBundle(id) {
    try {
      const r = await fetch(`./data/samples/${id}.json`, { cache: "no-cache" });
      if (!r.ok) return null;
      const b = await r.json();
      return (b && b.sample) ? b : null;
    } catch { return null; }
  }

  function applyMeta(id, meta, name) {
    localStorage.setItem(jkey("journal-title", id), meta.title || name);
    localStorage.setItem(jkey("year-grouping", id), meta.grouping === "calendar" ? "calendar" : (meta.kind === "entity" ? "calendar" : "life"));
    if (meta.birthYear) localStorage.setItem(jkey("birth-year", id), String(meta.birthYear));
  }

  async function seedFromBundle(id, name, bundle) {
    await seedBaked(dbNameFor(id), bundle);
    applyMeta(id, bundle.meta || {}, name);
    localStorage.setItem(jkey("baked", id), "1"); // prebuilt: skip the background pass
    localStorage.setItem(jkey("built", id), bundle.builtAt || ""); // track shipped version for re-seeding
    registerJournal({ id, title: bundle.meta?.title || name, kind: bundle.meta?.kind || "person", subtitle: "" });
  }

  async function openJournal(id, name, kindHint) {
    if (!id) return;
    if (journalExists(id)) {
      // Already loaded. For a curated pick, re-seed first if the shipped bundle is newer (e.g. images
      // were added since it was last opened) so a stale local copy doesn't mask the update.
      try {
        const fresh = await fetchBundle(id);
        if (fresh && (fresh.builtAt || "") !== (localStorage.getItem(jkey("built", id)) || "")) {
          await seedFromBundle(id, name, fresh);
        }
      } catch { /* offline or no bundle → keep what's stored */ }
      switchJournal(id);
      return;
    }
    if (busy) return;
    busy = true;
    root.querySelectorAll("button").forEach((b) => (b.disabled = true));
    try {
      // Fast path: a shipped, fully-summarized bundle. No model calls — load and open.
      const bundle = await fetchBundle(id);
      if (bundle) {
        setStatus(`Opening ${bundle.meta?.title || name}…`, "working");
        await seedFromBundle(id, name, bundle);
        switchJournal(id);
        return;
      }
      // Slow path (custom subjects): generate raw content; the client summarizes on open.
      setStatus(`Dreaming up ${name}'s whole life — this usually takes up to a minute. Hang tight…`, "working");
      const data = await postGenerate(name, kindHint || "");
      const meta = data.meta || {};
      await seedJournal(dbNameFor(id), { entries: data.entries || [], memories: data.memories || [] });
      applyMeta(id, meta, name);
      registerJournal({ id, title: meta.title || name, kind: meta.kind || "person", subtitle: "" });
      setStatus(`Ready! Opening ${meta.title || name}…`, "ok");
      switchJournal(id); // reloads into the new isolated journal
    } catch (e) {
      setStatus(`Couldn't open that one: ${e.message}. ${llmOverrides().apiKey ? "" : "You may need to add an API key in the AI model section above."}`, "error");
      root.querySelectorAll("button").forEach((b) => (b.disabled = false));
      busy = false;
    }
  }

  root.addEventListener("click", (e) => {
    const own = e.target.closest("[data-own]");
    if (own) { switchJournal(""); return; } // back to your own journal
    const del = e.target.closest("[data-del]");
    if (del) {
      const id = del.dataset.del;
      if (id === activeJournalId()) { setStatus("Switch back to your journal before deleting the one you're reading.", "error"); return; }
      if (confirm("Delete this sample life? It can be regenerated later.")) { deleteJournal(id); root.innerHTML = renderJournalsSection(); wireJournalsSection(root); }
      return;
    }
    const open = e.target.closest("[data-open]");
    if (open) { openJournal(open.dataset.open, open.dataset.name, open.dataset.kind); return; }
    const gen = e.target.closest("#sample-gen");
    if (gen) {
      const input = root.querySelector("#sample-input");
      const name = (input.value || "").trim();
      if (!name) { input.focus(); return; }
      openJournal(slugify(name), name, "");
      return;
    }
  });

  root.querySelector("#sample-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); root.querySelector("#sample-gen").click(); }
  });
}
