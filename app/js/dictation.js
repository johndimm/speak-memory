// In-app dictation via the Web Speech API — wired to the 🎤 Dictate buttons in Write and
// in the memory form. Desktop Chrome/Edge support it well; Safari partially. Android's engine
// is quirky, so this file is written around its failure modes:
//
//   • The system plays a "start listening" earcon (a bell) on every start(). So we keep ONE
//     long session (`continuous = true`) instead of restarting per pause — one bell, not one
//     per pause. Auto-restart is kept only as a mobile fallback for engines that still end a
//     session on each pause despite `continuous`.
//   • It re-fires results, which naive appending turns into repeated words. We rebuild the
//     whole transcript from `results[0..]` on every event instead of appending deltas, so a
//     re-fired result can't double up.
//   • Some builds (seen on Android 10) never fire onstart/onresult/onend at all — the engine
//     is simply unresponsive. A watchdog surfaces that instead of leaving the button stuck on
//     "Stop", and Stop resets the UI immediately rather than waiting for an onend that may
//     never come.
//
// A session's finalized text is captured as `base` when it starts; the live transcript is
// appended after it. On auto-restart the just-finalized text becomes the new base.

const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;

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
  const showError = (msg) => { if (status) { status.textContent = msg; status.className = "write-status error"; } };

  function beginSession() {
    const r = new SpeechRec();
    r.lang = navigator.language || "en-US";
    r.interimResults = true;
    r.continuous = true; // one long session → the engine's bell rings once at start, not per pause
    const base = textEl.value; // text finalized before THIS session; live speech appends to it
    let activity = false;      // did the engine ever respond? (guards the unresponsive-device watchdog)

    // If nothing at all happens within a few seconds, the engine is unresponsive (Android 10).
    // Surface it and reset, rather than sitting on a stuck "Stop" button.
    const watchdog = setTimeout(() => {
      if (recog !== r || activity) return;
      showError("Dictation isn't responding on this device — try updating Chrome, or type instead.");
      stopping = true;
      try { r.abort(); } catch { /* ignore */ }
      recog = null;
      setIdle();
    }, 5000);

    r.onstart = () => { activity = true; };

    r.onresult = (e) => {
      activity = true;
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
      activity = true;
      if (e.error === "aborted" || e.error === "no-speech") return; // normal; handled in onend
      if (FATAL.has(e.error)) fatal = true;
      showError(e.error === "not-allowed"
        ? "Microphone blocked — allow mic access for this site."
        : `Dictation error: ${e.error}`);
    };

    r.onend = () => {
      clearTimeout(watchdog);
      textEl.value = textEl.value.trimEnd();
      refreshSave();
      // Some Android builds end the session on each pause despite continuous=true; on mobile,
      // restart to keep listening until Stop. Desktop honors continuous, so it just ends here.
      if (!stopping && !fatal && MOBILE && activity) { beginSession(); return; }
      recog = null;
      setIdle();
      textEl.focus();
    };

    recog = r;
    try { r.start(); }
    catch { clearTimeout(watchdog); recog = null; setIdle(); } // start() throws if a session is still live
  }

  micBtn.addEventListener("click", () => {
    if (recog) {
      // Stop decisively and reset the UI now — don't wait for onend, which some Android builds
      // never fire (the button would otherwise stay stuck on "Stop").
      stopping = true;
      const r = recog;
      recog = null;
      setIdle();
      try { r.stop(); } catch { try { r.abort(); } catch { /* ignore */ } }
      return;
    }
    stopping = false;
    fatal = false;
    if (status && status.classList.contains("error")) { status.textContent = ""; status.className = "write-status"; }
    setLive();
    beginSession();
  });
}
