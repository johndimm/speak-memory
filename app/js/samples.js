// "Sample lives" — famous people and entities whose journals the model invents. Each lives in its
// OWN isolated database and settings (see journal.js), completely separate from your real journal.
// Opening one the first time generates it (entries + memories) and caches it; after that it's
// instant. Nabokov leads the list — a small repayment for borrowing the name of his memoir.

import { escapeHtml } from "./render.js";
import { seedJournal } from "./db.js";
import { dbNameFor, jkey, switchJournal, listJournals, registerJournal, journalExists, deleteJournal, slugify, activeJournalId } from "./journal.js";

// Curated picks. kind is a hint to the model; it decides the final person/entity. `thumb` is an
// emoji shown on the card (offline-safe — the app can't load external images); custom subjects get
// a tinted monogram instead.
const PICKS = [
  { name: "Vladimir Nabokov", kind: "person", note: "the namesake", thumb: "🦋" },
  { name: "Keanu Reeves", kind: "person", thumb: "🕶️" },
  { name: "Leonardo DiCaprio", kind: "person", thumb: "🎬" },
  { name: "Jim Carrey", kind: "person", thumb: "🎭" },
  { name: "Donald Trump", kind: "person", thumb: "🏛️" },
  { name: "Zohran Mamdani", kind: "person", thumb: "🗳️" },
  { name: "The Beatles", kind: "entity", thumb: "🎸" },
  { name: "Saturday Night Live", kind: "entity", thumb: "📺" },
  { name: "The United States", kind: "entity", thumb: "🗽" },
  { name: "Marvel Comics", kind: "entity", thumb: "💥" },
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
function thumbHtml(name, emoji) {
  if (emoji) return `<span class="sample-thumb" aria-hidden="true">${emoji}</span>`;
  return `<span class="sample-thumb sample-thumb-mono" aria-hidden="true" style="background:${tint(name)}">${escapeHtml(monogram(name))}</span>`;
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

  const banner = active
    ? `<div class="sample-banner">You're reading a sample life. Your own journal is untouched.
         <button type="button" class="sample-back" id="sample-back">← Back to your journal</button></div>`
    : "";

  const pickCard = (name, kind, id, ready, note, emoji) =>
    `<button type="button" class="sample-card${active === id ? " active" : ""}" data-open="${escapeHtml(id)}" data-name="${escapeHtml(name)}" data-kind="${escapeHtml(kind)}">
       ${thumbHtml(name, emoji)}
       <span class="sample-text">
         <span class="sample-name">${escapeHtml(name)}</span>
         <span class="sample-tag">${ready ? "ready" : (kind === "entity" ? "entity" : "person")}${note ? ` · ${escapeHtml(note)}` : ""}</span>
       </span>
     </button>`;

  const picks = PICKS.map((p) => { const id = slugify(p.name); return pickCard(p.name, p.kind, id, readyIds.has(id), p.note, p.thumb); }).join("");
  const customCards = custom.map((j) =>
    `<div class="sample-card-wrap">
       ${pickCard(j.title || j.id, j.kind || "person", j.id, true, "", j.thumb)}
       <button type="button" class="sample-del" data-del="${escapeHtml(j.id)}" title="Delete this sample" aria-label="Delete">×</button>
     </div>`).join("");

  return `
    <h2 class="settings-h">Sample lives</h2>
    <p class="field-hint" style="margin-bottom:0.9rem">Fictional journals the app dreams up for famous people and things — each written in the first person across a whole life. They live in their own separate space; your journal stays private and untouched. The first time you open one it's generated (up to a minute); after that it's saved and instant.</p>
    ${banner}
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
  const status = root.querySelector("#sample-status");
  let busy = false;
  const setStatus = (msg, kind = "") => { status.textContent = msg; status.className = `sample-status${kind ? " " + kind : ""}`; };

  async function openJournal(id, name, kindHint) {
    if (!id) return;
    if (journalExists(id)) { switchJournal(id); return; } // already generated → just switch (reloads)
    if (busy) return;
    busy = true;
    root.querySelectorAll("button").forEach((b) => (b.disabled = true));
    setStatus(`Dreaming up ${name}'s whole life — this usually takes up to a minute. Hang tight…`, "working");
    try {
      const data = await postGenerate(name, kindHint || "");
      const meta = data.meta || {};
      await seedJournal(dbNameFor(id), { entries: data.entries || [], memories: data.memories || [] });
      // Per-journal settings, written under the sample's namespace before we switch into it.
      localStorage.setItem(jkey("journal-title", id), meta.title || name);
      localStorage.setItem(jkey("year-grouping", id), meta.grouping === "calendar" ? "calendar" : (meta.kind === "entity" ? "calendar" : "life"));
      if (meta.birthYear) localStorage.setItem(jkey("birth-year", id), String(meta.birthYear));
      registerJournal({ id, title: meta.title || name, kind: meta.kind || "person", subtitle: "" });
      setStatus(`Ready! Opening ${meta.title || name}…`, "ok");
      switchJournal(id); // reloads into the new isolated journal
    } catch (e) {
      setStatus(`Couldn't generate that one: ${e.message}. ${llmOverrides().apiKey ? "" : "You may need to add an API key in the AI model section above."}`, "error");
      root.querySelectorAll("button").forEach((b) => (b.disabled = false));
      busy = false;
    }
  }

  root.addEventListener("click", (e) => {
    const back = e.target.closest("#sample-back");
    if (back) { switchJournal(""); return; }
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
