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

const SILENT = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=";

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
function b64ToBlob(b64, type) { const bin = atob(b64); const arr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i); return new Blob([arr], { type: type || "audio/mpeg" }); }

// ONE shared audio element, unlocked once by a user gesture, then reused for every spoken line —
// so a tap can unlock it synchronously (before any async import/fetch) and later plays are allowed
// on mobile. Unlocking is per-element on iOS, which is exactly why this must be a singleton.
let sharedAudio = null;
function audioEl() {
  if (!sharedAudio) { sharedAudio = new Audio(); sharedAudio.setAttribute("playsinline", ""); }
  return sharedAudio;
}
// Call this SYNCHRONOUSLY inside the tap that starts a voice flow (do not await anything first).
export function primeAudio() {
  try { const a = audioEl(); a.src = SILENT; const p = a.play(); if (p && p.then) p.then(() => { try { a.pause(); a.currentTime = 0; } catch { /* */ } }).catch(() => {}); } catch { /* */ }
}

function speakBrowser(text) {
  return new Promise((resolve) => {
    try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); const v = pickBrowserVoice(); if (v) u.voice = v; u.onend = resolve; u.onerror = resolve; speechSynthesis.speak(u); }
    catch { resolve(); }
  });
}

export function createSpeaker() {
  const audio = audioEl();
  let noKey = false; // only "no OpenAI key" permanently disables OpenAI; a blocked play retries next line

  async function fetchTTS(text) {
    const c = charById(savedCharacter());
    const r = await fetch("/api/tts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...llmOverrides(), text, voice: c.voice, instructions: c.instructions }),
    });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || `tts ${r.status}`); }
    const { audio: b64, type } = await r.json();
    return URL.createObjectURL(b64ToBlob(b64, type));
  }

  return {
    unlock() { primeAudio(); },
    usingOpenAI() { return !noKey; },
    cancel() { try { audio.pause(); } catch { /* */ } try { speechSynthesis.cancel(); } catch { /* */ } },
    async speak(text) {
      if (!text) return;
      if (noKey) return speakBrowser(text);
      let url;
      try { url = await fetchTTS(text); }
      catch (e) { if (String(e && e.message).includes("no-openai-key")) noKey = true; return speakBrowser(text); }
      try {
        audio.src = url;
        try { audio.load(); } catch { /* */ }
        await new Promise((resolve, reject) => {
          audio.onended = resolve; audio.onerror = () => reject(new Error("audio"));
          const p = audio.play(); if (p && p.catch) p.catch(reject);
        });
        try { URL.revokeObjectURL(url); } catch { /* */ }
      } catch (e) {
        try { URL.revokeObjectURL(url); } catch { /* */ }
        return speakBrowser(text); // play blocked this time (e.g. not unlocked yet) — retry OpenAI next line
      }
    },
  };
}
