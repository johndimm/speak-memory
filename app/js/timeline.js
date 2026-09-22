// "Timeline" tab — a life as concurrent STATES over time. Where the Journal rolls memories up by
// time, and Places pins them on a map, this lays the enduring states — homes, schools, jobs,
// relationships (and any category with spans) — as parallel tracks you can scrub, zoom, and edit
// in place. Events (single-year memories: successes, surgeries…) sit beneath as diamonds.
//
// A "state" is any memory with a span. Drag the cursor to read the COMPLETE state of any year;
// zoom in to reveal more labels; click a bar to fix a wrong year or name right here; click an
// empty stretch of a lane to add a state you forgot. Every edit writes back to the same memories
// the Journal summarizes, and marks them for re-summary.

import { getAllMemories, putMemory, deleteMemory } from "./db.js";
import { escapeHtml } from "./render.js";
import { activeJournalId, jkey, isSampleJournal } from "./journal.js";

// Categories that are inherently states even when a single memory has no end year. Any OTHER
// category still becomes a lane if any of its memories carries an end year (a real span); the rest
// (successes, surgeries, movies, dreams, jokes…) fall to the events strip.
const KNOWN_STATES = new Set(["places", "schools", "jobs", "girl friends", "friends", "relationships", "homes", "partners"]);
// Life-continuity lanes: the most recent one is presumed to continue to today (still living there,
// still together). A new later entry (a move, a breakup) simply becomes the new "current" one.
const CONTINUE_LANES = new Set(["places", "homes", "girl friends", "relationships", "partners", "friends"]);
// Nicer lane titles for the known categories; anything else uses its own name.
const LANE_TITLE = { "places": "Homes", "girl friends": "Relationships" };
// Fixed, CVD-safe hue order (validated) assigned to lanes in first-appearance order.
const HUES = ["#2a78d6", "#1baf7a", "#eb6834", "#4a3aa7", "#e87ba4", "#0e7c86", "#b8860b", "#7a3ea7"];

const readBirthYear = () => {
  const v = Number(localStorage.getItem(jkey("birth-year")));
  return Number.isFinite(v) && v > 1000 && v < 2200 ? v : null;
};
const NOW_Y = new Date().getFullYear();
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const titleCase = (s) => String(s).replace(/\b\w/g, (c) => c.toUpperCase());
const num = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
const clean = (s) => (s || "").replace(/\./g, " ").trim();

