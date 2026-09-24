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

export function createSpeaker() {
  const audio = new Audio();
  audio.setAttribute("playsinline", "");
  let useBrowser = false, decided = false;

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

  function speakBrowser(text) {
    return new Promise((resolve) => {
      try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); const v = pickBrowserVoice(); if (v) u.voice = v; u.onend = resolve; u.onerror = resolve; speechSynthesis.speak(u); }
      catch { resolve(); }
    });
  }

  return {
    // Call inside the start-tap gesture so mobile permits later audio.play() calls.
    unlock() { try { audio.src = SILENT; audio.play().then(() => { try { audio.pause(); } catch { /* */ } }).catch(() => {}); } catch { /* */ } },
    usingOpenAI() { return !useBrowser; },
    cancel() { try { audio.pause(); } catch { /* */ } try { speechSynthesis.cancel(); } catch { /* */ } },
    async speak(text) {
      if (!text) return;
      if (!useBrowser) {
        let url;
        try { url = await fetchTTS(text); }
        catch (e) { useBrowser = true; decided = true; return speakBrowser(text); }
        decided = true;
        try {
          audio.src = url;
          await new Promise((resolve) => { audio.onended = resolve; audio.onerror = resolve; audio.play().catch(() => resolve()); });
        } finally { try { URL.revokeObjectURL(url); } catch { /* */ } }
        return;
      }
      return speakBrowser(text);
    },
  };
}
