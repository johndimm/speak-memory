// Hands-free MEMORY CAPTURE — for adding a SERIES of memories fast (your Places, Friends, Jobs…).
// Two phases per memory:
//   1) You describe what it is and when/where; the LLM fills the form (subject, years, location) live.
//   2) The screen flashes and you dictate the memory itself. It ends on ~5s silence or "done"/"over".
// Then it advances to the next, keeping the category, so you go through a whole list in one session.
// Say "stop" to end, "skip" to drop the current one.

import { putMemory } from "./db.js";
import { createSpeaker } from "./voicetts.js";

const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "m" + Date.now() + Math.random().toString(36).slice(2));

// A sensible starter set — the user can also type any category in Write.
export const DEFAULT_CATEGORIES = ["Places", "Cities", "Homes", "Family", "Relationships", "Friends", "Schools", "Jobs", "Successes", "Failures"];

async function postMemoryMeta(text, category) {
  const r = await fetch("/api/summarize", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...llmOverrides(), mode: "memorymeta", text, category }),
  });
  if (!r.ok) throw new Error(`meta ${r.status}`);
  return r.json();
}
function llmOverrides() {
  const provider = localStorage.getItem("llm-provider") || "";
  if (!provider) return {};
  return { provider, apiKey: localStorage.getItem("llm-api-key") || "", model: localStorage.getItem("llm-model") || "", baseUrl: localStorage.getItem("llm-base-url") || "" };
}
const yearsLabel = (a, b) => (a == null ? "sometime" : b && b !== a ? `${Math.min(a, b)}–${Math.max(a, b)}` : String(a));

export async function startMemoryVoice(startCategory, onDone) {
  if (!SpeechRec) { alert("Voice capture needs speech recognition — try Chrome on desktop or Android."); return; }
  const speaker = createSpeaker();
  speaker.unlock(); // best-effort; the launcher already primed audio in the tap

  let category = startCategory || DEFAULT_CATEGORIES[0];
  let active = true, recog = null, finishTurn = null, saved = 0;

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
  const cleanup = () => { active = false; speaker.cancel(); try { recog && recog.stop(); } catch { /* */ } ov.remove(); onDone && onDone(saved); };
  $("#mv-stop").addEventListener("click", () => { active = false; if (finishTurn) finishTurn("stop"); else cleanup(); });
  $("#mv-skip").addEventListener("click", () => { if (finishTurn) finishTurn("skip"); });

  const setForm = (f) => {
    $("#mv-subject").textContent = f.subject || "—";
    $("#mv-when").textContent = (f.fromYear != null) ? yearsLabel(f.fromYear, f.toYear) : "—";
    $("#mv-where").textContent = f.location || "—";
  };
  const flash = () => { ov.querySelector(".mv-card").classList.add("mv-flash"); setTimeout(() => ov.querySelector(".mv-card")?.classList.remove("mv-flash"), 700); };

  // Continuous listening; ends on ~5s silence, or early when the speech ends with an end-word.
  const SIL_MS = 5000;
  function listen(endWords = []) {
    return new Promise((resolve) => {
      let full = "", stopped = false, r = null, silence = null;
      const parse = (t) => {
        const low = t.toLowerCase().trim();
        if (/\b(stop|finished|that'?s all|i'?m done for now|end session)\b/.test(low)) return { text: t, command: "stop" };
        if (/\b(skip|scratch that|never mind|forget it)\b/.test(low)) return { text: t, command: "skip" };
        let text = t;
        for (const w of endWords) text = text.replace(new RegExp("\\b" + w + "\\b[.!?]*\\s*$", "i"), "").trim();
        return { text, command: null };
      };
      const done = (res) => { if (stopped) return; stopped = true; clearTimeout(silence); finishTurn = null; try { if (r) { r.onend = null; r.stop(); } } catch { /* */ } resolve(res); };
      finishTurn = (cmd) => done(cmd ? { text: full.trim(), command: cmd } : parse(full));
      const arm = () => { clearTimeout(silence); silence = setTimeout(() => { if (full.trim()) done(parse(full)); }, SIL_MS); };
      const start = () => {
        r = new SpeechRec(); r.lang = navigator.language || "en-US"; r.interimResults = true; r.continuous = true;
        r.onresult = (e) => {
          let interim = "";
          for (let i = e.resultIndex; i < e.results.length; i++) { const res = e.results[i]; if (res.isFinal) full += res[0].transcript + " "; else interim += res[0].transcript; }
          const shown = (full + interim).trim();
          interimEl.textContent = shown;
          const low = shown.toLowerCase();
          if (endWords.some((w) => new RegExp("\\b" + w + "\\b[.!?]*$", "i").test(low))) { done(parse(full + interim)); return; }
          if (/\b(stop|finished)\b[.!?]*$/i.test(low)) { done({ text: shown, command: "stop" }); return; }
          arm();
        };
        r.onerror = () => { /* restart on end */ };
        r.onend = () => { if (!stopped) setTimeout(() => { if (!stopped) start(); }, 250); };
        recog = r;
        try { r.start(); } catch { setTimeout(() => { if (!stopped) start(); }, 400); }
      };
      start();
    });
  }

  await speaker.speak(`Let's add memories about ${category}. Tell me what the first one is, and roughly when.`);

  while (active) {
    // ---- Phase 1: metadata by voice → fill the form ----
    setForm({});
    phaseEl.textContent = `${category} — what is it, and when?`;
    interimEl.textContent = "…listening";
    const meta = await listen();
    if (!active || meta.command === "stop") break;
    if (meta.command === "skip" || !meta.text) { continue; }
    let fields = { subject: "", fromYear: null, toYear: null, location: "" };
    phaseEl.textContent = "◷ noting that…";
    try { fields = await postMemoryMeta(meta.text, category); } catch { /* keep blanks */ }
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
