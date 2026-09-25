// One correct speech-input loop for all the hands-free flows (interviews, memory capture).
//
// The Android bug: with continuous recognition the engine re-fires the WHOLE results list, so
// appending each event's transcript duplicates words ("text repeated over and over"). The fix
// (same as dictation.js) is to REBUILD the transcript from results[0..] every event, and only
// carry a `base` string across the auto-restarts mobile needs — never append deltas.
//
// listenTurn resolves { text, command } where command is "stop" | "skip" | null. It ends on ~silence,
// an end-word (e.g. "done"), a spoken stop/skip, or a call to the provided control's finish/skip/stop.

const SpeechRec = typeof window !== "undefined" && (window.SpeechRecognition || window.webkitSpeechRecognition);
export const hasSpeechInput = !!SpeechRec;

export function listenTurn({ silenceMs = 5000, endWords = [], onInterim, control } = {}) {
  return new Promise((resolve) => {
    if (!SpeechRec) { resolve({ text: "", command: null }); return; }
    let base = "", current = "", stopped = false, r = null, silence = null;

    const parse = (t) => {
      const low = String(t).toLowerCase().trim();
      if (/\b(stop|finished|that'?s all|end session)\b[.!?]*$/.test(low)) return { text: t, command: "stop" };
      if (/^(skip|scratch that|never mind|forget it)\b/.test(low) || /\b(skip|scratch that|never mind)\b[.!?]*$/.test(low)) return { text: t, command: "skip" };
      let text = t;
      for (const w of endWords) text = text.replace(new RegExp("\\b" + w + "\\b[.!?]*\\s*$", "i"), "").trim();
      return { text, command: null };
    };
    const done = (res) => {
      if (stopped) return; stopped = true; clearTimeout(silence);
      try { if (r) { r.onend = null; r.stop(); } } catch { /* */ }
      resolve(res);
    };
    if (control) {
      control.finish = () => done(parse(current));
      control.skip = () => done({ text: current.trim(), command: "skip" });
      control.stop = () => done({ text: current.trim(), command: "stop" });
    }
    const arm = () => { clearTimeout(silence); silence = setTimeout(() => { if (current.trim()) done(parse(current)); }, silenceMs); };

    const start = () => {
      r = new SpeechRec(); r.lang = navigator.language || "en-US"; r.interimResults = true; r.continuous = true;
      r.onresult = (e) => {
        // Rebuild from the top — never append — so a re-fired results list can't duplicate words.
        let finalText = "", interim = "";
        for (let i = 0; i < e.results.length; i++) {
          const chunk = e.results[i][0].transcript;
          if (e.results[i].isFinal) finalText += chunk; else interim += chunk;
        }
        const sep = base && !/\s$/.test(base) ? " " : "";
        current = (base + sep + finalText + interim).replace(/\s+/g, " ").trim();
        if (onInterim) onInterim(current);
        const low = current.toLowerCase();
        if (endWords.length && endWords.some((w) => new RegExp("\\b" + w + "\\b[.!?]*$", "i").test(low))) { done(parse(current)); return; }
        arm();
      };
      r.onerror = () => { /* no-speech/aborted → onend restarts */ };
      r.onend = () => { base = current; if (!stopped) setTimeout(() => { if (!stopped) start(); }, 250); }; // commit finals, keep listening
      try { r.start(); } catch { setTimeout(() => { if (!stopped) start(); }, 400); }
    };
    start();
  });
}