let CSS_INJECTED = false;
function injectCss() {
  if (CSS_INJECTED) return; CSS_INJECTED = true;
  const s = document.createElement("style");
  s.id = "timeline-css";
  s.textContent = `
  .tl-wrap{max-width:1120px;margin:0 auto;}
  .tl-intro{color:var(--ink-soft);margin:0 0 14px;max-width:62ch;font-size:.95rem;line-height:1.5;}
  .tl-now{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);overflow:hidden;margin-bottom:16px;}
  .tl-now-head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid var(--line);background:var(--paper-deep);}
  .tl-now-head h3{font-family:var(--font-display);font-size:1.25rem;margin:0;font-weight:400;}
  .tl-year-pill{font-family:var(--font-body);font-weight:600;font-size:.9rem;background:var(--card);border:1px solid var(--line);border-radius:999px;padding:2px 11px;}
  .tl-age{color:var(--ink-soft);font-size:.8rem;}
  .tl-now-hint{margin-left:auto;color:var(--ink-soft);font-size:.75rem;}
  .tl-now-grid{display:grid;grid-template-columns:repeat(4,1fr);}
  .tl-slot{padding:12px 14px 14px;border-right:1px solid var(--line);min-width:0;}
  .tl-slot:last-child{border-right:0;}
  .tl-slot .tl-lab{display:flex;align-items:center;gap:6px;font-size:.66rem;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-soft);margin-bottom:7px;}
  .tl-dot{width:9px;height:9px;border-radius:3px;flex:none;}
  .tl-slot .tl-val{font-family:var(--font-display);font-size:1.2rem;line-height:1.15;overflow-wrap:anywhere;}
  .tl-slot .tl-val.empty{color:var(--ink-soft);font-style:italic;}
  .tl-slot .tl-meta{margin-top:4px;font-size:.78rem;color:var(--ink-soft);}
  @media(max-width:640px){.tl-now-grid{grid-template-columns:repeat(2,1fr)}.tl-slot:nth-child(2){border-right:0}.tl-slot:nth-child(-n+2){border-bottom:1px solid var(--line)}}
  .tl-card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);}
  .tl-top{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:11px 16px;border-bottom:1px solid var(--line);}
  .tl-top h3{font-family:var(--font-display);font-size:1.05rem;margin:0;font-weight:400;}
  .tl-zoom{display:flex;align-items:center;gap:4px;margin-left:auto;}
  .tl-zoom button,.tl-add{font:inherit;font-size:.85rem;background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:4px 10px;cursor:pointer;line-height:1.1;}
  .tl-zoom button:hover,.tl-add:hover{background:var(--paper-deep);}
  .tl-zoom button:focus-visible,.tl-add:focus-visible{outline:2px solid var(--accent);outline-offset:2px;}
  .tl-add{margin-left:8px;font-weight:600;}
  .tl-playbtn{margin-left:10px;font:inherit;font-size:.9rem;line-height:1;background:var(--accent);color:#fff;border:1px solid var(--accent);border-radius:999px;padding:4px 12px;cursor:pointer;font-weight:600;}
  .tl-playbtn:hover{filter:brightness(1.06);}
  .tl-playbtn.playing{background:var(--card);color:var(--accent);}
  .tl-playbtn:focus-visible{outline:2px solid var(--accent);outline-offset:2px;}
  .tl-full{margin-left:8px;font:inherit;font-size:1rem;line-height:1;background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:3px 9px;cursor:pointer;}
  .tl-full:hover{background:var(--paper-deep);}
  .tl-full:focus-visible{outline:2px solid var(--accent);outline-offset:2px;}
  /* Full screen (native or the iOS faux fallback): the tracks card fills the display, its scroller
     takes all the extra width so more years fit. */
  .tl-card:fullscreen, .tl-card:-webkit-full-screen, .tl-card.tl-faux-full{width:100vw;height:100dvh;border-radius:0;margin:0;background:var(--card);display:flex;flex-direction:column;}
  .tl-card.tl-faux-full{position:fixed;inset:0;z-index:80;}
  .tl-card:fullscreen .tl-scroll, .tl-card:-webkit-full-screen .tl-scroll, .tl-card.tl-faux-full .tl-scroll{flex:1 1 auto;}
  .tl-scroll{overflow-x:auto;overflow-y:hidden;padding:6px 16px 16px;}
  .tl-plot{position:relative;cursor:ew-resize;user-select:none;-webkit-user-select:none;}
  .tl-plot:focus-visible{outline:2px solid var(--accent);outline-offset:4px;border-radius:8px;}
  .tl-grid{position:absolute;top:0;width:1px;background:var(--line);}
  .tl-grid.dec{background:rgba(26,22,18,.22);}
  .tl-tick{position:absolute;transform:translateX(-50%);font-size:.72rem;color:var(--ink-soft);font-variant-numeric:tabular-nums;}
  .tl-lane-label{position:absolute;left:0;z-index:4;display:flex;align-items:center;gap:6px;font-size:.78rem;font-weight:600;color:var(--ink);background:var(--card);padding:2px 10px 2px 2px;pointer-events:none;box-shadow:7px 0 7px -7px rgba(26,22,18,.28);}
  .tl-bar{position:absolute;height:20px;border-radius:5px;display:flex;align-items:center;padding:0 7px;font-size:.72rem;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;cursor:pointer;box-shadow:inset 0 0 0 2px var(--card);}
  .tl-bar:hover{filter:brightness(1.07);z-index:6;}
  .tl-bar.pt{padding:0;}
  .tl-bar.ong{-webkit-mask:linear-gradient(90deg,#000 82%,transparent);mask:linear-gradient(90deg,#000 82%,transparent);}
  .tl-bar .arw{margin-left:auto;padding-left:4px;opacity:.85;}
  .tl-bar-lab{position:absolute;height:13px;line-height:1;display:flex;align-items:flex-end;font-size:.68rem;font-weight:600;white-space:nowrap;pointer-events:none;z-index:3;}
  .tl-ev{position:absolute;width:11px;height:11px;background:var(--ink-soft);border:1.5px solid var(--card);transform:translateX(-50%) rotate(45deg);border-radius:2px;cursor:pointer;}
  .tl-ev:hover{background:var(--accent);}
  .tl-play{position:absolute;top:0;width:2px;background:var(--accent);z-index:7;pointer-events:none;}
  .tl-play::before{content:"";position:absolute;top:-3px;left:50%;transform:translateX(-50%);width:11px;height:11px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 3px var(--card);}
  .tl-flag{position:absolute;z-index:8;transform:translateX(-50%);font-family:var(--font-body);font-weight:600;font-size:.72rem;color:var(--card);background:var(--accent);padding:1px 7px;border-radius:5px;pointer-events:none;white-space:nowrap;}
  .tl-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:14px;}
  .tl-stat{background:var(--card);border:1px solid var(--line);border-radius:11px;padding:11px 13px;}
  .tl-stat .k{font-size:.66rem;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-soft);display:flex;align-items:center;gap:6px;}
  .tl-stat .v{font-family:var(--font-display);font-size:1.5rem;margin-top:3px;}
  .tl-stat .d{font-size:.74rem;color:var(--ink-soft);margin-top:1px;}
  @media(max-width:640px){.tl-stats{grid-template-columns:repeat(2,1fr)}}
  .tl-tip{position:fixed;z-index:60;pointer-events:none;background:var(--ink);color:var(--paper);font-size:.78rem;line-height:1.35;padding:6px 9px;border-radius:7px;box-shadow:var(--shadow);max-width:240px;opacity:0;transition:opacity .1s;}
  .tl-tip .s{font-family:var(--font-display);font-size:.92rem;}
  .tl-tip-snip{margin-top:4px;opacity:.85;font-size:.74rem;line-height:1.3;}
  .tl-tip-hint{margin-top:4px;opacity:.65;font-size:.7rem;}
  .tl-pop{position:fixed;z-index:70;background:var(--card);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow);padding:14px;width:min(20rem,92vw);}
  .tl-pop h4{margin:0 0 10px;font-family:var(--font-display);font-weight:400;font-size:1.1rem;}
  .tl-field{display:block;margin-bottom:9px;}
  .tl-field span{display:block;font-size:.68rem;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-soft);margin-bottom:3px;}
  .tl-field input{width:100%;font:inherit;font-size:.9rem;padding:6px 9px;border:1px solid var(--line);border-radius:8px;background:var(--paper);color:var(--ink);}
  .tl-years{display:flex;gap:9px;}
  .tl-years .tl-field{flex:1;margin-bottom:9px;}
  .tl-pop-actions{display:flex;align-items:center;gap:8px;margin-top:12px;}
  .tl-pop-actions button{font:inherit;font-size:.85rem;border-radius:8px;padding:6px 13px;cursor:pointer;border:1px solid var(--line);background:var(--card);color:var(--ink);}
  .tl-pop-save{background:var(--accent)!important;color:#fff!important;border-color:var(--accent)!important;font-weight:600;}
  .tl-pop-del{margin-left:auto;color:#b1372a!important;border-color:transparent!important;background:transparent!important;}
  .tl-pop-full{background:transparent!important;border-color:transparent!important;color:var(--ink-soft)!important;padding-left:0!important;}
  .tl-backdrop{position:fixed;inset:0;z-index:65;}
  .tl-empty{color:var(--ink-soft);padding:20px;font-size:.95rem;}
  `;
  document.head.appendChild(s);
}

