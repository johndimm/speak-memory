# Feature spec: Places map with a year slider

A dedicated **Places** page in Speak, Memory — a map of the places I've lived, with
a year slider that moves through time and shows where I was living each year.

> Handoff note: this was scoped in the homepage session while adding Speak, Memory to
> the site. Build it in the Speak, Memory session, which has the app's full context.

## The idea

- A map (Leaflet + OpenStreetMap) with a pin for each place I've lived.
- A **year slider** along the bottom spanning my lived years.
- Dragging the slider highlights where I lived in the selected year and draws the
  **trail** of my moves over time.
- A dedicated page at the root (e.g. `/places`, like the existing `app/about.html`),
  linked from the nav.

## What the data looks like today

Memories live in IndexedDB (`app/js/db.js`, form in `app/js/memories.js`). Each memory has:

| Field | Notes |
|---|---|
| `category` | free text — e.g. `places`, `schools`, `girlfriends` |
| `subject` | optional name — e.g. "the Elm St. house", "Pasadena" |
| `start` (year) | e.g. 1971 |
| `end` (year) | optional — for a span |
| text / summary | the memory itself |

**There is no location / lat-lng stored anywhere yet.** Supplying coordinates is the
core of this feature.

## The key decision: where do coordinates come from?

- **A. Auto-geocode (recommended).** Look up each place's `subject` (and/or text) via
  OSM **Nominatim**, cache the resulting lat/lng in IndexedDB keyed by the query.
  Zero extra typing. Vague subjects like "the Elm St. house" won't resolve — so pair
  it with a **manual pin-drop fallback** for those. Respect Nominatim usage policy
  (1 req/sec, a real User-Agent, cache results).
- **B. Location field.** Add an optional "location" input to the memory form with
  search/pick, store coords with the memory. Most accurate; costs a little typing per
  place.
- **C. LLM-provided.** Ask DeepSeek (already wired) for coordinates during
  summarization. No new dependency; accuracy varies and can hallucinate — worth a
  sanity check / manual override.

**Recommended:** A, with a manual pin-drop fallback for the vague ones.

## Smaller decisions

1. **Slider semantics** — highlight the *single* place I lived in the selected year
   (with a moving trail connecting moves), or *accumulate* all places up to that year.
   Suggested default: single place + trail.
2. **Which category counts as "a place I lived"** — filter to a specific category name
   (`places` or `homes`), or a chosen set. Suggested default: `places`.

## Suggested build (default)

- **A** (auto-geocode + manual fallback) + **single-place-with-trail** slider +
  category **`places`**.
- New page like `app/about.html` at `/places`, added to the nav.
- Vanilla JS, no bundler — pull Leaflet from a CDN (`<link>` + `<script>`), consistent
  with how the app already loads assets.

## Implementation sketch

1. Query memories where `category === "places"` (case-insensitive); derive
   `{ subject, start, end, text }` per place.
2. Resolve coordinates (Option A): check an IndexedDB geocode cache; on miss, query
   Nominatim and store the result. Missing/failed → prompt a manual pin drop, saved
   back to the cache.
3. Render Leaflet map; add a marker per resolved place with a popup (name, years,
   summary snippet).
4. Year slider from `min(start)` to `max(end ?? currentYear)`. On change, highlight the
   place whose `[start, end]` span contains the year; fade the others; draw a polyline
   trail through places up to that year in chronological order.
5. Persist the last slider position (localStorage), consistent with other views.

## Notes / gotchas

- The app is phone-first — the slider and map must work well on touch.
- Everything stays on-device (IndexedDB); the geocode cache should too, so the map is
  instant on repeat visits and works offline after first load (tiles aside).
- "Places I've lived" is a subset of memories — keep it non-destructive; this view only
  reads existing memories plus a coordinates cache.
