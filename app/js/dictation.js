// In-app dictation via the Web Speech API — wired to the 🎤 Dictate buttons in Write and
// in the memory form. Desktop Chrome/Edge support it well; Safari partially. Android's engine
// is quirky, so this file is written around its two failure modes:
//
//   • It doesn't honor `continuous` — recognition ends after each pause. We keep hands-free
//     dictation going by starting a fresh session in `onend` (auto-restart) until the user
//     presses Stop. Desktop keeps a single continuous session.
//   • It re-fires results, which naive appending turns into repeated words. We rebuild the
//     whole transcript from `results[0..]` on every event instead of appending deltas, so a
//     re-fired result can't double up.
//
// A session's finalized text is captured as `base` when it starts; the live transcript is
// appended after it. On auto-restart the just-finalized text becomes the new base.

const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;

// Android/iOS speech engines break on `continuous`; use auto-restart there instead.
const MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

// Errors that mean "don't bother retrying" — retrying would only spin. `no-speech` (a pause)
// and `aborted` (the user pressed Stop) are normal and allow the session to restart/end quietly.
const FATAL = new Set(["not-allowed", "service-not-allowed", "audio-capture", "language-not-supported", "bad-grammar"]);

export function setupDictation(micBtn, textEl, status, refreshSave) {
  if (!SpeechRec || !micBtn) return;
  micBtn.hidden = false;

  let recog = null;      // the active recognition instance, or null when idle
  let stopping = false;  // the user pressed Stop → end for good instead of auto-restarting
  let fatal = false;     // a fatal error occurred → don't auto-restart

  const setIdle = () => { micBtn.classList.remove("listening"); micBtn.querySelector("span").textContent = "🎤 Dictate"; };
  const setLive = () => { micBtn.classList.add("listening"); micBtn.querySelector("span").textContent = "⏹ Stop"; };

  function beginSession() {
    const r = new SpeechRec();
    r.lang = navigator.language || "en-US";
    r.interimResults = true;
    r.continuous = !MOBILE;
    const base = textEl.value; // text finalized before THIS session; live speech appends to it

    r.onresult = (e) => {
      // Rebuild from the top every time — never append deltas — so a re-fired result (Android)
      // can't duplicate words.
      let finalText = "", interim = "";
      for (let i = 0; i < e.results.length; i++) {
        const chunk = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += chunk; else interim += chunk;
      }
      const sep = base && !/\s$/.test(base) ? " " : "";
      textEl.value = base + sep + (finalText + interim).replace(/^\s+/, "");
      refreshSave();
    };

    r.onerror = (e) => {
      if (e.error === "aborted" || e.error === "no-speech") return; // normal; handled in onend
      if (FATAL.has(e.error)) fatal = true;
      if (status) {
        status.textContent = e.error === "not-allowed"
          ? "Microphone blocked — allow mic access for this site."
          : `Dictation error: ${e.error}`;
        status.className = "write-status error";
      }
    };

    r.onend = () => {
      textEl.value = textEl.value.trimEnd();
      refreshSave();
      // Android ends after each pause; restart to keep listening until Stop (unless it failed).
      if (!stopping && !fatal) { beginSession(); return; }
      recog = null;
      setIdle();
      textEl.focus();
    };

    recog = r;
    try { r.start(); }
    catch { recog = null; setIdle(); } // start() throws if a session is somehow still live
  }

  micBtn.addEventListener("click", () => {
    if (recog) { stopping = true; recog.stop(); return; }
    stopping = false;
    fatal = false;
    setLive();
    beginSession();
  });
}
