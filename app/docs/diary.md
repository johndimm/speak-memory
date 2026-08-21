<!-- Development diary. Newest day on top. Each day: a one-line arc, then Forward (real progress),
     Sideways (detours, wrong theories, corrections), and Open threads. Update at the end of each
     working day by PREPENDING a new "## <date>" block below this comment. -->

# Development diary

A running log of what we changed and when — the moves forward, and the sideways ones.

## 2026-08-14 — looked bad at the start, pulled it out

Began the night with things visibly broken and low confidence: saving hung, edits didn't take,
the graph was nearly empty. Ended with all of it fixed and a real semantic-zoom graph.

**Forward**
- **Editing an entry regenerates its summary.** An edit used to write to the *prose* representation and leave the raw text and the whole word→phrase→sentence→summary→outline ladder stale. Now an edit replaces the day's raw words, drops the ladder (`needsSummary`), and the background pass rebuilds it — the day and its week visibly go dirty → summarizing → ready.
- **Save can no longer hang silently.** A save is a purely local IndexedDB write, so it should take milliseconds; when it wedges (usually another tab holding the DB), it now trips an 8-second watchdog that shows a clear message *and keeps your typed text in the box* — no more "Saving…" forever followed by lost text. Added `withTimeout()` and `llmOverrides()` helpers in `record.js`.
- **Graph: killed the "54/72" count bubbles.** Reverted the earlier "a memory belongs to every year it occupied" change (it flooded the year row past the collapse threshold) back to one node per memory at its start year.
- **Graph: fits its content.** The viewBox now crops to the actual drawn nodes, with the row captions pinned to the cropped left edge, instead of a small tree floating in a fixed 1000-wide canvas.
- **Graph: semantic zoom.** At the fit view a row shows ~60 nodes before collapsing, so the 54 memories render as individual dots (the graph fills in). Zoom past ~1.6× and the crowded rows (year / subject / day / memory) reveal their names, drawn at a constant on-screen size (scaled by 1/zoom) so *more* names fit and appear the deeper you go; dense graphs expand their count-bubbles into real nodes. Pan/zoom reports the settled zoom (debounced) and re-renders only when the visible detail level would actually change.
- **Fixed the "PROSE" title that wouldn't collapse.** In `renderReps` the first representation was a plain `<h3>` while the rest were `<details>`; now every rep is a collapsible fold, with Prose open by default.

**Sideways**
- Chased "Saving… forever" through several wrong theories — misrouting to the memory save path, a stuck migration transaction — before reframing it correctly: a local write shouldn't take time at all, so the fix is fail-loud + preserve the text, not "make it faster."
- The first graph attempt (crop the viewBox) didn't fix the emptiness on its own: a tall-thin tree still letterboxes on a wide screen. The real cause was the collapsed 54-memory bubble; showing those nodes (via semantic zoom) is what filled the graph.

**Open threads**
- Confirm the save watchdog never actually trips in normal use (it shouldn't).
- Revisit "a memory in every year it occupied" for *summarization* without cluttering the graph — keep the per-year rollup, but don't create a year node per empty spanned year.
