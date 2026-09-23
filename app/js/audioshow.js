// "The reveal" — a produced audio show that narrates an imagined future. From the future's diary
// days and life-states it writes a cinematic spoken script (one LLM call), then plays it with the
// browser's best voice, paragraph by paragraph, in a full-screen player. Fully hands-free once started.

import { getAllEntries, getAllMemories } from "./db.js";

function llmOverrides() {
  const provider = localStorage.getItem("llm-provider") || "";
  if (!provider) return {};
  return { provider, apiKey: localStorage.getItem("llm-api-key") || "", model: localStorage.getItem("llm-model") || "", baseUrl: localStorage.getItem("llm-base-url") || "" };
}

// Best available natural English voice (shared idea with the interview), honoring a saved choice.
function englishVoices() { try { return (speechSynthesis.getVoices() || []).filter((v) => /^en(-|_|$)/i.test(v.lang)); } catch { return []; } }
function pickVoice() {
  const voices = englishVoices();
  if (!voices.length) return null;
  const saved = localStorage.getItem("tts-voice");
  if (saved) { const m = voices.find((v) => v.voiceURI === saved || v.name === saved); if (m) return m; }
  const score = (v) => { const n = v.name.toLowerCase(); let s = 0; if (/natural|neural|premium|enhanced/.test(n)) s += 50; if (/google/.test(n)) s += 30; if (/\b(samantha|ava|allison|serena|jenny|aria|libby|sonia)\b/.test(n)) s += 25; if (/en-us/i.test(v.lang)) s += 5; return s; };
  return voices.slice().sort((a, b) => score(b) - score(a))[0];
}

async function writeScript(meta) {
  const [days, mems] = await Promise.all([getAllEntries(), getAllMemories()]);
  const dayLines = days.sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map((d) => `${d.date}: ${(d.full || d.brief || d.raw || "").replace(/\s+/g, " ").slice(0, 400)}`);
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

  let paras = [], idx = 0, stopped = false, paused = false;
  const cleanup = () => { stopped = true; try { speechSynthesis.cancel(); } catch { /* */ } ov.remove(); };
  ov.querySelector("#show-close").addEventListener("click", cleanup);
  ov.addEventListener("click", (e) => { if (e.target === ov) cleanup(); });

  function speakPara() {
    if (stopped || idx >= paras.length) { if (!stopped && idx >= paras.length) toggle.textContent = "↺ Replay"; return; }
    textEl.textContent = paras[idx];
    textEl.classList.remove("show-fade"); void textEl.offsetWidth; textEl.classList.add("show-fade");
    const u = new SpeechSynthesisUtterance(paras[idx]);
    const v = pickVoice(); if (v) u.voice = v;
    u.rate = 0.98; u.pitch = 1.0;
    u.onend = () => { if (stopped || paused) return; idx++; speakPara(); };
    u.onerror = () => { if (stopped || paused) return; idx++; speakPara(); };
    try { speechSynthesis.cancel(); speechSynthesis.speak(u); } catch { /* */ }
  }

  toggle.addEventListener("click", () => {
    if (idx >= paras.length) { idx = 0; paused = false; toggle.textContent = "⏸ Pause"; speakPara(); return; }
    paused = !paused;
    if (paused) { try { speechSynthesis.pause(); } catch { /* */ } toggle.textContent = "▶ Resume"; }
    else { toggle.textContent = "⏸ Pause"; try { speechSynthesis.resume(); } catch { /* */ } }
  });

  // Voice picker
  const fillVoices = () => { const vs = englishVoices(); if (!vs.length) return; const cur = pickVoice(); voiceSel.innerHTML = vs.map((v) => `<option value="${v.voiceURI}"${cur && v.voiceURI === cur.voiceURI ? " selected" : ""}>${v.name}</option>`).join(""); voiceWrap.hidden = false; };
  fillVoices();
  try { speechSynthesis.onvoiceschanged = fillVoices; } catch { /* */ }
  voiceSel.addEventListener("change", () => { localStorage.setItem("tts-voice", voiceSel.value); });

  try {
    const script = await writeScript(meta);
    if (stopped) return;
    paras = script.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    if (!paras.length) { textEl.textContent = "Couldn't write the reveal — try again."; return; }
    toggle.hidden = false; toggle.textContent = "⏸ Pause";
    speakPara();
  } catch (err) {
    if (!stopped) textEl.textContent = `Couldn't write the reveal: ${(err && err.message) || err}`;
  }
}