export function initTimeline(root, { onEditMemory, onOpenMemory, onChanged } = {}) {
  injectCss();
  const readOnly = isSampleJournal();
  let mems = [];        // all memories, by reference
  let lanes = [];       // [{cat, title, hue, items:[state...] }]
  let events = [];      // [{subject, year, kind}]
  let Y0 = 1950, Y1 = NOW_Y;
  let pxy = 12;         // px per year (zoom)
  let cursor = NOW_Y;
  let playRaf = 0, playYear = 0, playLast = 0; // "Play" animation: sweep the cursor across the years
  // Each row reserves LBL_H of headroom above its 20px bar for an outside name label (used when the
  // bar itself is too narrow to hold the name), so short/adjacent bars stay labelable at any zoom.
  const G = 104, RPAD = 46, LBL_H = 13, BAR_H = 20, ROW_H = LBL_H + BAR_H + 1, LABEL_H = 22, LANE_PAD = 8, EV_H = 40, AXIS_H = 30;
  // Max zoom (px/year). High enough that a ONE-year gap between consecutive starts still exceeds a
  // name's width, so tightly-packed single-year states (e.g. a run of one-year relationships) can be
  // spread far enough apart to label each one.
  const MAX_PXY = 200;
  const zoomKey = "timeline-zoom::" + activeJournalId();

  let tip, pop = null, backdrop = null, fitPending = true;

  function stateFromMem(m) {
    const s = num(m.startYear); if (s == null) return null;
    let e = num(m.endYear);
    // an explicit end wins; otherwise a known-ongoing feel is left to the data (single year)
    const point = e == null;
    if (e == null) e = s;
    return { id: m.id, subject: clean(m.subject) || clean(m.category) || m.label || "—", start: s, end: e, point, ongoing: false, mem: m };
  }

  function buildModel() {
    const byCat = new Map();
    for (const m of mems) {
      const cat = (m.category || "").trim() || "Uncategorized";
      (byCat.get(cat) || byCat.set(cat, []).get(cat)).push(m);
    }
    const laneCats = [], evList = [];
    for (const [cat, list] of byCat) {
      const known = KNOWN_STATES.has(cat.toLowerCase());
      const hasSpan = list.some((m) => num(m.endYear) != null && num(m.endYear) !== num(m.startYear));
      if (known || hasSpan) laneCats.push(cat);
      else for (const m of list) { const y = num(m.startYear); if (y != null) evList.push({ subject: clean(m.subject) || cat, year: y, kind: cat }); }
    }
    // order lanes by earliest start year
    laneCats.sort((a, b) => firstStart(byCat.get(a)) - firstStart(byCat.get(b)));
    lanes = laneCats.map((cat, i) => {
      const items = byCat.get(cat).map(stateFromMem).filter(Boolean).sort((x, y) => x.start - y.start || x.end - y.end);
      // A home you never moved out of, or a partner you're still with, continues to today: treat the
      // latest-started state of a life-continuity lane as ongoing. (Jobs/Schools clearly end, so no.)
      if (CONTINUE_LANES.has(cat.toLowerCase()) && items.length) {
        const last = items.reduce((a, b) => (b.start > a.start ? b : a));
        last.ongoing = true; last.end = Math.max(last.end, NOW_Y); last.point = false;
      }
      return { cat, title: LANE_TITLE[cat.toLowerCase()] || cat, hue: HUES[i % HUES.length], items };
    });
    events = evList.sort((a, b) => a.year - b.year);
    const allYears = [...lanes.flatMap((l) => l.items.flatMap((s) => [s.start, s.end])), ...events.map((e) => e.year), NOW_Y];
    Y0 = Math.min(...allYears, NOW_Y); Y1 = Math.max(...allYears, NOW_Y);
    if (readBirthYear()) Y0 = Math.min(Y0, readBirthYear());
  }
  function firstStart(list) { return Math.min(...list.map((m) => num(m.startYear) ?? 9999)); }

  function packLane(items) {
    const rowEnds = [];
    for (const it of items) {
      let r = 0; for (; r < rowEnds.length; r++) if (it.start > rowEnds[r]) break;
      it._row = r; rowEnds[r] = it.end;
    }
    return Math.max(1, rowEnds.length);
  }

  const SPAN = () => Math.max(1, Y1 - Y0);
  const xOf = (y) => G + (y - Y0) * pxy;
  const contentW = () => G + (SPAN() + 1) * pxy + RPAD;
  // px/year at which the whole life exactly fills the panel — the most zoomed-out we ever go, so
  // the plot never shrinks narrower than its container and strands empty space on the right.
  const fitPxy = () => {
    const s = root.querySelector("#tlScroll");
    return Math.max(4, ((s ? s.clientWidth : 1000) - 4 - G - RPAD) / (SPAN() + 1));
  };

  // ---- render shell ----
  function render() {
    stopPlay(); // a full rebuild replaces the playhead/button; don't leave a loop running
    buildModel();
    if (!lanes.length && !events.length) {
      root.innerHTML = `<div class="tl-wrap"><p class="tl-empty">No states yet. States are memories with a category like <b>Places</b>, <b>Jobs</b>, <b>Schools</b>, or <b>Girl Friends</b> and a start year (an end year draws the span). Add a few in <b>Write</b> and they'll lay out here.</p></div>`;
      return;
    }
    root.innerHTML = `
      <div class="tl-wrap">
        <p class="tl-intro">Your life as enduring <b>states</b> — where you lived, studied, worked, and loved — laid out as parallel tracks. Drag the cursor to read the complete state of any year${readOnly ? "" : "; click a bar to fix a wrong year or name, or an empty stretch to add a state you forgot"}.</p>
        <section class="tl-now">
          <div class="tl-now-head">
            <h3>State in</h3>
            <span class="tl-year-pill" id="tlYear">${cursor}</span>
            <span class="tl-age" id="tlAge"></span>
            <span class="tl-now-hint">drag ↓ · ← → keys · − / + to zoom</span>
          </div>
          <div class="tl-now-grid" id="tlNowGrid"></div>
        </section>
        <section class="tl-card">
          <div class="tl-top">
            <h3>The tracks</h3>
            <button type="button" class="tl-playbtn" id="tlPlayBtn" aria-label="Play through the years" title="Play through the years">▶</button>
            <div class="tl-zoom">
              <button type="button" id="tlOut" aria-label="Zoom out">−</button>
              <button type="button" id="tlFit" aria-label="Fit whole life">Fit</button>
              <button type="button" id="tlIn" aria-label="Zoom in">+</button>
            </div>
            ${readOnly ? "" : `<button type="button" class="tl-add" id="tlAdd">＋ Add state</button>`}
            <button type="button" class="tl-full" id="tlFull" aria-label="Full screen" title="Full screen">⤢</button>
          </div>
          <div class="tl-scroll" id="tlScroll"><div class="tl-plot" id="tlPlot" tabindex="0" role="slider" aria-label="Year cursor"></div></div>
        </section>
        <div class="tl-stats" id="tlStats"></div>
      </div>`;

    if (tip) tip.remove();
    tip = document.createElement("div"); tip.className = "tl-tip"; document.body.appendChild(tip);
    // On open, fit the whole life to the panel — then the reader zooms IN to reveal more labels.
    if (fitPending) {
      const sw = root.querySelector("#tlScroll").clientWidth;
      pxy = Math.max(4, Math.min(MAX_PXY, (sw - 4 - G - RPAD) / (SPAN() + 1)));
      fitPending = false;
    }
    buildNowGrid();
    draw();
    wireControls();
    // resize redraw so "Fit" tracks the panel width
    if (!render._ro) { render._ro = new ResizeObserver(() => { if (root.offsetParent) positionPlay(); }); }
  }

  function buildNowGrid() {
    const grid = root.querySelector("#tlNowGrid");
    grid.innerHTML = lanes.map((l) =>
      `<div class="tl-slot" data-cat="${escapeHtml(l.cat)}">
        <div class="tl-lab"><span class="tl-dot" style="background:${l.hue}"></span>${escapeHtml(l.title)}</div>
        <div class="tl-val" data-v="${escapeHtml(l.cat)}">—</div>
        <div class="tl-meta" data-m="${escapeHtml(l.cat)}"></div>
      </div>`).join("");
  }

  // ---- draw the plot at the current zoom ----
  let laneGeom = [], plotEl, lanesH = 0;
  function draw() {
    plotEl = root.querySelector("#tlPlot");
    laneGeom = []; let top = 0;
    const parts = lanes.map((l) => {
      const rows = packLane(l.items);
      const h = LABEL_H + rows * ROW_H + LANE_PAD;
      const g = { lane: l, top, h, rows }; laneGeom.push(g); top += h; return g;
    });
    lanesH = top;
    const totalH = lanesH + EV_H + AXIS_H;
    const W = contentW();
    plotEl.style.width = W + "px"; plotEl.style.height = totalH + "px";

    let html = "";
    for (let y = Math.ceil(Y0 / 5) * 5; y <= Y1; y += 5) {
      const dec = y % 10 === 0;
      html += `<div class="tl-grid${dec ? " dec" : ""}" style="left:${xOf(y)}px;height:${lanesH + EV_H}px"></div>`;
      if (dec) html += `<div class="tl-tick" style="left:${xOf(y)}px;top:${lanesH + EV_H + 8}px">${y}</div>`;
    }
    html += `<div class="tl-tick" style="left:${xOf(Y1)}px;top:${lanesH + EV_H + 8}px">now</div>`;

    for (const g of parts) {
      html += `<div style="position:absolute;left:0;top:${g.top}px;width:${W}px;height:${g.h}px">`;
      html += `<div class="tl-lane-label" style="top:6px"><span class="tl-dot" style="background:${g.lane.hue}"></span>${escapeHtml(g.lane.title)}</div>`;
      // add-target sits BEHIND the bars so clicking a bar edits it and clicking empty space adds one
      if (!readOnly) html += `<div class="tl-laneadd" data-cat="${escapeHtml(g.lane.cat)}" style="position:absolute;left:${G}px;top:${LABEL_H}px;right:0;height:${g.rows * ROW_H}px"></div>`;
      // Where each row's NEXT bar starts. An above-bar label only prints when the run of clear space
      // from THIS bar's start to the next bar's start on the same row can hold the name — that gap
      // grows as you zoom, so a crowded stretch stays clean at "fit" and reveals each name as you
      // zoom in (works even for bars butted right up against the next one, which have no room to
      // their right at any zoom).
      const items = g.lane.items, nextStartX = new Array(items.length).fill(Infinity), seenRow = new Map();
      for (let i = items.length - 1; i >= 0; i--) { const r = items[i]._row; if (seenRow.has(r)) nextStartX[i] = xOf(items[seenRow.get(r)].start); seenRow.set(r, i); }
      items.forEach((it, i) => {
        const left = xOf(it.start), w = Math.max(pxy - 1, (it.end - it.start + 1) * pxy - 2);
        const rowTop = LABEL_H + it._row * ROW_H;
        const text = titleCase(it.subject), label = escapeHtml(text);
        const inside = w > 42 && !it.point; // wide enough to hold the name within the bar
        html += `<div class="tl-bar${it.point ? " pt" : ""}${it.ongoing ? " ong" : ""}" data-id="${escapeHtml(it.id)}"
          style="left:${left}px;width:${w}px;top:${rowTop + LBL_H}px;background:${g.lane.hue}">${inside ? label : ""}${it.ongoing ? '<span class="arw">›</span>' : ""}</div>`;
        if (!inside && nextStartX[i] - left >= text.length * 6.6 + 6)
          html += `<div class="tl-bar-lab" style="left:${left}px;top:${rowTop}px;color:${g.lane.hue}">${label}</div>`;
      });
      html += `</div>`;
    }
    // events
    html += `<div style="position:absolute;left:0;top:${lanesH}px;width:${W}px;height:${EV_H}px">`;
    html += `<div class="tl-lane-label" style="top:2px"><span class="tl-dot" style="background:var(--ink-soft);transform:rotate(45deg);border-radius:2px"></span>Events</div>`;
    for (const e of events) html += `<div class="tl-ev" data-ev="${escapeHtml(e.subject)}" data-kind="${escapeHtml(e.kind)}" data-year="${e.year}" style="left:${xOf(e.year)}px;top:5px"></div>`;
    html += `</div>`;
    // playhead + flag
    html += `<div class="tl-play" id="tlPlay" style="left:${xOf(cursor)}px;height:${lanesH + EV_H}px"></div>`;
    html += `<div class="tl-flag" id="tlFlag" style="left:${xOf(cursor)}px;top:-2px">${cursor}</div>`;

    plotEl.innerHTML = html;
    plotEl.setAttribute("aria-valuemin", Y0); plotEl.setAttribute("aria-valuemax", Y1);
    wirePlot();
    buildStats();
    setCursor(cursor);
    if (render._ro) { render._ro.disconnect(); render._ro.observe(root.querySelector("#tlScroll")); }
  }

  function positionPlay() {
    const play = root.querySelector("#tlPlay"), flag = root.querySelector("#tlFlag");
    if (!play) return;
    const x = xOf(cursor);
    play.style.left = x + "px"; flag.style.left = x + "px";
    flag.textContent = cursor === Y1 ? cursor + " · now" : cursor;
  }

  // ---- "Play": animate the cursor from the start of the life to now, so the State panel updates as
  // the playhead sweeps across the years. Auto-scrolls to keep the playhead in view when zoomed in.
  function placePlayhead(year) { // like positionPlay but at a fractional year (smooth motion)
    const play = root.querySelector("#tlPlay"), flag = root.querySelector("#tlFlag");
    if (!play) return;
    const x = xOf(year);
    play.style.left = x + "px"; flag.style.left = x + "px";
  }
  function keepPlayheadVisible(year) {
    const sc = root.querySelector("#tlScroll"); if (!sc) return;
    const x = xOf(year), m = 90;
    if (x < sc.scrollLeft + m) sc.scrollLeft = x - m;
    else if (x > sc.scrollLeft + sc.clientWidth - m) sc.scrollLeft = x - sc.clientWidth + m;
  }
  function setPlayBtn(playing) {
    const b = root.querySelector("#tlPlayBtn");
    if (b) { b.textContent = playing ? "⏸" : "▶"; b.setAttribute("aria-label", playing ? "Pause" : "Play through the years"); b.classList.toggle("playing", playing); }
  }
  function stopPlay() { if (playRaf) cancelAnimationFrame(playRaf); playRaf = 0; setPlayBtn(false); }
  function startPlay() {
    if (playRaf) return;
    playYear = cursor >= Y1 ? Y0 : cursor; // replay from the beginning once it has reached now
    playLast = performance.now();
    setPlayBtn(true);
    const speed = Math.max(3, SPAN() / 20); // years/sec — a whole life plays in ~20s
    const tick = (now) => {
      playYear = Math.min(Y1, playYear + Math.min(0.1, (now - playLast) / 1000) * speed);
      playLast = now;
      if (Math.round(playYear) !== cursor) setCursor(Math.round(playYear)); // refresh the State panel each year
      placePlayhead(playYear); keepPlayheadVisible(playYear);
      if (playYear >= Y1) { setCursor(Y1); stopPlay(); return; }
      playRaf = requestAnimationFrame(tick);
    };
    playRaf = requestAnimationFrame(tick);
  }
  const togglePlay = () => (playRaf ? stopPlay() : startPlay());

  function activeAt(lane, year) {
    const hit = lane.items.filter((s) => s.start <= year && year <= s.end).sort((a, b) => b.start - a.start);
    return hit[0] || null;
  }
  function setCursor(year) {
    cursor = Math.max(Y0, Math.min(Y1, Math.round(year)));
    positionPlay();
    plotEl.setAttribute("aria-valuenow", cursor);
    const yEl = root.querySelector("#tlYear"), aEl = root.querySelector("#tlAge");
    if (yEl) yEl.textContent = cursor;
    const by = readBirthYear();
    if (aEl) aEl.textContent = by ? "age " + (cursor - by) : "";
    for (const l of lanes) {
      const a = activeAt(l, cursor);
      const v = root.querySelector(`[data-v="${cssEsc(l.cat)}"]`), m = root.querySelector(`[data-m="${cssEsc(l.cat)}"]`);
      if (!v) continue;
      if (a) {
        v.textContent = titleCase(a.subject); v.classList.remove("empty");
        m.textContent = a.ongoing ? `since ${a.start} · ${cursor - a.start} yr` : (a.start === a.end ? `${a.start}` : `${a.start}–${a.end}`);
      } else { v.textContent = gapText(l); v.classList.add("empty"); m.textContent = ""; }
    }
  }
  function gapText(l) {
    const t = l.cat.toLowerCase();
    if (t === "jobs") return "— between jobs";
    if (t === "schools") return "— none";
    if (t === "girl friends" || t === "relationships") return "— single";
    return "—";
  }
  const cssEsc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&"));

  // ---- stats ----
  function buildStats() {
    const el = root.querySelector("#tlStats");
    el.innerHTML = lanes.slice(0, 4).map((l) => {
      let maxg = 0, at = "";
      const its = [...l.items].sort((a, b) => a.start - b.start);
      // Gap = years with NOTHING active. Track the running max end ("cover"), not just the previous
      // item's end, or a short span nested inside a longer one (e.g. Patty Shaw inside LuAnne Alward)
      // would invent a phantom gap the longer span actually covers.
      let cover = its.length ? its[0].end : 0;
      for (let i = 1; i < its.length; i++) {
        const gp = its[i].start - cover - 1;
        if (gp > maxg) { maxg = gp; at = `${cover}–${its[i].start}`; }
        cover = Math.max(cover, its[i].end);
      }
      return `<div class="tl-stat"><div class="k"><span class="tl-dot" style="background:${l.hue}"></span>${escapeHtml(l.title)}</div>
        <div class="v">${l.items.length}</div><div class="d">${maxg ? `longest gap ${maxg} yr${maxg !== 1 ? "s" : ""} (${at})` : "no gaps"}</div></div>`;
    }).join("");
  }

  // ---- interaction ----
  function showTip(html, x, y) {
    tip.innerHTML = html; tip.style.opacity = 1;
    const r = tip.getBoundingClientRect();
    let nx = x + 14, ny = y + 14;
    if (nx + r.width > innerWidth - 8) nx = x - r.width - 14;
    if (ny + r.height > innerHeight - 8) ny = y - r.height - 14;
    tip.style.left = nx + "px"; tip.style.top = ny + "px";
  }
  const hideTip = () => { if (tip) tip.style.opacity = 0; };

  function wirePlot() {
    const scroll = root.querySelector("#tlScroll");
    const yearAt = (clientX) => { const r = plotEl.getBoundingClientRect(); return (clientX - r.left - G) / pxy + Y0; };
    // Container-level listeners live on the persistent #tlPlot / #tlScroll nodes. draw() reruns
    // wirePlot on every zoom step, so bind these ONCE per render (guarded) — otherwise they stack,
    // and each duplicate re-fires, making the cursor drag jankier the more you zoom. (Zoom itself is
    // driven only by the − / Fit / + buttons; there is deliberately no scroll-wheel zoom — it proved
    // impossible to control with trackpad scroll acceleration and momentum.) The per-bar/-event
    // listeners below sit on fresh nodes each draw, so they re-bind normally.
    if (!plotEl._tlWired) {
      plotEl._tlWired = true;
      let dragging = false, moved = false, downX = 0;
      plotEl.addEventListener("pointerdown", (e) => {
        if (e.target.closest(".tl-bar") || e.target.closest(".tl-ev")) return; // let those handle click
        stopPlay(); // taking the cursor by hand ends playback
        dragging = true; moved = false; downX = e.clientX;
        try { plotEl.setPointerCapture(e.pointerId); } catch (_) {}
        setCursor(yearAt(e.clientX));
      });
      plotEl.addEventListener("pointermove", (e) => { if (dragging) { if (Math.abs(e.clientX - downX) > 3) moved = true; setCursor(yearAt(e.clientX)); hideTip(); } });
      plotEl.addEventListener("pointerup", (e) => {
        if (dragging && !moved && !readOnly) { const t = e.target.closest(".tl-laneadd"); if (t) openEditor(null, t.dataset.cat, Math.round(yearAt(e.clientX)), e.clientX, e.clientY); }
        dragging = false;
      });
      plotEl.addEventListener("pointercancel", () => { dragging = false; });
      plotEl.addEventListener("keydown", (e) => {
        if (e.key === " ") { togglePlay(); e.preventDefault(); return; } // Space toggles playback
        if (e.key === "ArrowLeft") { stopPlay(); setCursor(cursor - 1); e.preventDefault(); }
        else if (e.key === "ArrowRight") { stopPlay(); setCursor(cursor + 1); e.preventDefault(); }
        else if (e.key === "Home") { stopPlay(); setCursor(Y0); e.preventDefault(); }
        else if (e.key === "End") { stopPlay(); setCursor(Y1); e.preventDefault(); }
      });
    }
    if (!scroll._tlWired) {
      scroll._tlWired = true;
      // Keep lane labels pinned to the visible left edge as the plot scrolls horizontally.
      scroll.addEventListener("scroll", pinLabels);
    }
    // bars & events
    plotEl.querySelectorAll(".tl-bar").forEach((b) => {
      const it = findState(b.dataset.id);
      const snip = (m) => { const t = (m && (m.text || (m.prose && m.prose.full) || m.brief) || "").replace(/\s+/g, " ").trim(); return t ? `<div class="tl-tip-snip">${escapeHtml(t.slice(0, 160))}${t.length > 160 ? "…" : ""}</div>` : ""; };
      const span = (it.ongoing ? `${it.start} – now · ${NOW_Y - it.start} yrs` : (it.start === it.end ? `${it.start}` : `${it.start}–${it.end} · ${it.end - it.start} yr${it.end - it.start !== 1 ? "s" : ""}`));
      b.addEventListener("pointerenter", (e) => it && showTip(`<div class="s">${escapeHtml(titleCase(it.subject))}</div><div>${span}</div>${snip(it.mem)}<div class="tl-tip-hint">tap to see the basis ›</div>`, e.clientX, e.clientY));
      b.addEventListener("pointermove", (e) => tip.style.opacity == 1 && showTip(tip.innerHTML, e.clientX, e.clientY));
      b.addEventListener("pointerleave", hideTip);
      // Tap a bar → open its source page (read the full state text + summary). On your own journal
      // this is the quick-edit; anywhere (incl. read-only futures) "see the basis" opens the page.
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!readOnly && it) { openEditor(it, it.mem.category, it.start, e.clientX, e.clientY); }
        else if (it && onOpenMemory) { onOpenMemory(it.mem); }
      });
    });
    plotEl.querySelectorAll(".tl-ev").forEach((v) => {
      v.addEventListener("pointerenter", (e) => showTip(`<div class="s">${escapeHtml(titleCase(v.dataset.ev))}</div><div>${escapeHtml(v.dataset.kind)} · ${v.dataset.year}</div>`, e.clientX, e.clientY));
      v.addEventListener("pointerleave", hideTip);
    });
    pinLabels(); // re-pin after this draw's fresh labels (declaration hoisted for the guard above)
    function pinLabels() { const sl = scroll.scrollLeft; plotEl.querySelectorAll(".tl-lane-label").forEach((l) => { l.style.transform = `translateX(${sl}px)`; }); }
  }
  const findState = (id) => { for (const l of lanes) { const s = l.items.find((x) => x.id === id); if (s) return s; } return null; };

  // Re-fit the whole life to the current panel width (used by the Fit button and after a
  // fullscreen change, where the panel suddenly gets much wider).
  function fitToPanel() {
    const sc = root.querySelector("#tlScroll"); if (!sc) return;
    const w = sc.clientWidth - 4;
    if (w > 0) zoomTo((w - G - RPAD) / (SPAN() + 1), (Y0 + Y1) / 2);
  }
  const inFull = () => document.fullscreenElement || root.querySelector(".tl-card")?.classList.contains("tl-faux-full");
  function toggleFull() {
    const card = root.querySelector(".tl-card"); if (!card) return;
    if (inFull()) {
      if (document.fullscreenElement) document.exitFullscreen?.(); else card.classList.remove("tl-faux-full");
    } else if (card.requestFullscreen) {
      card.requestFullscreen().catch(() => card.classList.add("tl-faux-full")); // iOS Safari lacks element fullscreen
    } else card.classList.add("tl-faux-full");
    if (!document.fullscreenElement) requestAnimationFrame(fitToPanel); // faux path: refit now (native path refits on the event)
  }
  function wireControls() {
    root.querySelector("#tlIn").addEventListener("click", () => zoomTo(pxy * 1.4, cursor));
    root.querySelector("#tlOut").addEventListener("click", () => zoomTo(pxy / 1.4, cursor));
    root.querySelector("#tlFit").addEventListener("click", fitToPanel);
    root.querySelector("#tlFull").addEventListener("click", toggleFull);
    root.querySelector("#tlPlayBtn").addEventListener("click", togglePlay);
    const addBtn = root.querySelector("#tlAdd");
    if (addBtn) addBtn.addEventListener("click", () => openEditor(null, lanes[0] ? lanes[0].cat : "Jobs", cursor, addBtn.getBoundingClientRect().left, addBtn.getBoundingClientRect().bottom + 6));
  }
  function zoomTo(newPxy, keepYear, screenX) {
    const scroll = root.querySelector("#tlScroll");
    const minPxy = Math.min(fitPxy(), MAX_PXY); // fit is the floor; never zoom out past the whole life
    newPxy = Math.max(minPxy, Math.min(MAX_PXY, newPxy));
    if (Math.abs(newPxy - pxy) < 0.01) return;
    pxy = newPxy; localStorage.setItem(zoomKey, String(Math.round(pxy)));
    draw();
    // keep the referenced year under the same screen position
    requestAnimationFrame(() => {
      const targetX = screenX != null ? (screenX - scroll.getBoundingClientRect().left) : (scroll.clientWidth / 2);
      scroll.scrollLeft = xOf(keepYear) - targetX;
    });
  }

  // ---- inline editor ----
  function closePop() { if (pop) { pop.remove(); pop = null; } if (backdrop) { backdrop.remove(); backdrop = null; } }
  function openEditor(state, cat, year, x, y) {
    closePop();
    const isNew = !state;
    backdrop = document.createElement("div"); backdrop.className = "tl-backdrop";
    backdrop.addEventListener("click", closePop);
    document.body.appendChild(backdrop);
    pop = document.createElement("div"); pop.className = "tl-pop";
    const cats = [...new Set(mems.map((m) => (m.category || "").trim()).filter(Boolean))];
    pop.innerHTML = `
      <h4>${isNew ? "Add state" : "Edit state"}</h4>
      <label class="tl-field"><span>Subject</span><input id="tlpSub" list="tlpCats" value="${isNew ? "" : escapeHtml(state.subject === "—" ? "" : state.subject)}" placeholder="a name — Websense, Roosevelt High…"></label>
      <label class="tl-field"><span>Category</span><input id="tlpCat" list="tlpCatList" value="${escapeHtml(cat || "")}" placeholder="Jobs, Places, Schools…">
        <datalist id="tlpCatList">${cats.map((c) => `<option value="${escapeHtml(c)}">`).join("")}</datalist></label>
      <div class="tl-years">
        <label class="tl-field"><span>Start year</span><input id="tlpStart" inputmode="numeric" value="${isNew ? (year || "") : state.start}" placeholder="1986"></label>
        <label class="tl-field"><span>End year</span><input id="tlpEnd" inputmode="numeric" value="${isNew || state.point ? "" : state.end}" placeholder="ongoing"></label>
      </div>
      <div class="tl-pop-actions">
        <button type="button" class="tl-pop-save" id="tlpSave">${isNew ? "Add" : "Save"}</button>
        ${isNew ? "" : `<button type="button" class="tl-pop-full" id="tlpFull">Edit full ›</button>`}
        ${isNew ? "" : `<button type="button" class="tl-pop-del" id="tlpDel">Delete</button>`}
      </div>`;
    document.body.appendChild(pop);
    // position within viewport
    const pw = pop.getBoundingClientRect();
    let px = Math.min(x, innerWidth - pw.width - 10), py = Math.min(y, innerHeight - pw.height - 10);
    pop.style.left = Math.max(8, px) + "px"; pop.style.top = Math.max(8, py) + "px";
    pop.querySelector("#tlpSub").focus();

    pop.querySelector("#tlpSave").addEventListener("click", () => saveState(state, {
      subject: pop.querySelector("#tlpSub").value.trim(),
      category: pop.querySelector("#tlpCat").value.trim(),
      start: num(pop.querySelector("#tlpStart").value),
      end: num(pop.querySelector("#tlpEnd").value),
    }));
    const full = pop.querySelector("#tlpFull");
    if (full) full.addEventListener("click", () => { closePop(); onEditMemory && onEditMemory(state.mem); });
    const del = pop.querySelector("#tlpDel");
    if (del) del.addEventListener("click", async () => {
      if (!confirm(`Delete “${titleCase(state.subject)}”? This removes the memory.`)) return;
      await deleteMemory(state.id); closePop(); await reload(); onChanged && onChanged();
    });
    pop.addEventListener("keydown", (e) => { if (e.key === "Escape") closePop(); else if (e.key === "Enter" && e.target.tagName === "INPUT") pop.querySelector("#tlpSave").click(); });
  }

  async function saveState(state, f) {
    if (f.start == null && !f.subject) { closePop(); return; }
    const start = f.start, end = f.end && f.end !== f.start ? f.end : null;
    const label = start == null ? "sometime" : (end ? `${Math.min(start, end)}–${Math.max(start, end)}` : String(start));
    if (state) {
      const merged = { ...state.mem, subject: f.subject, category: f.category || state.mem.category, startYear: start, endYear: end, label, needsSummary: true, updatedAt: Date.now() };
      await putMemory(merged);
    } else {
      const m = { id: uid(), category: f.category || "Jobs", subject: f.subject, startYear: start, endYear: end, label,
        text: f.subject ? `${f.subject}${start ? ` (${label})` : ""}.` : "", needsSummary: true, createdAt: Date.now(), updatedAt: Date.now() };
      await putMemory(m);
    }
    closePop(); await reload(); onChanged && onChanged();
  }

  async function reload() { mems = await getAllMemories(); const savedCursor = cursor; render(); cursor = Math.max(Y0, Math.min(Y1, savedCursor)); setCursor(cursor); }

  // Entering/leaving native fullscreen changes the panel width — refit the whole life to it once the
  // browser has laid out the new size. Added once (initTimeline runs a single time).
  document.addEventListener("fullscreenchange", () => { if (!root.hidden) setTimeout(fitToPanel, 120); });

  return {
    open: async () => { mems = await getAllMemories(); cursor = Math.min(NOW_Y, new Date().getFullYear()); fitPending = true; render(); },
    close: () => {
      stopPlay();
      closePop(); hideTip(); if (tip) { tip.remove(); tip = null; } if (render._ro) render._ro.disconnect();
      if (document.fullscreenElement) document.exitFullscreen?.();
      root.querySelector(".tl-card")?.classList.remove("tl-faux-full");
    },
  };
}
