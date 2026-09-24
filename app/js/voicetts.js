// Shared spoken voice for the interviews (and anywhere else): ChatGPT-quality OpenAI TTS, steered
// into character styles, with a graceful fall back to the browser voice when OpenAI isn't configured.
// createSpeaker() returns { unlock, speak, cancel, usingOpenAI }. Call unlock() inside the start tap
// so mobile lets the audio element play thereafter.

function llmOverrides() {
  const provider = localStorage.getItem("llm-provider") || "";
  if (!provider) return {};
  return { provider, apiKey: localStorage.getItem("llm-api-key") || "", model: localStorage.getItem("llm-model") || "", baseUrl: localStorage.getItem("llm-base-url") || "" };
}

export const CHARACTERS = [
  { id: "narrator", label: "Warm narrator", voice: "nova", instructions: "Warm, natural, conversational — a friendly interviewer's voice, unhurried and kind." },
  { id: "mason", label: "Suave British (à la James Mason)", voice: "fable", instructions: "A suave, cultured mid-20th-century British gentleman: velvety, measured, faintly theatrical, elegant diction." },
  { id: "bogart", label: "Hard-boiled noir (à la Bogart)", voice: "onyx", instructions: "A world-weary 1940s film-noir voice: low, gravelly, clipped, wry and hard-boiled, a faint lisp." },
  { id: "waits", label: "Gravel & whiskey (à la Tom Waits)", voice: "onyx", instructions: "A gravelly, growling, whiskey-and-cigarettes rasp: weathered, bluesy, gruff yet oddly tender." },
  { id: "holloway", label: "Whimsical storyteller (à la Sterling Holloway)", voice: "alloy", instructions: "A soft, warm, whimsical storyteller: gentle, slightly wispy, folksy and delighted." },
  { id: "horton", label: "Prim fairy-tale (à la Edward Everett Horton)", voice: "fable", instructions: "A prim, dry, amused elderly storyteller — precise, gently arch, twinkling with mischief." },
  { id: "stewart", label: "Wry satirist (à la Jon Stewart)", voice: "echo", instructions: "A wry, fast-talking American satirist: incredulous, deadpan then animated, sharp timing." },
  { id: "oliver", label: "British satirist (à la John Oliver)", voice: "fable", instructions: "An animated British comedic commentator: rapid, exasperated, witty, warm underneath." },
  { id: "pitt", label: "Laid-back movie star (à la Brad Pitt)", voice: "onyx", instructions: "A relaxed, cool American movie star: unhurried drawl, understated charm, a little gravel." },
];
export function charById(id) { return CHARACTERS.find((c) => c.id === id) || CHARACTERS[0]; }
export function savedCharacter() { return localStorage.getItem("tts-character") || "narrator"; }

function pickBrowserVoice() {
  try {
    const vs = (speechSynthesis.getVoices() || []).filter((v) => /^en(-|_|$)/i.test(v.lang));
    if (!vs.length) return null;
    const saved = localStorage.getItem("tts-voice");
    if (saved) { const m = vs.find((v) => v.voiceURI === saved || v.name === saved); if (m) return m; }
    const score = (v) => { const n = v.name.toLowerCase(); let s = 0; if (/natural|neural|google|samantha|ava|serena/.test(n)) s += 30; if (/en-us/i.test(v.lang)) s += 5; return s; };
    return vs.slice().sort((a, b) => score(b) - score(a))[0];
  } catch { return null; }
}
function b64ToArrayBuffer(b64) { const bin = atob(b64); const arr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i); return arr.buffer; }

// Web Audio API playback — far more reliable than <audio>+blob on Android/Samsung. ONE shared
// AudioContext, resumed by a user gesture (primeAudio) and then reused; BufferSource plays the mp3
// bytes. Once the context is resumed in a tap, later plays work even after an async fetch.
let ctx = null, curSrc = null;
function getCtx() {
  if (!ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) ctx = new AC(); }
  return ctx;
}
// Call this SYNCHRONOUSLY inside the tap that starts a voice flow (before any await).
export function primeAudio() {
  try {
    const c = getCtx(); if (!c) return;
    if (c.state === "suspended") c.resume();
    // A one-sample silent buffer nudges the context fully awake on mobile.
    const b = c.createBuffer(1, 1, 22050); const s = c.createBufferSource(); s.buffer = b; s.connect(c.destination); s.start(0);
  } catch { /* */ }
}

function speakBrowser(text) {
  return new Promise((resolve) => {
    try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); const v = pickBrowserVoice(); if (v) u.voice = v; u.onend = resolve; u.onerror = resolve; speechSynthesis.speak(u); }
    catch { resolve(); }
  });
}

export function createSpeaker(onStatus) {
  let noKey = false; // only "no OpenAI key" permanently disables OpenAI; a blocked play retries next line
  const note = (m) => { try { onStatus && onStatus(m); } catch { /* */ } };

  async function fetchTTS(text) {
    const c = charById(savedCharacter());
    const r = await fetch("/api/tts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...llmOverrides(), text, voice: c.voice, instructions: c.instructions }),
    });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || `tts ${r.status}`); }
    const { audio: b64 } = await r.json();
    return b64ToArrayBuffer(b64);
  }

  async function playBytes(arrayBuf) {
    const c = getCtx(); if (!c) throw new Error("no-audio-context");
    if (c.state === "suspended") await c.resume();
    const decoded = await new Promise((resolve, reject) => {
      // Safari wants the callback form; modern browsers return a promise. Support both.
      const p = c.decodeAudioData(arrayBuf, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
    await new Promise((resolve) => {
      const s = c.createBufferSource(); s.buffer = decoded; s.connect(c.destination);
      s.onended = resolve; curSrc = s; s.start(0);
    });
  }

  return {
    unlock() { primeAudio(); },
    usingOpenAI() { return !noKey; },
    cancel() { try { if (curSrc) { curSrc.onended = null; curSrc.stop(); } } catch { /* */ } curSrc = null; try { speechSynthesis.cancel(); } catch { /* */ } },
    async speak(text) {
      if (!text) return;
      if (noKey) { note("browser (no OpenAI key)"); return speakBrowser(text); }
      let bytes;
      try { bytes = await fetchTTS(text); }
      catch (e) { const m = String(e && e.message || e); if (m.includes("no-openai-key")) noKey = true; note("browser — fetch: " + m.slice(0, 70)); return speakBrowser(text); }
      try { await playBytes(bytes); note("OpenAI ✓"); }
      catch (e) { note("browser — play: " + String(e && e.message || e).slice(0, 70)); return speakBrowser(text); }
    },
  };
}
