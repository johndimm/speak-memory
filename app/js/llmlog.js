// A live log of summarization jobs, shared between the pass (calendar.js) that runs them and the
// Activity page that shows them. In-memory only (per session) — it's a window into what the LLM is
// doing right now: what's pending, queued, running, done, or failed.
//
// Lifecycle of one job: add() → "pending" (dirty, waiting on children) → "queued" (ready, waiting
// for a concurrency slot) → "running" (LLM call in flight) → "done" | "error". A single-child
// period that copies up with no LLM call goes straight to "copy".

const jobs = [];
const listeners = new Set();
let seq = 0;
const MAX = 1000; // cap memory; oldest finished jobs fall off

function emit() { for (const fn of [...listeners]) { try { fn(); } catch { /* listener error is not our problem */ } } }
function find(id) { for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].id === id) return jobs[i]; return null; }

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function getJobs() { return jobs; }
export function clear() { jobs.length = 0; emit(); }

export function add(label, kind) {
  const j = { id: ++seq, label: label || "", kind: kind || "", status: "pending", addedAt: Date.now(), startedAt: 0, endedAt: 0, ms: 0, error: "" };
  jobs.push(j);
  if (jobs.length > MAX) {
    // Drop oldest FINISHED jobs first so we never discard something still in flight.
    for (let i = 0; i < jobs.length && jobs.length > MAX; ) {
      const s = jobs[i].status;
      if (s === "done" || s === "error" || s === "copy") jobs.splice(i, 1); else i++;
    }
  }
  emit();
  return j.id;
}

export function set(id, status, extra = {}) {
  const j = find(id);
  if (!j) return;
  j.status = status;
  if (status === "running" && !j.startedAt) j.startedAt = Date.now();
  if (status === "done" || status === "error" || status === "copy") {
    j.endedAt = Date.now();
    j.ms = j.endedAt - (j.startedAt || j.addedAt);
  }
  if (extra.error) j.error = String(extra.error).slice(0, 120);
  emit();
}
