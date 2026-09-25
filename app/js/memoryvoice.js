// Hands-free MEMORY CAPTURE — for adding a SERIES of memories fast (your Places, Friends, Jobs…).
// Two phases per memory:
//   1) You describe what it is and when/where; the LLM fills the form (subject, years, location) live.
//   2) The screen flashes and you dictate the memory itself. It ends on ~5s silence or "done"/"over".
// Then it advances to the next, keeping the category, so you go through a whole list in one session.
// Say "stop" to end, "skip" to drop the current one.

import { putMemory } from "./db.js";
import { createSpeaker } from "./voicetts.js";
import { listenTurn as vListen, hasSpeechInput } from "./voiceinput.js";

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "m" + Date.now() + Math.random().toString(36).slice(2));

// A sensible starter set — the user can also type any category in Write.
export const DEFAULT_CATEGORIES = ["Homes", "Cities", "Family", "Relationships", "Friends", "Schools", "Jobs", "Vacations", "Successes", "Failures"];

async function postMemoryMeta(text, category, signal) {
  const r = await fetch("/api/summarize", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...llmOverrides(), mode: "memorymeta", text, category }),
    signal,
  });
  if (!r.ok) throw new Error(`meta ${r.status}`);
  return r.json();
}

// ---- Instant client-side keyword pass ------------------------------------------------------
// The form's own fields are the keywords. Years and category words are unambiguous, so we fill
// them the moment they're spoken — no round-trip. The LLM (below) handles the fuzzy "subject".

