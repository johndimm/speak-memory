// Text-to-speech via OpenAI (the same voices ChatGPT uses: alloy, echo, fable, onyx, nova, shimmer).
// Needs OPENAI_API_KEY in the environment. Returns the audio as base64 JSON so it flows through both
// the local dev server and Vercel without binary-response plumbing. The client falls back to the
// browser's built-in voice when this isn't configured.
export const config = { maxDuration: 60 };

const VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  try {
    const key = process.env.OPENAI_API_KEY;
    if (!key) { res.status(400).json({ error: "no-openai-key" }); return; } // client falls back to browser TTS
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const text = String(body.text || "").slice(0, 4000).trim();
    if (!text) { res.status(400).json({ error: "No text" }); return; }
    const voice = VOICES.includes(body.voice) ? body.voice : "fable";
    const instructions = typeof body.instructions === "string" ? body.instructions.slice(0, 600) : "";

    const call = (model, withInstr) => fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, voice, input: text, response_format: "mp3", ...(withInstr && instructions ? { instructions } : {}) }),
    });
    // Prefer gpt-4o-mini-tts (steerable by `instructions` — the character voices); fall back to
    // tts-1-hd if that model isn't available on this key.
    let r = await call("gpt-4o-mini-tts", true);
    if (!r.ok && (r.status === 400 || r.status === 404)) r = await call("tts-1-hd", false);
    if (!r.ok) { res.status(502).json({ error: `OpenAI TTS ${r.status}: ${(await r.text()).slice(0, 300)}` }); return; }
    const buf = Buffer.from(await r.arrayBuffer());
    res.status(200).json({ audio: buf.toString("base64"), type: "audio/mpeg", voice });
  } catch (err) {
    res.status(500).json({ error: err.message || "TTS failed" });
  }
}
