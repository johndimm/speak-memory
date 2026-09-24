// Hands-free LIFE INTERVIEW — an intelligent agent talks with you to gather your life story (homes,
// schools, jobs, friends, decisions, turning points) so Futures can project a richer, better-grounded
// fortune. Each substantive answer is saved as a MEMORY whose verbatim text is exactly what you said;
// the agent structures it (category/subject/years) and asks the next probing question. Talk as long as
// you like — a ~5s pause ingests your answer (no tap). Skip changes topic; Stop ends.

import { getAllEntries, getAllMemories, getAllEntities, putMemory } from "./db.js";
import { createSpeaker, CHARACTERS, savedCharacter } from "./voicetts.js";

const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "m" + Date.now() + Math.random().toString(36).slice(2));

function llmOverrides() {
  const provider = localStorage.getItem("llm-provider") || "";
  if (!provider) return {};
  return { provider, apiKey: localStorage.getItem("llm-api-key") || "", model: localStorage.getItem("llm-model") || "", baseUrl: localStorage.getItem("llm-base-url") || "" };
}

async function buildContext() {
  const [days, mems, ents] = await Promise.all([getAllEntries(), getAllMemories(), getAllEntities()]);
  const recent = days.slice(-25).map((d) => `${d.date}: ${(d.brief || d.full || d.raw || "").replace(/\s+/g, " ").slice(0, 120)}`);
  const memLines = mems.map((m) => `${m.category || "Life"}: ${m.subject || m.label || ""}${m.startYear ? ` (${m.startYear}${m.endYear && m.endYear !== m.startYear ? "–" + m.endYear : ""})` : ""}`);
  const names = ents.map((e) => e.canonical);
  return `Recent journal days:\n${recent.join("\n") || "(none)"}\n\nKnown life-states:\n${memLines.join("\n") || "(none yet)"}\n\nNames I've mentioned: ${names.join(", ") || "(none)"}`.slice(0, 8000);
}

async function postInterview(context, convo, lastAnswer) {
  const r = await fetch("/api/summarize", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...llmOverrides(), mode: "lifeinterview", context, convo, lastAnswer }),
  });
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || `Server ${r.status}`); }
  return r.json();
}

export async function startLifeInterview(onDone) {
  if (!SpeechRec) { alert("The voice interview needs speech recognition — try Chrome on desktop or Android."); return; }
  const speaker = createSpeaker();
  speaker.unlock(); // we're inside the start-tap gesture → let mobile play audio afterward

  const ov = document.createElement("div");
  ov.className = "iv-overlay";
  ov.innerHTML = `<div class="iv-card">
      <div class="iv-name">Your life story</div>
      <div class="iv-q" id="li-q">◷ Getting ready…</div>
      <div class="iv-interim" id="li-interim"></div>
      <div class="iv-saved" id="li-saved"></div>
      <div class="iv-actions">
        <button type="button" id="li-skip">Skip ›</button>
        <button type="button" id="li-stop">Stop</button>
      </div>
      <label class="iv-voice"><span>Voice</span> <select id="li-voice">${CHARACTERS.map((c) => `<option value="${c.id}"${c.id === savedCharacter() ? " selected" : ""}>${c.label}</option>`).join("")}</select></label>
      <p class="iv-hint">Talk as long as you like — pause about 5 seconds and I'll move on. Skip to change the subject, Stop to end. The more you tell me, the sharper your Future.</p>
    </div>`;
  document.body.appendChild(ov);
  const qEl = ov.querySelector("#li-q"), interimEl = ov.querySelector("#li-interim"), savedEl = ov.querySelector("#li-saved");
  ov.querySelector("#li-voice").addEventListener("change", (e) => localStorage.setItem("tts-character", e.target.value));
  const speak = (t) => speaker.speak(t);

  let active = true, recog = null, finishTurn = null, saved = 0;
  const cleanup = () => { active = false; speaker.cancel(); try { recog && recog.stop(); } catch { /* */ } ov.remove(); onDone && onDone(saved); };
  ov.querySelector("#li-stop").addEventListener("click", () => { active = false; if (finishTurn) finishTurn("__stop__"); else cleanup(); });
  ov.querySelector("#li-skip").addEventListener("click", () => { if (finishTurn) finishTurn("__skip__"); });

  // Continuous listening that survives pauses; a ~5s trailing silence ends the turn (no tap needed).
  const SIL_MS = 5000;
  function listenTurn() {
    return new Promise((resolve) => {
      let full = "", stopped = false, r = null, silence = null;
      const done = (result) => { if (stopped) return; stopped = true; clearTimeout(silence); finishTurn = null; try { if (r) { r.onend = null; r.stop(); } } catch { /* */ } resolve(result !== undefined ? result : full.trim()); };
      finishTurn = done;
      const armSilence = () => { clearTimeout(silence); silence = setTimeout(() => { if (full.trim()) done(full.trim()); }, SIL_MS); };
      const start = () => {
        r = new SpeechRec(); r.lang = navigator.language || "en-US"; r.interimResults = true; r.continuous = true;
        r.onresult = (e) => { let interim = ""; for (let i = e.resultIndex; i < e.results.length; i++) { const res = e.results[i]; if (res.isFinal) full += res[0].transcript + " "; else interim += res[0].transcript; } interimEl.textContent = (full + interim).trim(); armSilence(); };
        r.onerror = () => { /* no-speech/aborted → onend restarts */ };
        r.onend = () => { if (!stopped) setTimeout(() => { if (!stopped) start(); }, 250); };
        recog = r;
        try { r.start(); } catch { setTimeout(() => { if (!stopped) start(); }, 400); }
      };
      start();
    });
  }

  const context = await buildContext();
  const convo = [];
  let q = "To tell your fortune, I want your story. Let's start at the beginning — where did you grow up, and what was that like?";

  while (active) {
    qEl.textContent = q; interimEl.textContent = "";
    await speak(q);
    if (!active) break;
    interimEl.textContent = "…listening";
    const ans = await listenTurn();
    if (!active || ans === "__stop__") { active = false; break; }
    const skipped = ans === "__skip__" || !ans;
    const effective = skipped ? "(Let's skip that — ask me about a different part of my life.)" : ans;
    interimEl.textContent = "";
    if (!skipped) { savedEl.textContent = "◷ noting that…"; }
    convo.push({ q, a: effective });
    let r;
    try { r = await postInterview(context, convo, effective); }
    catch (e) { r = { ack: "", memory: null, next: "" }; }
    if (!active) break;
    if (!skipped && r.memory && r.memory.subject) {
      await putMemory({ id: uid(), kind: "memory", category: r.memory.category, subject: r.memory.subject, label: r.memory.label || "", startYear: r.memory.startYear, endYear: r.memory.endYear, text: ans, needsSummary: true, createdAt: Date.now(), updatedAt: Date.now() });
      saved++;
      savedEl.textContent = `✓ Saved: ${r.memory.category} — ${r.memory.subject}  ·  ${saved} so far`;
    } else if (!skipped) { savedEl.textContent = ""; }
    if (r.ack) await speak(r.ack);
    if (!r.next || /^enough/i.test(r.next)) { await speak("I have a rich picture now. Imagine a future and it'll draw on all of this."); break; }
    q = r.next;
  }
  cleanup();
}
