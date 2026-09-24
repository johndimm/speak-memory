// "Futures" tab — imagine the journal continuing, then STEP INTO it.
//
// Starting a future is a background job: it appears in the list right away with live status
// ("Imagining… 0:23"), while /api/future writes raw diary days grounded in your real people and
// threads. When it's ready, click it to step in — it's seeded into its OWN isolated journal
// database (like a "sample life", see journal.js), so Journal, Timeline, Graph and Places all
// become that future. The normal background pass (calendar.js autoSummarize) then fills in the
// prose/outline and the period ladder as you watch. Switch back to your real journal anytime.
//
// No duplicated data: only the RAW days are stored, once, in the future's own database. Metadata
// and status live on the journals registry (journal.js); nothing is copied into localStorage and
// nothing lands in your real journal's store.

import { getAllEntries, getAllEntities, getAllMemories, seedJournal } from "./db.js";
import { escapeHtml } from "./render.js";
import {
  dbNameFor, switchJournal, listJournals, registerJournal, journalExists,
  deleteJournal, slugify, activeJournalId, isSampleJournal, jkey,
} from "./journal.js";

const GEN_TIMEOUT_MS = 180000; // one big generation call; abort if it hangs

// The futures created on this device — sample journals tagged kind:"future", newest first.
function futureList() {
  return listJournals().filter((j) => j.kind === "future").sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}
function getFuture(id) { return futureList().find((f) => f.id === id); }
// A future with no status (made before status tracking) is treated as ready.
function statusOf(f) { return f.status || "ready"; }

function newFutureId(endYear, nudge) {
  const base = `future-${endYear}-${slugify(nudge) || "ahead"}`.slice(0, 55);
  let id = base, n = 2;
  while (journalExists(id)) id = `${base}-${n++}`;
  return id;
}

function elapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function initFutures(root) {
  let composeYears = 10;
  let composeCount = 8; // how many future diary entries to generate (user-controllable)
  const activeGen = new Set(); // ids generating in THIS session (survives tab switches, not reloads)
  let tick = null;

  // ---- rendering -------------------------------------------------------------------------
  function cardTag(f) {
    const st = statusOf(f);
    if (st === "generating") return `<span class="fut-card-tag fut-gen" data-gen="${escapeHtml(f.id)}">◷ Imagining…</span>`;
    if (st === "error") return `<span class="fut-card-tag fut-err">⚠ ${escapeHtml(f.error || "Failed")} — tap to retry</span>`;
    return `<span class="fut-card-tag">${f.years ? `${f.years}-year future` : "future"} · tap to step in</span>`;
  }

  // The list of futures — rebuilt on its own so a background update never clobbers the composer.
  function galleryHtml() {
    const futures = futureList();
    const cards = futures.map((f) => `
      <div class="fut-card-wrap">
        <button type="button" class="fut-card fut-${statusOf(f)}${f.id === activeJournalId() ? " active" : ""}" data-open="${escapeHtml(f.id)}">
          <span class="fut-card-year">${f.endYear || ""}</span>
          <span class="fut-card-text">
            <span class="fut-card-title">${escapeHtml(f.nudge ? f.nudge : "Straight ahead")}</span>
            ${cardTag(f)}
          </span>
        </button>
        ${statusOf(f) === "ready" ? `<button type="button" class="fut-card-reveal" data-reveal="${escapeHtml(f.id)}" title="Play the audio reveal">▶ Reveal</button>` : ""}
        <button type="button" class="fut-card-del" data-del="${escapeHtml(f.id)}" title="Delete this future" aria-label="Delete">×</button>
      </div>`).join("");
    return `
      <p class="nav-hint">Your futures</p>
      <p class="field-hint" style="margin:0 0 0.8rem">A future appears here as soon as you start it. When it's ready, open it to step in — Journal, Timeline, and Graph all become that life.</p>
      ${futures.length
        ? `<div class="fut-grid">${cards}</div>`
        : `<p class="fut-empty">No futures yet. Imagine one above and it'll show up here.</p>`}`;
  }

  // Refresh only the list (composer DOM and any half-typed nudge stay put).
  function renderGallery() {
    const g = root.querySelector(".fut-gallery");
    if (!g) { render(); return; }
    g.innerHTML = galleryHtml();
    updateGenLabels();
  }

  function render() {
    const inFuture = isSampleJournal();
    root.innerHTML = `
      <div class="futures">
        ${inFuture ? `
          <div class="fut-inbanner">
            <span>You're living in an imagined future. This isn't your real journal.</span>
            <span class="fut-inbanner-btns">
              <button type="button" class="fut-reveal" id="fut-reveal">▶ Play the reveal</button>
              <button type="button" class="fut-back" id="fut-back">← Back to your real journal</button>
            </span>
          </div>` : ""}

        <div class="fut-compose">
          <h2 class="fut-title">Imagine forward</h2>
          <p class="fut-lead">Let the journal keep going. The app writes raw diary days across the coming years —
            grounded in your real people and threads — then opens them as a life you can browse in Journal,
            Timeline, and Graph. Leave the nudge blank to just see where things drift, or push the future one
            way with a decision, a hope, or a fear.</p>
          <p class="fut-lead" style="margin-top:0">The more I know about your life, the sharper the fortune.
            <button type="button" class="fut-interview" id="fut-interview">🎙 Tell me your story</button></p>
          <textarea id="fut-nudge" class="fut-nudge" rows="2"
            placeholder="Optional nudge — e.g. “we move to the coast”, “I finally finish the book”, “what if I never do”. Blank is fine."></textarea>
          <div class="fut-controls">
            <div class="fut-horizons" role="group" aria-label="How far ahead">
              <button class="fut-h${composeYears === 10 ? " active" : ""}" data-years="10">10 years</button>
              <button class="fut-h${composeYears === 20 ? " active" : ""}" data-years="20">20 years</button>
            </div>
            <label class="fut-count">
              <span>Entries</span>
              <input type="number" id="fut-count" min="2" max="40" step="1" value="${composeCount}" inputmode="numeric">
            </label>
            <button id="fut-go" class="fut-go">Imagine ›</button>
          </div>
          <div id="fut-status" class="fut-status" hidden></div>
        </div>

        <div class="fut-bucket" id="fut-bucket">${bucketHtml()}</div>

        <div class="fut-gallery">${galleryHtml()}</div>
      </div>`;

    wire();
    updateGenLabels();
  }

  // ---- Bucket list (per journal) — things you want to do; a Future can weave them all in ----------
  function getBucket() { try { return JSON.parse(localStorage.getItem(jkey("bucket-list")) || "[]").filter((x) => typeof x === "string"); } catch { return []; } }
  function setBucket(items) { try { localStorage.setItem(jkey("bucket-list"), JSON.stringify(items)); } catch { /* */ } }
  function bucketHtml() {
    const items = getBucket();
    const rows = items.map((it, i) => `<li class="bucket-item"><span>${escapeHtml(it)}</span><button type="button" class="bucket-del" data-bucket-del="${i}" aria-label="Remove">×</button></li>`).join("");
    return `
      <h2 class="fut-title">Bucket list</h2>
      <p class="fut-lead">Things you want to do while there's time. Add them here, then let the fortune imagine a life that gets to them all.</p>
      <ul class="bucket-list">${rows || `<li class="bucket-empty">Nothing yet — what do you want to do before it's too late?</li>`}</ul>
      <form class="bucket-add" id="bucket-add-form">
        <input type="text" id="bucket-input" autocomplete="off" placeholder="e.g. see the northern lights, learn piano, mend things with Dad…">
        <button type="submit" class="bucket-addbtn">Add</button>
      </form>
      ${items.length ? `<button type="button" class="fut-go bucket-fulfill" id="bucket-fulfill">🔮 Imagine a future that does them all ›</button>` : ""}`;
  }
  function refreshBucket() { const el = root.querySelector("#fut-bucket"); if (el) { el.innerHTML = bucketHtml(); wireBucket(); } }

  function wire() {
    const nudge = root.querySelector("#fut-nudge");
    root.querySelectorAll(".fut-h").forEach((b) =>
      b.addEventListener("click", () => {
        composeYears = Number(b.dataset.years);
        root.querySelectorAll(".fut-h").forEach((x) => x.classList.toggle("active", x === b));
      }));
    const countEl = root.querySelector("#fut-count");
    countEl?.addEventListener("input", () => {
      const n = parseInt(countEl.value, 10);
      if (Number.isFinite(n)) composeCount = Math.max(2, Math.min(40, n));
    });
    root.querySelector("#fut-go")?.addEventListener("click", () => startFuture(nudge.value, composeYears, composeCount));
    root.querySelector("#fut-interview")?.addEventListener("click", async () => {
      const { startLifeInterview } = await import("./lifeinterview.js");
      startLifeInterview((saved) => { if (saved) setStatus("ok", `Added ${saved} memor${saved === 1 ? "y" : "ies"} — imagine a future to see them shape it.`); });
    });
    root.querySelector("#fut-back")?.addEventListener("click", () => switchJournal(""));
    root.querySelector("#fut-reveal")?.addEventListener("click", async () => {
      const f = getFuture(activeJournalId()) || {};
      const { playFutureShow } = await import("./audioshow.js");
      playFutureShow({ endYear: f.endYear, years: f.years, nudge: f.nudge });
    });
    wireBucket();
  }

  function wireBucket() {
    root.querySelector("#bucket-add-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const input = root.querySelector("#bucket-input");
      const v = (input && input.value || "").trim();
      if (!v) return;
      setBucket([...getBucket(), v]);
      refreshBucket();
    });
    root.querySelectorAll("[data-bucket-del]").forEach((b) => b.addEventListener("click", () => {
      const i = Number(b.dataset.bucketDel);
      const items = getBucket(); items.splice(i, 1); setBucket(items); refreshBucket();
    }));
    root.querySelector("#bucket-fulfill")?.addEventListener("click", () => {
      const items = getBucket();
      if (!items.length) return;
      const nudge = `Over these years I take on and fulfill my bucket list — I find a way to do each of these, and the diary shows how: ${items.join("; ")}.`;
      startFuture(nudge, composeYears, composeCount);
    });
  }

  function setStatus(cls, msg) {
    const status = root.querySelector("#fut-status");
    if (!status) return;
    status.hidden = false;
    status.className = `fut-status ${cls}`;
    status.textContent = msg;
  }

  // Tick the "Imagining… m:ss" labels on generating cards once a second.
  function updateGenLabels() {
    const gens = futureList().filter((f) => statusOf(f) === "generating");
    for (const f of gens) {
      const el = root.querySelector(`.fut-gen[data-gen="${CSS.escape(f.id)}"]`);
      if (el) el.textContent = `◷ Imagining… ${elapsed(Date.now() - (f.createdAt || Date.now()))}`;
    }
    if (gens.length && !tick) tick = setInterval(updateGenLabels, 1000);
    if (!gens.length && tick) { clearInterval(tick); tick = null; }
  }

  // ---- the background job ----------------------------------------------------------------
  async function startFuture(nudge, years, count) {
    nudge = (nudge || "").trim();
    count = Math.max(2, Math.min(40, Number(count) || 8));
    let entries;
    try {
      entries = (await getAllEntries()).map((e) => ({ date: e.date, dayOfWeek: e.dayOfWeek, brief: e.brief, full: e.full }));
    } catch { entries = []; }
    if (!entries.length) { setStatus("error", "Write a few days first — there's nothing to imagine forward from yet."); return; }

    const lastDate = entries.map((e) => e.date).filter(Boolean).sort().pop();
    const baseYear = (lastDate && Number(lastDate.slice(0, 4))) || new Date().getFullYear();
    const endYear = baseYear + years;
    const id = newFutureId(endYear, nudge);
    const title = nudge
      ? `${endYear}: ${nudge.length > 32 ? nudge.slice(0, 32) + "…" : nudge}`
      : `${endYear} — straight ahead`;

    // Register it right away so it shows in the list with a live status, then generate.
    registerJournal({ id, title, kind: "future", subtitle: nudge || "straight ahead", nudge, years, count, baseYear, endYear, createdAt: Date.now(), status: "generating" });
    renderGallery();
    runGeneration(id, entries);
  }

  async function runGeneration(id, entries) {
    activeGen.add(id);
    updateGenLabels();
    const f0 = getFuture(id);
    const { nudge = "", years = 10, count = 8 } = f0 || {};
    const finish = (patch) => {
      // The user may have deleted this future while it generated — if so, don't resurrect it.
      if (!getFuture(id) && patch.status !== undefined && patch.status !== "error") { activeGen.delete(id); return; }
      const cur = getFuture(id);
      if (cur) registerJournal({ ...cur, ...patch });
      activeGen.delete(id);
      renderGallery();
    };
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), GEN_TIMEOUT_MS);
      // Your life-states/memories ground the projection — the richer they are (e.g. from the life
      // interview), the more specific the future. Pass them alongside the journal entries.
      let baseMemories = [];
      try {
        baseMemories = (await getAllMemories()).map((m) => ({
          category: m.category || "Life", subject: m.subject || m.label || "",
          startYear: m.startYear, endYear: m.endYear,
          text: m.text || (m.prose && m.prose.full) || m.brief || "",
        }));
      } catch { baseMemories = []; }
      let data;
      try {
        const res = await fetch("/api/future", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entries, prompt: nudge, years, count, memories: baseMemories }), signal: ctrl.signal,
        });
        if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `Server ${res.status}`); }
        data = await res.json();
      } finally { clearTimeout(timer); }
      if (!Array.isArray(data.days) || !data.days.length) throw new Error("no days returned");

      // Was it deleted mid-flight? Then drop the result entirely (no orphan DB).
      if (!getFuture(id)) { activeGen.delete(id); return; }

      // Seed the RAW days into the future's own database. Summaries are generated when you open it.
      // Days become journal entries; imagined life-states become span memories → the Timeline lanes.
      const memories = Array.isArray(data.states) ? data.states.map((s) => ({
        category: s.category || "Life", subject: s.subject || "", label: s.subject || "",
        startYear: s.startYear, endYear: s.endYear, text: s.text || s.subject || "",
      })) : [];
      // Start the future knowing your real cast; imagined new names stay in the future's own DB.
      let entities = [];
      try { entities = await getAllEntities(); } catch { entities = []; }
      await seedJournal(dbNameFor(id), { entries: data.days.map((d) => ({ date: d.date, text: d.raw })), memories, entities });
      localStorage.setItem(jkey("journal-title", id), (getFuture(id) || {}).title || `${data.endYear}`);
      localStorage.setItem(jkey("year-grouping", id), "calendar");
      finish({ status: "ready", days: data.days.length });
    } catch (err) {
      const msg = err.name === "AbortError" ? "timed out" : (err.message || "failed");
      finish({ status: "error", error: msg.slice(0, 40) });
    }
  }

  function retry(f) {
    getAllEntries()
      .then((rows) => rows.map((e) => ({ date: e.date, dayOfWeek: e.dayOfWeek, brief: e.brief, full: e.full })))
      .then((entries) => {
        if (!entries.length) { setStatus("error", "No entries to imagine from — switch to your real journal first."); return; }
        registerJournal({ ...f, status: "generating", error: "", createdAt: Date.now() });
        renderGallery();
        runGeneration(f.id, entries);
      });
  }

  // ---- clicks (delegated once on the stable root) ----------------------------------------
  root.addEventListener("click", async (e) => {
    const reveal = e.target.closest("[data-reveal]");
    if (reveal) {
      e.stopPropagation();
      const id = reveal.dataset.reveal;
      if (id === activeJournalId()) { // already inside it → play now
        const { playFutureShow } = await import("./audioshow.js");
        const f = getFuture(id) || {};
        playFutureShow({ endYear: f.endYear, years: f.years, nudge: f.nudge });
      } else { // step into it, then auto-play on load
        try { sessionStorage.setItem("play-reveal", id); } catch { /* */ }
        switchJournal(id);
      }
      return;
    }
    const del = e.target.closest("[data-del]");
    if (del) {
      e.stopPropagation();
      const id = del.dataset.del;
      const f = getFuture(id);
      if (!f) return;
      if (!confirm("Delete this future? It can be imagined again later.")) return;
      if (id === activeJournalId()) {
        // Can't sit inside a journal we're deleting — leave to the real journal, then remove it.
        deleteJournal(id);
        switchJournal(""); // reloads into your own journal
      } else {
        deleteJournal(id);
        renderGallery();
      }
      return;
    }
    const open = e.target.closest("[data-open]");
    if (open) {
      const f = getFuture(open.dataset.open);
      if (!f) return;
      const st = statusOf(f);
      if (st === "ready") {
        // First step-in: land on the Graph so the summarization is visible as it happens.
        if (!f.opened) { try { sessionStorage.setItem("land-on-graph", f.id); } catch { /* ignore */ } registerJournal({ ...f, opened: true }); }
        switchJournal(f.id);
        return;
      }
      if (st === "error") { retry(f); return; }
      setStatus("working", `Still imagining ${f.endYear || "your future"}… this usually takes a minute or two. It'll say “step in” when it's ready.`);
    }
  });

  return {
    open() {
      // A future left "generating" with no in-flight job (e.g. the page was reloaded) was interrupted.
      for (const f of futureList()) {
        if (statusOf(f) === "generating" && !activeGen.has(f.id)) registerJournal({ ...f, status: "error", error: "interrupted" });
      }
      render();
    },
    close() { if (tick) { clearInterval(tick); tick = null; } },
  };
}
