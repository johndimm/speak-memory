// In-app dictation via the Web Speech API — wired to the 🎤 Dictate buttons in Write and
// in the memory form. It's for DESKTOP only: phones have a reliable keyboard mic, and the
// mobile speech engines are too unreliable to be worth it (Android's plays a bell on every
// pause, and some builds never respond at all). On mobile we hide the button entirely — see
// IS_MOBILE, which the Write placeholder also uses to point people at the keyboard mic.
//
// Desktop notes:
//   • Keep ONE long session (`continuous = true`) so the start-listening earcon rings once.
//   • Chrome can re-fire results; rebuild the transcript from `results[0..]` every event
//     instead of appending deltas, so a re-fired result can't duplicate words.
//   • `base` (the text finalized before a session) is captured at start; live speech appends
//     after it.

const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;

// Phones/tablets: rely on the keyboard mic, not this button.
export const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)); // iPadOS poses as Mac

export function setupDictation(micBtn, textEl, status, refreshSave) {
  if (!SpeechRec || !micBtn || IS_MOBILE) return; // mobile keeps the button hidden (keyboard mic)
  micBtn.hidden = false;

  let recog = null; // the active recognition instance, or null when idle

  const setIdle = () => { micBtn.classList.remove("listening"); micBtn.querySelector("span").textContent = "🎤 Dictate"; };
  const setLive = () => { micBtn.classList.add("listening"); micBtn.querySelector("span").textContent = "⏹ Stop"; };
  const showError = (msg) => { if (status) { status.textContent = msg; status.className = "write-status error"; } };

  function beginSession() {
    const r = new SpeechRec();
    r.lang = navigator.language || "en-US";
    r.interimResults = true;
    r.continuous = true; // one long session → the engine's start earcon rings once, not per pause
    const base = textEl.value; // text finalized before THIS session; live speech appends to it
    let activity = false;      // did the engine ever respond? (guards the unresponsive watchdog)

    // If nothing at all happens within a few seconds, the engine is unresponsive (a browser
    // without speech services). Surface it and reset, rather than sitting on a stuck "Stop".
    const watchdog = setTimeout(() => {
      if (recog !== r || activity) return;
      showError("Dictation isn't responding in this browser — type instead.");
      try { r.abort(); } catch { /* ignore */ }
      recog = null;
      setIdle();
    }, 5000);

    r.onstart = () => { activity = true; };

    r.onresult = (e) => {
      activity = true;
      // Rebuild from the top every time — never append deltas — so a re-fired result can't
      // duplicate words.
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
      showError(e.error === "not-allowed"
        ? "Microphone blocked — allow mic access for this site."
        : `Dictation error: ${e.error}`);
    };

    r.onend = () => {
      clearTimeout(watchdog);
      textEl.value = textEl.value.trimEnd();
      refreshSave();
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
      // Stop and reset the UI now, without waiting for onend.
      const r = recog;
      recog = null;
      setIdle();
      try { r.stop(); } catch { try { r.abort(); } catch { /* ignore */ } }
      return;
    }
    if (status && status.classList.contains("error")) { status.textContent = ""; status.className = "write-status"; }
    setLive();
    beginSession();
  });
}
