// "Tell me about your life" — fingerprint-registration-style setup. You talk freely; a checklist of
// the facts we want (age, where you live, who you live with, best friends, job) ticks off as you say
// them, and the names you mention appear live. No awkward Q&A — just keep talking until it's all set.
// When it is, the system knows enough to imagine a future.

import { getEntity, putEntity } from "./db.js";
import { ensureSelf, SELF_ID } from "./self.js";
import { resolveEntityNames } from "./entityresolve.js";
import { createSpeaker } from "./voicetts.js";
import { listenTurn as vListen, hasSpeechInput } from "./voiceinput.js";
import { jkey } from "./journal.js";

function llmOverrides() {
  const provider = localStorage.getItem("llm-provider") || "";
  if (!provider) return {};
  return { provider, apiKey: localStorage.getItem("llm-api-key") || "", model: localStorage.getItem("llm-model") || "", baseUrl: localStorage.getItem("llm-base-url") || "" };
}
async function postOnboard(text) {
  const r = await fetch("/api/summarize", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...llmOverrides(), mode: "onboard", text }),
  });
  if (!r.ok) throw new Error(`onboard ${r.status}`);
  return r.json();
}

const FACTS = [
  { key: "age", label: "Your age" },
  { key: "location", label: "Where you live" },
  { key: "livesWith", label: "Who you live with" },
  { key: "friends", label: "Your best friends" },
  { key: "job", label: "Your work" },
];
const has = (r, k) => k === "age" ? (r.age != null || r.birthYear != null)
  : k === "friends" ? (Array.isArray(r.friends) && r.friends.length > 0)
  : !!(r[k] && String(r[k]).trim());
const valueOf = (r, k) => k === "age" ? (r.age != null ? `${r.age}` : (r.birthYear != null ? `b. ${r.birthYear}` : ""))
  : k === "friends" ? (r.friends || []).join(", ")
  : (r[k] || "");

export async function startOnboarding(onDone) {
  if (!hasSpeechInput) { alert("This needs speech recognition — try Chrome on desktop or Android. (You can also type your description on your card.)"); return; }
  const speaker = createSpeaker(); speaker.unlock();
  const self = await ensureSelf();

  const ov = document.createElement("div");
  ov.className = "iv-overlay";
  ov.innerHTML = `<div class="iv-card ob-card">
      <div class="ob-title">Tell me about your life</div>
      <p class="ob-lead">Just talk — your age, where you live, who you live with, your closest friends, what you do. I'll fill these in as you go. Rephrase or add until they're all checked.</p>
      <ul class="ob-list">${FACTS.map((f) => `<li class="ob-item" id="ob-${f.key}"><span class="ob-check">○</span><span class="ob-label">${f.label}</span><b class="ob-val"></b></li>`).join("")}</ul>
      <div class="ob-names-wrap"><span class="ob-names-title">Names found</span><div class="ob-names" id="ob-names"><span class="ob-names-none">— none yet —</span></div></div>
      <div class="iv-interim" id="ob-interim"></div>
      <div class="iv-actions"><button type="button" id="ob-done" class="iv-done">Done</button><button type="button" id="ob-stop">Stop</button></div>
      <p class="iv-hint">Everything you say is saved as your description. Say “stop” or tap Done when you're finished.</p>
    </div>`;
  document.body.appendChild(ov);
  const interimEl = ov.querySelector("#ob-interim"), namesEl = ov.querySelector("#ob-names");

  let active = true, finishTurn = null;
  let transcript = self.note || "";
  const seen = new Set();
  const cleanup = () => { active = false; speaker.cancel(); if (finishTurn) finishTurn("stop"); ov.remove(); };
  const doneBtn = ov.querySelector("#ob-done"), stopBtn = ov.querySelector("#ob-stop");
  let finished = false;
  const finishNow = async () => { if (finished) return; finished = true; active = false; if (finishTurn) finishTurn("stop"); await save(); speaker.cancel(); ov.remove(); onDone && onDone(); };
  doneBtn.addEventListener("click", finishNow);
  stopBtn.addEventListener("click", finishNow);

  const setCheck = (r) => {
    let done = 0;
    for (const f of FACTS) {
      const li = ov.querySelector(`#ob-${f.key}`);
      const ok = has(r, f.key);
      if (ok) done++;
      li.querySelector(".ob-check").textContent = ok ? "✓" : "○";
      li.classList.toggle("ob-ok", ok);
      li.querySelector(".ob-val").textContent = ok ? valueOf(r, f.key) : "";
    }
    return done;
  };
  const addNames = async (names) => {
    const fresh = names.filter((m) => m && m.name && !seen.has(m.name.toLowerCase()));
    fresh.forEach((m) => seen.add(m.name.toLowerCase()));
    if (!fresh.length) return;
    ov.querySelector(".ob-names-none")?.remove();
    for (const m of fresh) { const chip = document.createElement("span"); chip.className = "ob-chip"; chip.textContent = m.name; namesEl.appendChild(chip); }
    // Persist: create/resolve them and link to the self entity, so they show in Names right away.
    try {
      const refs = (await resolveEntityNames(fresh)).filter((rid) => rid !== SELF_ID);
      const cur = (await getEntity(SELF_ID)) || self;
      const noteRefs = [...new Set([...(cur.noteRefs || []), ...refs])];
      await putEntity({ ...cur, noteRefs, updatedAt: Date.now() });
    } catch { /* */ }
  };
  let lastFacts = {};
  async function save() {
    const cur = (await getEntity(SELF_ID)) || self;
    const patch = { ...cur, note: transcript.trim(), updatedAt: Date.now() };
    await putEntity(patch);
    const by = lastFacts.birthYear || (lastFacts.age ? new Date().getFullYear() - lastFacts.age : null);
    if (by) { try { localStorage.setItem(jkey("birth-year"), String(by)); } catch { /* */ } }
  }

  await speaker.speak("Tell me about your life right now — your age, where you live, who you live with, your closest friends, and what you do. I'll fill these in as you talk.");

  while (active) {
    interimEl.textContent = "…listening";
    const ctrl = {};
    finishTurn = (cmd) => { if (cmd === "stop") ctrl.stop && ctrl.stop(); else ctrl.finish && ctrl.finish(); };
    const res = await vListen({ silenceMs: 4500, onInterim: (t) => { interimEl.textContent = t; }, control: ctrl });
    if (!active) break;
    if (res.command === "stop") { await finishNow(); return; }
    if (!res.text) continue;
    transcript = (transcript + " " + res.text).trim();
    interimEl.textContent = "◷ …";
    let r; try { r = await postOnboard(transcript); } catch { continue; }
    if (!active) break;
    lastFacts = r;
    const done = setCheck(r);
    await addNames(r.names || []);
    await save(); // keep the description + names saved as we go
    interimEl.textContent = "";
    if (done === FACTS.length) { await speaker.speak("That's everything I need. You can imagine a future now, or keep going."); }
  }
}
