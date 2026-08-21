// Shared rendering for summary bodies: a nested outline if the text is bullet lines,
// otherwise prose paragraphs. Used by both the Journal detail and the Write editor.

export function escapeHtml(t) {
  return String(t)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function isOutlineText(text) {
  return /^\s*-\s+/m.test(String(text));
}

const REP_LABEL = { outline: "Outline", prose: "Prose", verbatim: "Verbatim" };

function proseParagraphs(text) {
  return String(text || "").replace(/\r/g, "").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
}

// Best-matching prose paragraph for an outline item, by shared significant words.
function refFor(itemText, proseParas) {
  const toks = (s) => new Set(String(s).toLowerCase().match(/[a-z']{4,}/g) || []);
  const it = toks(itemText);
  if (it.size < 2) return -1;
  let best = -1, bestScore = 0;
  proseParas.forEach((p, i) => {
    const pt = toks(p);
    let overlap = 0;
    for (const w of it) if (pt.has(w)) overlap++;
    if (overlap > bestScore) { bestScore = overlap; best = i; }
  });
  return bestScore >= 2 ? best : -1; // need a couple of shared words to claim a link
}

// Outline where leaf items link (by data-ref) into the prose paragraphs.
function renderOutlineLinked(text, proseParas) {
  const raw = String(text).replace(/\r/g, "");
  if (!isOutlineText(raw)) return renderFull(raw);
  let out = '<div class="outline">';
  for (const line of raw.split("\n")) {
    const m = line.match(/^(\s*)-\s+(.*)$/);
    if (m) {
      const indent = m[1].replace(/\t/g, "  ").length;
      const level = Math.min(3, Math.floor(indent / 2) + 1);
      const ref = refFor(m[2], proseParas);
      const linked = ref >= 0 ? ` ol-linked" data-ref="${ref}` : "";
      out += `<div class="ol-item ol-l${level}${linked}">${escapeHtml(m[2])}</div>`;
    } else if (line.trim()) {
      out += `<div class="ol-text">${escapeHtml(line.trim())}</div>`;
    }
  }
  return out + "</div>";
}

// Render an entry's representations: the first is shown, the rest fold away (on demand).
// Shared by the Journal detail and the Write edit view.
export function renderReps(reps, leadingHtml = "") {
  const order = ["prose", "outline", "verbatim"];
  const present = order.filter((m) => reps?.[m]);
  if (present.length <= 1) return leadingHtml + renderFull(present.length ? reps[present[0]] : "");

  const proseParas = proseParagraphs(reps.prose);
  // Render each rep the same whether it's shown open or folded, so the outline→prose
  // links keep working regardless of order (prose paragraphs carry data-p indices).
  const bodyFor = (m) => {
    if (m === "prose") return proseParas.map((p, idx) => `<p data-p="${idx}">${escapeHtml(p)}</p>`).join("");
    if (m === "outline") return renderOutlineLinked(reps.outline, proseParas);
    return renderFull(reps[m]);
  };
  let html = leadingHtml;
  present.forEach((m, i) => {
    // Every rep is a collapsible fold; the first just starts open. (It used to be a plain
    // heading, so clicking it — unlike the others — did nothing.)
    const cls = m === "prose" ? "rep-fold rep-prose" : "rep-fold";
    html += `<details class="${cls}"${i === 0 ? " open" : ""}><summary class="rep-heading">${REP_LABEL[m]}</summary>${bodyFor(m)}</details>`;
  });
  return html;
}

// Wire outline→prose links inside a container (call once; uses event delegation).
export function wireReps(container) {
  container.addEventListener("click", (e) => {
    const item = e.target.closest(".ol-linked[data-ref]");
    if (!item || !container.contains(item)) return;
    const details = container.querySelector(".rep-prose");
    if (details) details.open = true;
    const para = container.querySelector(`[data-p="${item.dataset.ref}"]`);
    if (para) {
      para.scrollIntoView({ behavior: "smooth", block: "center" });
      para.classList.add("rep-hl");
      setTimeout(() => para.classList.remove("rep-hl"), 1600);
    }
  });
}

export function renderFull(text) {
  const raw = String(text).replace(/\r/g, "");
  if (!isOutlineText(raw)) {
    return raw.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${escapeHtml(p)}</p>`).join("");
  }
  let out = '<div class="outline">';
  for (const line of raw.split("\n")) {
    const m = line.match(/^(\s*)-\s+(.*)$/);
    if (m) {
      const indent = m[1].replace(/\t/g, "  ").length;
      const level = Math.min(3, Math.floor(indent / 2) + 1);
      out += `<div class="ol-item ol-l${level}">${escapeHtml(m[2])}</div>`;
    } else if (line.trim()) {
      out += `<div class="ol-text">${escapeHtml(line.trim())}</div>`;
    }
  }
  return out + "</div>";
}
