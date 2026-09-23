// "Activity" page — a live view of the summarization queue: what LLM calls are pending, queued,
// running right now, done, or failed. Reads the shared job log (llmlog.js), which the background
// pass writes to. Updates live while the pass runs; a 1s tick keeps the running timers moving.

import { getJobs, subscribe, clear } from "./llmlog.js";
import { escapeHtml } from "./render.js";

const STATUS_LABEL = { pending: "waiting", queued: "queued", running: "summarizing…", done: "done", error: "failed", copy: "copied (no call)" };
const ORDER = { running: 0, queued: 1, pending: 2, error: 3, copy: 4, done: 5 };

function secs(ms) { return `${(ms / 1000).toFixed(1)}s`; }

// The most common error string among failed jobs, so the banner names the real cause.
function commonError(jobs) {
  const counts = new Map();
  for (const j of jobs) if (j.status === "error" && j.error) counts.set(j.error, (counts.get(j.error) || 0) + 1);
  let best = "", n = 0;
  for (const [msg, c] of counts) if (c > n) { n = c; best = msg; }
  return best;
}

export function initActivity(root, { onRetry } = {}) {
  let unsub = null;
  let tick = null;

  function render() {
    const jobs = getJobs();
    const count = (s) => jobs.filter((j) => j.status === s).length;
    const running = count("running"), queued = count("queued"), pending = count("pending");
    const done = count("done") + count("copy"), errors = count("error");
    const total = jobs.length;
    const finished = done + errors;
    const pct = total ? Math.round((finished / total) * 100) : 0;
    const anyActive = running + queued + pending > 0;

    // Active jobs first (running, then queued, then pending), then failures, then most-recent finished.
    const active = jobs.filter((j) => j.status === "running" || j.status === "queued" || j.status === "pending")
      .sort((a, b) => (ORDER[a.status] - ORDER[b.status]) || (a.addedAt - b.addedAt));
    const now = Date.now();
    // Finished items, MOST RECENTLY COMPLETED first (by end time, not add order).
    const finishedRows = jobs.filter((j) => j.status === "done" || j.status === "error" || j.status === "copy")
      .sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0)).slice(0, 80);

    const ago = (t) => { if (!t) return ""; const s = Math.round((now - t) / 1000); if (s < 5) return "just now"; if (s < 60) return `${s}s ago`; const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`; return `${Math.floor(m / 60)}h ago`; };
    const row = (j, showAgo) => {
      const dur = j.status === "running" ? secs(now - (j.startedAt || now))
        : (j.status === "done" || j.status === "error" || j.status === "copy") ? secs(j.ms) : "";
      const when = showAgo ? `<span class="act-ago">${ago(j.endedAt)}</span>` : "";
      return `<div class="act-row act-${j.status}">
        <span class="act-dot"></span>
        <span class="act-label">${escapeHtml(j.label || "(untitled)")}</span>
        <span class="act-kind">${escapeHtml(j.kind || "")}</span>
        <span class="act-state">${STATUS_LABEL[j.status] || j.status}${j.error ? ` — ${escapeHtml(j.error)}` : ""}</span>
        ${when}<span class="act-dur">${dur}</span>
      </div>`;
    };

    root.innerHTML = `
      <div class="activity">
        <div class="act-head">
          <h2 class="act-title">Activity</h2>
          <div class="act-actions">
            ${errors ? `<button type="button" class="act-retry" id="act-retry">Retry ${errors} failed</button>` : ""}
            <button type="button" class="act-clear" id="act-clear">Clear</button>
          </div>
        </div>
        <p class="field-hint">Every summarization the app runs — what's waiting, what's summarizing right now, and what's finished. This updates on its own.</p>

        <div class="act-bar"><div class="act-bar-fill" style="width:${pct}%"></div></div>
        <div class="act-stats">
          <span class="act-stat"><b>${finished}</b> of <b>${total}</b> done</span>
          <span class="act-stat act-s-running"><b>${running}</b> summarizing</span>
          <span class="act-stat act-s-queued"><b>${queued}</b> queued</span>
          <span class="act-stat act-s-pending"><b>${pending}</b> waiting</span>
          ${errors ? `<span class="act-stat act-s-error"><b>${errors}</b> failed</span>` : ""}
        </div>

        ${errors ? `<p class="act-errbanner">⚠ ${errors} call${errors === 1 ? "" : "s"} failed — ${escapeHtml(commonError(jobs) || "see the failed rows below")}. Fix the cause, then Retry.</p>` : ""}

        ${total === 0
          ? `<p class="act-empty">Nothing summarizing right now. Open a journal or step into a future and the queue shows up here.</p>`
          : `
            ${active.length ? `<h3 class="act-section">Now &amp; next</h3><div class="act-list">${active.map((j) => row(j, false)).join("")}</div>` : (anyActive ? "" : `<p class="act-empty">All caught up — nothing left to summarize.</p>`)}
            ${finishedRows.length ? `<h3 class="act-section">Recently finished — newest first</h3><div class="act-list act-list-done">${finishedRows.map((j) => row(j, true)).join("")}</div>` : ""}
          `}
      </div>`;

    root.querySelector("#act-clear")?.addEventListener("click", () => clear());
    root.querySelector("#act-retry")?.addEventListener("click", () => onRetry?.());
  }

  return {
    open() {
      render();
      unsub = subscribe(render);
      tick = setInterval(() => { if (getJobs().some((j) => j.status === "running")) render(); }, 1000);
    },
    close() {
      if (unsub) { unsub(); unsub = null; }
      if (tick) { clearInterval(tick); tick = null; }
    },
  };
}