// Spoken word → the matching Category option.
const CAT_ALIASES = {
  home: "Homes", homes: "Homes", house: "Homes", apartment: "Homes", flat: "Homes",
  city: "Cities", cities: "Cities", town: "Cities",
  family: "Family",
  relationship: "Relationships", relationships: "Relationships", partner: "Relationships", marriage: "Relationships", girlfriend: "Relationships", boyfriend: "Relationships",
  friend: "Friends", friends: "Friends", friendship: "Friends",
  school: "Schools", schools: "Schools", college: "Schools", university: "Schools",
  job: "Jobs", jobs: "Jobs", work: "Jobs", career: "Jobs", employer: "Jobs",
  vacation: "Vacations", vacations: "Vacations", trip: "Vacations", holiday: "Vacations",
  success: "Successes", successes: "Successes", achievement: "Successes",
  failure: "Failures", failures: "Failures", mistake: "Failures",
};
function extractCategory(text) {
  const words = String(text).toLowerCase().match(/[a-z']+/g) || [];
  for (let i = words.length - 1; i >= 0; i--) if (CAT_ALIASES[words[i]]) return CAT_ALIASES[words[i]]; // last one spoken wins
  return "";
}
function extractYears(text) {
  const YR = "(?:18|19|20)\\d{2}";
  const range = text.match(new RegExp(`\\b(?:from\\s+)?(${YR})\\s*(?:to|until|till|through|thru|[-–—]|and)\\s*(${YR})\\b`, "i"))
             || text.match(new RegExp(`\\bbetween\\s+(${YR})\\s+and\\s+(${YR})\\b`, "i"));
  if (range) return { fromYear: Math.min(+range[1], +range[2]), toYear: Math.max(+range[1], +range[2]) };
  const all = (text.match(new RegExp(`\\b${YR}\\b`, "g")) || []).map(Number).filter((y) => y >= 1900 && y <= 2035);
  if (!all.length) return {};
  if (all.length >= 2) return { fromYear: Math.min(...all), toYear: Math.max(...all) };
  return { fromYear: all[0], toYear: null };
}
function extractLocation(text) {
  // "in/at/near <Proper Noun>" — works on finalized (capitalized) speech; the LLM covers the rest.
  const m = text.match(/\b(?:in|at|near|around|back in|out in)\s+([A-Z][\p{L}'’.-]+(?:\s+(?:of|the)?\s*[A-Z][\p{L}'’.-]+){0,3})/u);
  return m ? m[1].replace(/[.,;:]$/, "").trim() : "";
}
function llmOverrides() {
  const provider = localStorage.getItem("llm-provider") || "";
  if (!provider) return {};
  return { provider, apiKey: localStorage.getItem("llm-api-key") || "", model: localStorage.getItem("llm-model") || "", baseUrl: localStorage.getItem("llm-base-url") || "" };
}
const yearsLabel = (a, b) => (a == null ? "sometime" : b && b !== a ? `${Math.min(a, b)}–${Math.max(a, b)}` : String(a));

export async function startMemoryVoice(startCategory, onDone) {
  if (!hasSpeechInput) { alert("Voice capture needs speech recognition — try Chrome on desktop or Android."); return; }
  const speaker = createSpeaker();
  speaker.unlock(); // best-effort; the launcher already primed audio in the tap

  let category = startCategory || DEFAULT_CATEGORIES[0];
  let active = true, finishTurn = null, saved = 0;

  const ov = document.createElement("div");
  ov.className = "iv-overlay";
  ov.innerHTML = `<div class="iv-card mv-card">
      <div class="mv-cat-row">
        <span class="mv-cat-label">Category</span>
        <select id="mv-cat" class="mv-cat">${DEFAULT_CATEGORIES.map((c) => `<option${c === category ? " selected" : ""}>${c}</option>`).join("")}</select>
      </div>
      <div class="mv-form" id="mv-form">
        <div class="mv-field"><span>Subject</span><b id="mv-subject">—</b></div>
        <div class="mv-field"><span>When</span><b id="mv-when">—</b></div>
        <div class="mv-field"><span>Where</span><b id="mv-where">—</b></div>
      </div>
      <div class="mv-phase" id="mv-phase">Getting ready…</div>
      <div class="iv-interim" id="mv-interim"></div>
      <div class="iv-saved" id="mv-saved"></div>
      <div class="iv-actions">
        <button type="button" id="mv-skip">Skip ›</button>
        <button type="button" id="mv-stop">Stop</button>
      </div>
      <p class="iv-hint">Describe it (what &amp; when), then tell the memory. Say “done” to finish one, “skip” to drop it, “stop” to end.</p>
    </div>`;
  document.body.appendChild(ov);
  const $ = (id) => ov.querySelector(id);
  const catEl = $("#mv-cat"), phaseEl = $("#mv-phase"), interimEl = $("#mv-interim"), savedEl = $("#mv-saved");
  catEl.addEventListener("change", () => { category = catEl.value; });
  const cleanup = () => { active = false; speaker.cancel(); if (finishTurn) finishTurn("stop"); ov.remove(); onDone && onDone(saved); };
  $("#mv-stop").addEventListener("click", () => { active = false; if (finishTurn) finishTurn("stop"); else cleanup(); });
  $("#mv-skip").addEventListener("click", () => { if (finishTurn) finishTurn("skip"); });

  // Set a field's text and briefly highlight it when the value actually changes (live feedback).
  const setField = (id, val) => {
    const el = $(id), next = val || "—";
    if (el.textContent === next) return;
    el.textContent = next;
    el.classList.remove("mv-just"); void el.offsetWidth; el.classList.add("mv-just");
  };
  const setForm = (f) => {
    setField("#mv-subject", f.subject);
    setField("#mv-when", (f.fromYear != null) ? yearsLabel(f.fromYear, f.toYear) : "");
    setField("#mv-where", f.location);
  };
  const flash = () => { ov.querySelector(".mv-card").classList.add("mv-flash"); setTimeout(() => ov.querySelector(".mv-card")?.classList.remove("mv-flash"), 700); };

  // The live form state for the current memory, plus the two mergers that fill it.
  let fields = { subject: "", fromYear: null, toYear: null, location: "" };
  const applyLocal = (text) => {                    // instant, free: years, category, place keywords
    const y = extractYears(text);
    if (y.fromYear != null) { fields.fromYear = y.fromYear; fields.toYear = y.toYear ?? null; }
    const cat = extractCategory(text);
    if (cat && cat !== category && DEFAULT_CATEGORIES.includes(cat)) { category = cat; catEl.value = cat; }
    if (!fields.location) { const loc = extractLocation(text); if (loc) fields.location = loc; }
  };
  const applyLLM = (res) => {                        // the fuzzy part: subject, and anything JS missed
    if (res.subject) fields.subject = res.subject;
    if (fields.fromYear == null && res.fromYear != null) { fields.fromYear = res.fromYear; fields.toYear = res.toYear ?? null; }
    if (!fields.location && res.location) fields.location = res.location;
  };

  // One turn of listening — the shared, Android-safe loop (rebuilds transcript, never appends).
  const SIL_MS = 5000;
  function listen(endWords = [], onInterim) {
    const ctrl = {};
    finishTurn = (cmd) => { if (cmd === "stop") ctrl.stop && ctrl.stop(); else if (cmd === "skip") ctrl.skip && ctrl.skip(); else ctrl.finish && ctrl.finish(); };
    return vListen({ silenceMs: SIL_MS, endWords, onInterim: onInterim || ((t) => { interimEl.textContent = t; }), control: ctrl });
  }

  // Debounced LLM parse of the running transcript — fires ~1.1s after speech pauses, newest wins.
  function makeLiveLLM() {
    let timer = null, abort = null, seq = 0, lastSent = "";
    const schedule = (text) => {
      const t = text.trim();
      if (t.length < 5 || t === lastSent) return;
      clearTimeout(timer);
      timer = setTimeout(async () => {
        lastSent = t; const mine = ++seq;
        if (abort) abort.abort();
        abort = new AbortController();
        try {
          const res = await postMemoryMeta(t, category, abort.signal);
          if (!active || mine !== seq) return;     // a newer parse already superseded this one
          applyLLM(res); setForm(fields);
        } catch { /* aborted or transient — keep whatever we have */ }
      }, 1100);
    };
    const cancel = () => { clearTimeout(timer); if (abort) abort.abort(); };
    return { schedule, cancel };
  }

  await speaker.speak(`Let's add memories about ${category}. Tell me what the first one is, and roughly when.`);

  while (active) {
    // ---- Phase 1: metadata by voice → fill the form LIVE as you talk ----
    fields = { subject: "", fromYear: null, toYear: null, location: "" };
    setForm(fields);
    phaseEl.textContent = `${category} — what is it, and when?`;
    interimEl.textContent = "…listening";
    const live = makeLiveLLM();
    const meta = await listen([], (t) => {
      interimEl.textContent = t;
      applyLocal(t); setForm(fields);   // instant: years / category / place keywords fill immediately
      live.schedule(t);                 // fuzzy: the subject, debounced to the LLM
    });
    live.cancel();
    if (!active || meta.command === "stop") break;
    if (meta.command === "skip" || !meta.text) { continue; }
    // One authoritative parse of the full turn to firm up the subject, merged over what's there.
    phaseEl.textContent = "◷ noting that…";
    applyLocal(meta.text);
    try { applyLLM(await postMemoryMeta(meta.text, category)); } catch { /* keep what we have */ }
    if (!active) break;
    setForm(fields);

    // ---- Phase 2: record the memory itself ----
    flash();
    interimEl.textContent = "";
    await speaker.speak("Go ahead — tell me about it. Say done when you're finished.");
    if (!active) break;
    phaseEl.textContent = "● Recording — say “done” when finished";
    interimEl.textContent = "…listening";
    const body = await listen(["done", "over", "next", "that's it", "finished"]);
    if (!active || body.command === "stop") break;
    if (body.command === "skip" || !body.text) { await speaker.speak("Dropped. Next."); continue; }

    const mem = {
      id: uid(), category, subject: fields.subject || "",
      startYear: fields.fromYear, endYear: (fields.toYear && fields.toYear !== fields.fromYear) ? fields.toYear : null,
      label: yearsLabel(fields.fromYear, fields.toYear),
      text: body.text, needsSummary: true, createdAt: Date.now(), updatedAt: Date.now(),
    };
    if (fields.location) mem.place = fields.location; // Places map geocodes the name
    await putMemory(mem);
    saved++;
    savedEl.textContent = `✓ Saved ${saved}: ${category}${fields.subject ? " — " + fields.subject : ""}`;
    await speaker.speak("Saved. Next.");
  }
  if (active) await speaker.speak(`That's ${saved} ${saved === 1 ? "memory" : "memories"}. Thanks.`);
  cleanup();
}
