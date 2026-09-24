// The app's arc — Past · Present · Future (Memoir · Diary · Fortune) — as a small reusable band.
// Pass the active phase to highlight it (or none, so all three are navigable). Wire the cells to
// actions: past → the voice memoir, present → Write, future → Futures.

export function triptychHtml(active) {
  const cell = (phase, when, what, doActive, doIdle) => {
    if (phase === active) {
      return `<div class="tri tri-${phase} tri-active" aria-current="true"><span class="tri-when">${when}</span><span class="tri-what">${what}</span><span class="tri-do">${doActive}</span></div>`;
    }
    return `<button type="button" class="tri tri-${phase}" data-phase="${phase}"><span class="tri-when">${when}</span><span class="tri-what">${what}</span><span class="tri-do">${doIdle}</span></button>`;
  };
  return `<div class="triptych">
    ${cell("past", "Past", "Memoir", "your story", "recall & record ›")}
    ${cell("present", "Present", "Diary", "today, below", "write today ›")}
    ${cell("future", "Future", "Fortune", "here", "imagine ahead ›")}
  </div>`;
}

// handlers: { past, present, future } — called when a (non-active) cell is tapped.
export function wireTriptych(container, handlers = {}) {
  container.querySelectorAll(".tri[data-phase]").forEach((el) => {
    el.addEventListener("click", () => { const fn = handlers[el.dataset.phase]; if (fn) fn(); });
  });
}
