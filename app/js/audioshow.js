// "The reveal" — a produced audio show that narrates an imagined future. From the future's diary
// days and life-states it writes a cinematic spoken script (one LLM call), then plays it with the
// browser's best voice, paragraph by paragraph, in a full-screen player. Fully hands-free once started.

import { getAllEntries, getAllMemories } from "./db.js";
import { jkey } from "./journal.js";
import { IS_MOBILE } from "./dictation.js";

function llmOverrides() {
  const provider = localStorage.getItem("llm-provider") || "";
  if (!provider) return {};
  return { provider, apiKey: localStorage.getItem("llm-api-key") || "", model: localStorage.getItem("llm-model") || "", baseUrl: localStorage.getItem("llm-base-url") || "" };
}

// Best available natural English voice (shared idea with the interview), honoring a saved choice.
function englishVoices() { try { return (speechSynthesis.getVoices() || []).filter((v) => /^en(-|_|$)/i.test(v.lang)); } catch { return []; } }
// Voices load asynchronously — resolve once they're actually available so we never fall back to the
// browser's worst default by speaking too early.
function voicesReady() {
  return new Promise((resolve) => {
    try {
      if (speechSynthesis.getVoices().length) return resolve();
      const done = () => resolve();
      speechSynthesis.onvoiceschanged = done;
      setTimeout(done, 1500); // don't hang if the event never fires
    } catch { resolve(); }
  });
}
// macOS ships many low-quality/novelty voices; steer away from them, toward the good ones.
const GOOD = /natural|neural|premium|enhanced|google|samantha|ava|allison|serena|zoe|jenny|aria|libby|sonia|kate|daniel|karen|moira|tessa|fiona/i;
const BAD = /albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|fred|junior|kathy|ralph|grandma|grandpa|reed|rocko|sandy|shelley|flo|eddy/i;
function pickVoice() {
  const voices = englishVoices();
  if (!voices.length) return null;
  const saved = localStorage.getItem("tts-voice");
  if (saved) { const m = voices.find((v) => v.voiceURI === saved || v.name === saved); if (m) return m; }
  const score = (v) => {
    const n = v.name.toLowerCase(); let s = 0;
    if (/natural|neural|premium|enhanced/.test(n)) s += 60;
    if (/google/.test(n)) s += 40;
    if (GOOD.test(n)) s += 25;
    if (BAD.test(n)) s -= 100;
    if (/en-us/i.test(v.lang)) s += 6;
    if (!v.localService) s += 4; // online voices are usually the better ones
    return s;
  };
  return voices.slice().sort((a, b) => score(b) - score(a))[0];
}

async function writeScript(meta) {
  const [days, mems] = await Promise.all([getAllEntries(), getAllMemories()]);
  // If the caller didn't pass the horizon year, take it from the latest imagined day.
  if (!meta.endYear) { const last = days.map((d) => d.date).filter(Boolean).sort().pop(); if (last) meta.endYear = last.slice(0, 4); }
  const stateLines = mems.map((m) => `${m.category || "Life"} — ${m.subject || m.label || ""} (${m.startYear || "?"}${m.endYear && m.endYear !== m.startYear ? "–" + m.endYear : ""}): ${(m.text || "").replace(/\s+/g, " ").slice(0, 300)}`);
  const entries = [
    { date: "The years ahead — life-states", full: stateLines.join("\n") },
    ...days.map((d) => ({ date: d.date, brief: d.brief || "", full: d.full || d.raw || "" })),
  ];
  const sys = `You are the NARRATOR of a short audio show that reveals this person's imagined future — the years roughly up to ${meta.endYear}. Below are their future diary days and the enduring life-states of those years. Write a produced SPOKEN script that reveals their life unfolding: warm, cinematic, a little dramatic, honest — not a hype reel.
- Address them as "you". Move through time in order; hit the real turning points, and name the actual people, animals, and places that appear.
- This is HEARD, not read: short sentences, natural spoken rhythm, no lists, no headings, no stage directions, no markdown.
- 6 to 10 short paragraphs. Open with a hook that drops them into the future; close with one resonant line.
Return ONLY the script text, paragraphs separated by blank lines.`;
  const r = await fetch("/api/chat", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...llmOverrides(), messages: [{ role: "user", content: "Write the reveal now." }], entries: [{ date: "brief", full: sys }, ...entries], localTime: new Date().toLocaleString() }),
  });
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || `Server ${r.status}`); }
  const { reply } = await r.json();
  return String(reply || "").trim();
}

