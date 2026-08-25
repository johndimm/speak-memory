<!-- Development diary. Newest day on top. Each day: a one-line arc, then Forward (real progress),
     Sideways (detours, wrong theories, corrections), and Open threads. Update at the end of each
     working day by PREPENDING a new "## <date>" block below this comment. -->

# Development diary

A running log of what we changed and when — the moves forward, and the sideways ones.

## 2026-08-25 — Places: a map of a life

Built the **Places** tab from `docs/places-feature.md` — a Leaflet/OSM map of where a life was
lived, with a year slider that walks through time and traces the trail of moves.

**Forward**
- **Places tab** (`app/js/places.js`): Leaflet + OSM tiles from a CDN, lazy-loaded on first open; photo markers (reusing memories' era images); a year slider that highlights the place(s) active in the selected year and draws a dashed trail of moves up to that year. Scoped to the active journal (works per sample life and for your own).
- **Finding places without tagging.** Raw-subject geocoding was unusable (Lolita→Texas, Ada→Idaho, Pale Fire→a fire zone in the Philippines; Vyra/Berlin/Cornell all *missed*). Fix: a new `geoplaces` API mode has the LLM map each memory to a clean geocodable place name (or null for books/people/themes) in one cheap call. `scripts/build-samples.mjs --places` writes a `place` field onto each memory; the app geocodes that via OSM Nominatim (cached in localStorage, ~1 req/s). Nabokov's arc now resolves: St. Petersburg → Cambridge → Berlin → Paris → Ithaca → Montreux, 8/15 placed; the rest correctly drop.
- Nabokov/Hedy Lamarr look great; SNL is sparse by nature (mostly Studio 8H).

**Sideways**
- The spec said `category === "places"` filters places — but real categories are thematic (Butterflies, Exile, Writing), so that would map almost nothing. Geocoding *everything* and letting resolution be the filter is what works.
- Field names: memories use `startYear`/`endYear` (spec said `start`/`end`).

**Open threads (John's ideas for the personal side — the sample lives are solid, your own journal needs work)**
- **User-validated place fields.** Surface the geocoded guess in the UI and let people confirm / correct / pin-drop — turns fuzzy auto-detection into ground truth and rescues vague subjects ("the Elm St. house") that Nominatim can't resolve. Needs its own UX design pass.
- **Borrowed place images.** When a user has no photo of their own for a place, offer a Wikimedia/Commons image *of the location* — the same move that makes the sample lives shine, applied to real journals.
- Run the `geoplaces` enrichment client-side over a user's own memories (a "map my places" action) so their thematic subjects drop out and vague ones get cleaned, like the samples.
- Possibly distinguish **Places** (homes → the trail) from **Travel** (trips → standalone pins) once those categories are in use.

## 2026-08-21 — life decades, sample lives, and a wall of covers

A marathon: the app grew a whole new mode (fictional lives of famous people), got its own public
repo and domain, and learned to illustrate itself from Wikimedia.

**Forward**
- **Life decades.** The decade level can group by *life* (Childhood 0–12, Teenage years 13–19, then My 20s, My 30s…) instead of calendar decades, driven by a birth year. All keyed through `bucketStart/End/Label/Key` in `calendar.js`; a Settings toggle picks the mode. People default to life decades, entities to calendar.
- **Sample lives.** Model-invented first-person journals for famous subjects, each in its **own isolated IndexedDB** (`journal.js` namespaces db name + settings; switching reloads). Nothing a sample does touches your real journal.
- **Pre-baked & instant.** `scripts/build-samples.mjs` generates a life and rolls the whole summary ladder up *in-process* through the real `/api/summarize` handler, writing a fully-summarized bundle to `app/data/samples/<slug>.json`. `seedBaked()` loads one and a `baked` flag skips the background pass — zero runtime model calls.
- **Per-subject voices**, applied to entries *and* summaries: Nabokov (subtle, wry, huge vocabulary), Trump (his cadence), Hedy Lamarr (glamour over an inventor's mind). Entities use a collective voice.
- **Roster**: 3 people (Nabokov, Trump, Hedy Lamarr) + 4 entities (The Beatles, SNL, USA, Marvel). ~$0.03/life on DeepSeek.
- **Lives tab** (out of Settings), with "your journal" as the first card. Samples open **read-only** in the Journal at the **Life root** (write/edit/delete hidden).
- **Wikimedia images everywhere.** Gallery cards fetch Wikipedia portraits at runtime; bundles carry a Commons image per memory — banner-filtered (no logo "black bands"), era-varied (person+year searches), build-time deduped. Parent nodes show a **gallery** of all descendant images (Beatles' Life = a wall of album covers). Images are an **era-sequence** `[{url,year}]` and render *as of* a page's point in time.
- **`--images` refresh mode**: reimage bundles with no LLM calls, preserving summaries.
- **Repo & deploy**: made `speak-memory` its own git repo (the parent `~/projects/.git` was empty — deleted it), a `.gitignore` protecting personal journal data + secrets, deleted two key-bearing dev scripts, renamed the project `summerizing-journal` → `speak-memory` (dir + Vercel), wired Vercel Git integration (push → deploy), and turned off SSO deployment protection so the site is public.
- Graph legend wording **dirty/clean → changed/processed**; a dismissible intro card on Write.

**Sideways**
- Claimed the app had a strict CSP blocking runtime images — **wrong**, I'd conflated it with the artifact sandbox. There's no CSP; runtime Wikipedia/Commons `<img>` works, which simplified the whole photo approach.
- Commons *full-text* search is junky: it returned a random PDF for "Vyra", the wide SNL logo (the "black band"), and the same portrait four times on Trump's childhood. Fixed with subject-article-first lookup, an aspect-ratio banner filter, era-specific queries, and dedup (build-time + a per-page set).
- Rebuilt Trump fully once *before* the "don't regenerate summaries" note landed — which is what prompted the `--images`-only mode.
- Headless IndexedDB checks via `--dump-dom` captured the DOM before async resolved; leaned on screenshots and data inspection instead.

**Open threads**
- **Domains dashboard step**: register `speak-memory.vercel.app` as a Production domain so a plain `git push` fully auto-deploys — right now it's a pinned alias I re-point by hand after every deploy (done ~8×). The CLI can't add a `*.vercel.app`; only the dashboard can.
- Film posters are rarely on Commons (copyright), so a work's "later" era image usually lands on a still/photo, not a poster.
- A few loose Commons hits remain (a wrestling photo under SNL, a mugshot under "Trump 2024") — the ceiling of fuzzy search.
- Migrate the real journal to the new origin via Settings → Export/Import (URL changed with the rename).
- Matthew Guay (Wirecutter) outreach drafts sit in `outreach/`, unsent.

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
