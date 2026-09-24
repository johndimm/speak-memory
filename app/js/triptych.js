// The app's arc — Past · Present · Future (Memoir · Diary · Fortune) — as a small reusable band.
// Pass the active phase to highlight it (or none, so all three are navigable). Wire the cells to
// actions: past → the voice memoir, present → Write, future → Futures.

// context: "write" (the trio guides your INPUT) or "browse" (the trio guides your BROWSING).
export function triptychHtml(active, context = "write") {
  const idle = context === "browse"
    ? { past: "browse memoir ›", present: "recent days ›", future: "the future ›" }
    : { past: "recall & record ›", present: "write today ›", future: "imagine ahead ›" };
  const cell = (phase, when, what, doActive) => {
    if (phase === active) {
      return `<div class="tri tri-${phase} tri-active" aria-current="true"><span class="tri-when">${when}</span><span class="tri-what">${what}</span><span class="tri-do">${doActive}</span></div>`;
    }
    return `<button type="button" class="tri tri-${phase}" data-phase="${phase}"><span class="tri-when">${when}</span><span class="tri-what">${what}</span><span class="tri-do">${idle[phase]}</span></button>`;
  };
  return `<div class="triptych">
    ${cell("past", "Past", "Memoir", "your story")}
    ${cell("present", "Present", "Diary", "today, below")}
    ${cell("future", "Future", "Fortune", "here")}
  </div>`;
}

// handlers: { past, present, future } — called when a (non-active) cell is tapped.
export function wireTriptych(container, handlers = {}) {
  container.querySelectorAll(".tri[data-phase]").forEach((el) => {
    el.addEventListener("click", () => { const fn = handlers[el.dataset.phase]; if (fn) fn(); });
  });
}