// The script is fixed once a future is generated, so write it once and cache it (per journal).
const SCRIPT_KEY = () => jkey("reveal-script");
async function getScript(meta, force) {
  if (!force) { try { const c = JSON.parse(localStorage.getItem(SCRIPT_KEY()) || "null"); if (c && c.script) return c; } catch { /* */ } }
  const script = await writeScript(meta); // writeScript fills meta.endYear from the days if absent
  const out = { script, endYear: meta.endYear || "" };
  try { localStorage.setItem(SCRIPT_KEY(), JSON.stringify(out)); } catch { /* */ }
  return out;
}

export async function playFutureShow(meta = {}) {
  // Build the overlay immediately with a loading state.
  const ov = document.createElement("div");
  ov.className = "show-overlay";
  ov.innerHTML = `<div class="show-stage">
      <div class="show-year">${meta.endYear || ""}</div>
      <div class="show-text" id="show-text">◷ Writing your reveal…</div>
      <div class="show-controls">
        <button type="button" id="show-toggle" hidden>⏸ Pause</button>
        <button type="button" id="show-close">Close</button>
      </div>
      <label class="show-voice" hidden><span>Voice</span> <select id="show-voice-sel"></select></label>
    </div>`;
  document.body.appendChild(ov);
  const textEl = ov.querySelector("#show-text");
  const toggle = ov.querySelector("#show-toggle");
  const voiceWrap = ov.querySelector(".show-voice");
  const voiceSel = ov.querySelector("#show-voice-sel");

  let paras = [], idx = 0, stopped = false, paused = false, started = false;
  let useBrowser = false; // flips true if OpenAI TTS isn't available
  let firstUrl = null;    // para-0 audio, pre-resolved so the play tap can start it synchronously (mobile)
  const audioEl = new Audio();
  audioEl.setAttribute("playsinline", "");
  const objectUrls = [];
  const cleanup = () => { stopped = true; try { speechSynthesis.cancel(); } catch { /* */ } try { audioEl.pause(); } catch { /* */ } objectUrls.forEach((u) => URL.revokeObjectURL(u)); ov.remove(); };
  ov.querySelector("#show-close").addEventListener("click", cleanup);
  ov.addEventListener("click", (e) => { if (e.target === ov) cleanup(); });

  const showText = (t) => { textEl.classList.remove("show-tap"); textEl.textContent = t; textEl.classList.remove("show-fade"); void textEl.offsetWidth; textEl.classList.add("show-fade"); };

  // ---- OpenAI voices (ChatGPT-quality), steered into characters ----------------------------
  const char = () => charById(savedChar());
  const prefetch = {}; // idx → Promise<objectURL>
  const getAudio = (i) => { if (!prefetch[i]) prefetch[i] = ttsFetch(paras[i], char()); return prefetch[i]; };

  let gen = 0; // bumped on every jump (voice change / replay) so stale onended callbacks are ignored
  async function playFrom(i) {
    if (stopped) return;
    if (i >= paras.length) { toggle.textContent = "↺ Replay"; return; }
    const myGen = ++gen; // this run owns playback until the next jump
    idx = i; showText(paras[i]);
    let url;
    try { url = await getAudio(i); } catch (e) { useBrowser = true; fillPicker(); speakBrowser(i); return; } // only a FETCH failure falls back to the browser voice
    if (stopped || myGen !== gen) return; // a newer jump superseded this one
    objectUrls.push(url);
    if (i + 1 < paras.length) getAudio(i + 1).catch(() => {}); // prefetch next while this plays
    try { audioEl.pause(); } catch { /* */ }
    audioEl.src = url;
    audioEl.onended = () => { if (myGen === gen && !stopped && !paused) playFrom(i + 1); };
    audioEl.play().catch(() => { /* interrupted by a new load (e.g. a voice change) — ignore */ });
  }

  // ---- Browser fallback --------------------------------------------------------------------
  function speakBrowser(i) {
    if (stopped) return;
    if (i >= paras.length) { toggle.textContent = "↺ Replay"; return; }
    idx = i; showText(paras[i]);
    const u = new SpeechSynthesisUtterance(paras[i]);
    const v = pickVoice(); if (v) u.voice = v;
    u.rate = 0.98;
    u.onend = () => { if (!stopped && !paused) speakBrowser(i + 1); };
    u.onerror = () => { if (!stopped && !paused) speakBrowser(i + 1); };
    try { speechSynthesis.cancel(); speechSynthesis.speak(u); } catch { /* */ }
  }

  const resume = () => { if (useBrowser) { try { speechSynthesis.resume(); } catch { /* */ } } else audioEl.play().catch(() => {}); };
  const pause = () => { if (useBrowser) { try { speechSynthesis.pause(); } catch { /* */ } } else { try { audioEl.pause(); } catch { /* */ } } };

  // Start from the top — called from the reader's PLAY TAP, so the first clip plays inside the
  // gesture (mobile blocks audio started outside a tap → why it fell back to the bad browser voice).
  async function startPlayback() {
    started = true; paused = false; toggle.textContent = "⏸ Pause";
    if (useBrowser) { speakBrowser(0); return; }
    idx = 0; showText(paras[0]);
    let url = firstUrl;
    if (!url) { try { url = await getAudio(0); firstUrl = url; } catch { useBrowser = true; fillPicker(); speakBrowser(0); return; } }
    objectUrls.push(url);
    if (paras.length > 1) getAudio(1).catch(() => {});
    audioEl.src = url;
    audioEl.onended = () => { if (!stopped && !paused) playFrom(1); };
    audioEl.play().catch(() => { useBrowser = true; fillPicker(); speakBrowser(0); });
  }

  toggle.addEventListener("click", () => {
    if (!started || (idx >= paras.length && !paused)) { startPlayback(); return; }
    paused = !paused;
    if (paused) { pause(); toggle.textContent = "▶ Resume"; } else { toggle.textContent = "⏸ Pause"; resume(); }
  });
  // Tapping the big text also starts it (the Play button can scroll out of view on a long paragraph).
  textEl.addEventListener("click", () => { if (!started) startPlayback(); });

  // ---- Voice / character picker ------------------------------------------------------------
  function fillPicker() {
    if (useBrowser) {
      const vs = englishVoices(); if (!vs.length) { voiceWrap.hidden = true; return; }
      const cur = pickVoice();
      voiceSel.innerHTML = vs.map((v) => `<option value="b:${v.voiceURI}"${cur && v.voiceURI === cur.voiceURI ? " selected" : ""}>${v.name}</option>`).join("");
    } else {
      voiceSel.innerHTML = CHARACTERS.map((c) => `<option value="c:${c.id}"${c.id === savedChar() ? " selected" : ""}>${c.label}</option>`).join("");
    }
    voiceWrap.hidden = false;
  }
  voiceSel.addEventListener("change", () => {
    const val = voiceSel.value;
    if (val.startsWith("c:")) {
      localStorage.setItem("tts-character", val.slice(2));
      for (const k of Object.keys(prefetch)) delete prefetch[k]; // drop clips fetched in the old voice
      firstUrl = null;
      if (started && !useBrowser) { paused = false; try { audioEl.pause(); } catch { /* */ } playFrom(idx); } // re-voice from the current paragraph NOW
      else getAudio(0).then((u) => { firstUrl = u; }).catch(() => {}); // not playing yet → re-arm para 0
    } else if (val.startsWith("b:")) {
      localStorage.setItem("tts-voice", val.slice(2));
      if (started && useBrowser) { paused = false; try { speechSynthesis.cancel(); } catch { /* */ } speakBrowser(idx); } // re-voice now
    }
  });
  try { speechSynthesis.onvoiceschanged = () => { if (useBrowser) fillPicker(); }; } catch { /* */ }

  // ---- Go -----------------------------------------------------------------------------------
  try {
    await voicesReady().catch(() => {});
    const { script, endYear } = await getScript(meta); // written once, then cached per future
    if (stopped) return;
    ov.querySelector(".show-year").textContent = endYear || meta.endYear || "";
    paras = script.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    if (!paras.length) { textEl.textContent = "Couldn't write the reveal — try again."; return; }
    // Probe/pre-fetch the first clip so the play tap can start it instantly and in-gesture.
    try { firstUrl = await getAudio(0); } catch { useBrowser = true; }
    fillPicker();
    textEl.textContent = "▶  Tap here to play the reveal"; // a clear tap target; a fresh gesture starts audio (mobile-safe)
    textEl.classList.add("show-tap");
    toggle.hidden = false; toggle.textContent = "▶ Play the reveal";
  } catch (err) {
    if (!stopped) textEl.textContent = `Couldn't write the reveal: ${(err && err.message) || err}`;
  }
}

// ---- Character voices (OpenAI gpt-4o-mini-tts steered by instructions) ----------------------
const CHARACTERS = [
  { id: "mason", label: "Suave British narrator (à la James Mason)", voice: "fable",
    instructions: "Narrate as a suave, cultured mid-20th-century British gentleman: velvety and measured, faintly theatrical and sardonic, unhurried, with elegant diction — like a classic film actor confiding a story." },
  { id: "bogart", label: "Hard-boiled noir (à la Bogart)", voice: "onyx",
    instructions: "Narrate as a world-weary 1940s film-noir private eye: low, gravelly, and clipped, wry and hard-boiled, speaking confidentially as if narrating his own case, with a faint lisp and dry cynicism." },
  { id: "holloway", label: "Whimsical storyteller (à la Sterling Holloway)", voice: "alloy",
    instructions: "Narrate as a soft, warm, whimsical storyteller: gentle and slightly wispy, folksy and delighted, cozy and childlike-friendly, like a classic Disney narrator savoring a gentle tale." },
  { id: "stewart", label: "Wry news-desk satirist (à la Jon Stewart)", voice: "echo",
    instructions: "Narrate as a wry, fast-talking American late-night news satirist: incredulous and deadpan, then suddenly animated; sharp comedic timing, conspiratorial asides, a knowing smirk in the voice." },
  { id: "oliver", label: "British satirist (à la John Oliver)", voice: "fable",
    instructions: "Narrate as an animated British comedic commentator: rapid and exasperated, incredulous and witty, building to indignant punchlines, warm and delighted underneath." },
  { id: "pitt", label: "Laid-back movie star (à la Brad Pitt)", voice: "onyx",
    instructions: "Narrate as a relaxed, cool American movie star: unhurried easy drawl, understated charm, a little gravel, effortless." },
  { id: "horton", label: "Prim fairy-tale narrator (à la Edward Everett Horton)", voice: "fable",
    instructions: "Narrate as a prim, dry, amused elderly storyteller — precise and slightly fussy, gently arch, twinkling with mischief, savoring each word like a classic fractured-fairy-tale narrator." },
  { id: "waits", label: "Gravel-and-whiskey growl (à la Tom Waits)", voice: "onyx",
    instructions: "Narrate as a gravelly, growling, whiskey-and-cigarettes rasp: weathered and craggy, bluesy and low, gruff yet oddly tender and poetic, unhurried — a barroom storyteller at three in the morning." },
  { id: "narrator", label: "Cinematic documentary narrator", voice: "nova",
    instructions: "Narrate as a warm, cinematic documentary voice: intimate, resonant, and reflective, with graceful pacing." },
];
function charById(id) { return CHARACTERS.find((c) => c.id === id) || CHARACTERS[0]; }
function savedChar() { return localStorage.getItem("tts-character") || "mason"; }

function b64ToBlob(b64, type) {
  const bin = atob(b64); const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: type || "audio/mpeg" });
}
async function ttsFetch(text, character) {
  const r = await fetch("/api/tts", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...llmOverrides(), text, voice: character.voice, instructions: character.instructions }),
  });
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || `tts ${r.status}`); }
  const { audio, type } = await r.json();
  return URL.createObjectURL(b64ToBlob(audio, type));
}
