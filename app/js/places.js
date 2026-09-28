// "Places" tab — a map of where a life was lived, with a year slider that walks through time.
//
// No location data is stored on memories. Instead every memory's `subject` is geocoded via OSM
// Nominatim; the ones that resolve to a real place become pins (so "Berlin"/"Cornell"/"Montreux"
// pin, while "Lolita"/"butterflies" simply drop out — geocoding IS the filter). Results are cached
// in localStorage, shared across journals (a place's coordinates don't depend on whose life it is).
//
// Leaflet + OSM tiles are pulled from a CDN, lazy-loaded the first time the tab opens. Everything
// else stays on-device; the tab only reads existing memories plus the coordinate cache.

import { getAllMemories, putMemory } from "./db.js";
import { activeJournalId } from "./journal.js";
import { ensureSelf } from "./self.js";

const LEAFLET_CSS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
const LEAFLET_JS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";

let leafletReady = null;
function ensureLeaflet() {
  if (leafletReady) return leafletReady;
  leafletReady = new Promise((resolve, reject) => {
    if (window.L) return resolve(window.L);
    if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet"; link.href = LEAFLET_CSS;
      document.head.appendChild(link);
    }
    const s = document.createElement("script");
    s.src = LEAFLET_JS;
    s.onload = () => resolve(window.L);
    s.onerror = () => reject(new Error("Could not load the map library."));
    document.head.appendChild(s);
  });
  return leafletReady;
}

// ---- Geocoding (Nominatim), cached in localStorage, serialized to ~1 req/sec ------------------
const geoKey = (q) => "geo::" + q.toLowerCase().replace(/\s+/g, " ").trim();
let lastGeoAt = 0;
async function geocode(query) {
  const key = geoKey(query);
  const cached = localStorage.getItem(key);
  if (cached !== null) { try { return JSON.parse(cached); } catch { return null; } }
  const wait = Math.max(0, 1100 - (Date.now() - lastGeoAt));
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastGeoAt = Date.now();
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (!r.ok) return null; // transient — don't cache a failure
    const j = await r.json();
    const hit = Array.isArray(j) ? j[0] : null;
    const val = hit ? { lat: +hit.lat, lng: +hit.lon, display: hit.display_name } : null;
    localStorage.setItem(key, JSON.stringify(val)); // cache hits AND definitive misses
    return val;
  } catch { return null; }
}

const memImage = (m) => (m.images && m.images[0] && m.images[0].url) || (m.imageUrls && m.imageUrls[0]) || null;
const memSentence = (m) => (m.levels && m.levels.sentence) || (m.prose && m.prose.brief) || m.label || "";

// Work out, ONCE per story, the real place it happened — or that it isn't a place at all (a person,
// a job, a theme). The model sees the story's own summary and where you live (Me), so a bare street
// becomes "Werner Street, San Diego, California, USA" instead of the first "Werner St" on Earth.
// The answer is saved on the story (`place`: a geocodable string, or null = not a place).
async function resolvePlaces(mems, onProgress) {
  const todo = mems.filter((m) => m.startYear != null && !Number.isFinite(m.lat) && m.place !== null && !(m.place && String(m.place).trim()) && (m.subject || m.label));
  if (!todo.length) return;
  let context = "";
  try {
    const f = ((await ensureSelf()) || {}).facts || {};
    if (f.location) context = `I live in ${f.location}${f.locationSince ? ` (since ${f.locationSince})` : ""}. Unless a memory says otherwise, streets and schools are probably near where I lived at the time.`;
  } catch { /* */ }
  // Your own model/key from Settings, if you chose one (same rule as the rest of the app).
  const provider = localStorage.getItem("llm-provider") || "";
  const overrides = provider ? { provider, apiKey: localStorage.getItem("llm-api-key") || "", model: localStorage.getItem("llm-model") || "", baseUrl: localStorage.getItem("llm-base-url") || "" } : {};
  // Small batches (whole memories, never cut off mid-list), a few at a time.
  const batches = [];
  for (let i = 0; i < todo.length; i += 12) batches.push(todo.slice(i, i + 12));
  let done = 0;
  onProgress?.(`Finding where your places are… 0 of ${todo.length}`);
  await Promise.all(batches.map(async (batch) => {
    try {
      const r = await fetch("/api/summarize", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...overrides, mode: "geoplaces", context, memories: batch.map((m) => ({
          id: m.id, subject: m.subject || m.label || "", category: m.category || "",
          years: m.startYear ? `${m.startYear}${m.endYear && m.endYear !== m.startYear ? "–" + m.endYear : ""}` : "",
          hint: String((m.levels && (m.levels.paragraph || m.levels.sentence)) || (m.prose && m.prose.brief) || m.text || "").replace(/\{\{(?:e:)?[^|{}]+\|([^{}]*)\}\}/g, "$1"),
        })) }),
      });
      if (!r.ok) return;
      const { places = {} } = await r.json();
      for (const m of batch) {
        if (!(m.id in places)) continue;
        m.place = places[m.id]; // string, or null = not a place
        try { await putMemory({ ...m }); } catch { /* read-only (a Future's past) — use it for this view only */ }
      }
    } catch { /* offline — try again next time */ }
    done += batch.length;
    onProgress?.(`Finding where your places are… ${done} of ${todo.length}`);
  }));
}

// Candidate places from the active journal's memories.
// Priority: (1) exact coordinates the user picked via the Location field (memory.lat/lng) — no
// geocoding needed, always right; (2) an LLM-assigned clean place name (sample lives); (3) the raw
// subject. `place === null` explicitly means "not a physical place" → skip.
async function collectPlaces(onProgress, onStatus) {
  const mems = await getAllMemories();
  await resolvePlaces(mems, onStatus);
  const exact = [];   // user-picked coords, plotted directly
  const byQuery = new Map(); // needs geocoding, deduped by query
  for (const m of mems) {
    if (m.startYear == null) continue;
    if (Number.isFinite(m.lat) && Number.isFinite(m.lng)) {
      exact.push({ subject: (m.place || m.subject || "").trim(), startYear: m.startYear, endYear: m.endYear || m.startYear, image: memImage(m), sentence: memSentence(m), lat: m.lat, lng: m.lng, display: m.place || "" });
      continue;
    }
    // Only stories that ARE places: `place` is the resolved, geocodable name; null means not a place.
    const query = (m.place || "").trim();
    if (!query) continue;
    const prev = byQuery.get(query.toLowerCase());
    const label = (m.subject || query).trim();
    if (!prev || m.startYear < prev.startYear) {
      byQuery.set(query.toLowerCase(), { query, subject: label, startYear: m.startYear, endYear: m.endYear || m.startYear, image: memImage(m), sentence: memSentence(m) });
    }
  }
  // Stories whose location you picked are plotted exactly; every other place story is located from its
  // resolved place (with a fallback to its neighborhood/town). Both show together.
  const places = [...exact];
  let done = 0;
  for (const c of [...byQuery.values()]) {
    // If the exact address isn't found, step outward — drop the street, then the neighborhood —
    // so the story still lands on its town ("Waverly Street, La Jolla, …" → "La Jolla, …").
    let g = await geocode(c.query);
    const parts = c.query.split(",").map((x) => x.trim()).filter(Boolean);
    for (let cut = 1; !g && parts.length - cut >= 2; cut++) g = await geocode(parts.slice(cut).join(", "));
    done++;
    onProgress?.(done, byQuery.size);
    if (g) places.push({ ...c, lat: g.lat, lng: g.lng, display: g.display });
  }
  places.sort((a, b) => a.startYear - b.startYear || a.endYear - b.endYear);
  return places;
}

// Street View: a marker/popup photo of the actual spot, via our server-side proxy (keeps the key
// secret). We check the free metadata endpoint first, so places with no coverage keep a plain dot
// rather than a broken image.
const svThumb = (p) => `./api/streetview?lat=${p.lat}&lng=${p.lng}&size=96x96`;
const svLarge = (p) => `./api/streetview?lat=${p.lat}&lng=${p.lng}&size=480x300`;
async function enrichStreetView(places) {
  await Promise.all(places.map(async (p) => {
    try {
      const r = await fetch(`./api/streetview?meta=1&lat=${p.lat}&lng=${p.lng}`);
      if (r.ok) { const j = await r.json(); if (j.ok) p.streetview = true; }
    } catch { /* no street view → keep the dot / era image */ }
  }));
}

// A round marker showing the place's Street View (or era photo, or a dot). Bright when active.
function markerIcon(L, place, active) {
  const photo = place.streetview ? svThumb(place) : place.image;
  const img = photo
    ? `<span class="pm-photo" style="background-image:url('${String(photo).replace(/'/g, "%27")}')"></span>`
    : `<span class="pm-dot"></span>`;
  return L.divIcon({ className: "", html: `<span class="place-marker${active ? " active" : ""}">${img}</span>`, iconSize: [40, 40], iconAnchor: [20, 20] });
}

export function initPlaces(root) {
  let map = null, markers = [], trail = null, places = [], destroyed = false, fsCleanup = null;

  function escapeHtml(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  function shell(body) {
    root.innerHTML = `<div class="places-wrap">${body}</div>`;
  }

  async function render() {
    destroyed = false;
    shell(`<p class="places-status" id="places-status">Loading the map…</p>
      <div class="places-mapwrap" id="places-mapwrap" hidden>
        <div id="places-map" class="places-map"></div>
        <button type="button" class="places-full" id="places-full" title="Full screen" aria-label="Full screen">⤢</button>
      </div>
      <div class="places-slider" id="places-slider" hidden>
        <label class="places-year" id="places-year"></label>
        <input type="range" id="places-range" step="1">
      </div>`);
    const statusEl = root.querySelector("#places-status");
    let L;
    try { L = await ensureLeaflet(); } catch (e) { statusEl.textContent = e.message; return; }
    if (destroyed) return;

    statusEl.textContent = "Finding the places in this life…";
    places = await collectPlaces(
      (d, n) => { if (!destroyed) statusEl.textContent = `Locating places… ${d}/${n}`; },
      (msg) => { if (!destroyed) statusEl.textContent = msg; });
    if (destroyed) return;
    await enrichStreetView(places); // flag which places have Street View coverage (falls back to dots)
    if (destroyed) return;

    if (!places.length) {
      statusEl.innerHTML = `No mappable places yet. Places come from your memories' subjects (a city, a house, a school) — add a memory with a place as its subject, and it'll appear here.`;
      return;
    }

    statusEl.hidden = true;
    const mapWrap = root.querySelector("#places-mapwrap"); mapWrap.hidden = false;
    const mapEl = root.querySelector("#places-map");
    const sliderWrap = root.querySelector("#places-slider"); sliderWrap.hidden = false;

    // Full-screen the whole Places view (map + slider) so it works in landscape on a phone. Falls
    // back to a CSS-only "faux fullscreen" class where the Fullscreen API is unavailable (iOS Safari).
    const wrap = root.querySelector(".places-wrap");
    const fullBtn = root.querySelector("#places-full");
    const onFsChange = () => setTimeout(() => map && map.invalidateSize(), 60);
    fullBtn.addEventListener("click", () => {
      if (document.fullscreenElement) { document.exitFullscreen?.(); return; }
      if (wrap.requestFullscreen) wrap.requestFullscreen().catch(() => wrap.classList.toggle("faux-full"));
      else { wrap.classList.toggle("faux-full"); onFsChange(); }
    });
    document.addEventListener("fullscreenchange", onFsChange);

    // Size the view to the real available height (viewport minus the wrap's top offset), so the
    // slider is always on-screen — CSS can't measure the app bar, and a magic offset breaks in
    // landscape. Recompute on resize/orientation change. Skipped in fullscreen (CSS handles it).
    const fitHeight = () => {
      if (destroyed || document.fullscreenElement || wrap.classList.contains("faux-full")) return;
      const top = wrap.getBoundingClientRect().top;
      wrap.style.height = Math.max(200, window.innerHeight - top - 10) + "px"; // fit; low floor for landscape
      if (map) map.invalidateSize();
    };
    window.addEventListener("resize", fitHeight);
    window.addEventListener("orientationchange", fitHeight);
    fitHeight();
    fsCleanup = () => {
      document.removeEventListener("fullscreenchange", onFsChange);
      window.removeEventListener("resize", fitHeight);
      window.removeEventListener("orientationchange", fitHeight);
    };

    map = L.map(mapEl, { scrollWheelZoom: true, attributionControl: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    map.fitBounds(places.map((p) => [p.lat, p.lng]), { padding: [40, 40], maxZoom: 6 });

    markers = places.map((p) => L.marker([p.lat, p.lng], { icon: markerIcon(L, p, false) })
      .bindPopup(`<div class="place-pop">${p.streetview ? `<img class="place-pop-sv" src="${svLarge(p)}" alt="Street view of ${escapeHtml(p.subject)}" loading="lazy">` : ""}<strong>${escapeHtml(p.subject)}</strong><div class="place-pop-years">${p.startYear}${p.endYear !== p.startYear ? "–" + p.endYear : ""}</div>${p.sentence ? `<div class="place-pop-line">${escapeHtml(p.sentence)}</div>` : ""}</div>`)
      .addTo(map));

    // Year slider from the first lived year through the present, so the timeline reaches "now" even
    // if your last recorded place was years ago. The most-recent place is treated as where you still
    // are — it stays highlighted for every year after it begins, up to today.
    const nowY = new Date().getFullYear();
    const minY = Math.min(...places.map((p) => p.startYear));
    const lastStart = Math.max(...places.map((p) => p.startYear));
    const maxY = Math.max(Math.max(...places.map((p) => p.endYear)), nowY);
    const range = root.querySelector("#places-range");
    const yearLabel = root.querySelector("#places-year");
    range.min = String(minY); range.max = String(maxY);
    const saved = +localStorage.getItem("places-year::" + activeJournalId());
    range.value = String(saved >= minY && saved <= maxY ? saved : maxY);

    const activeAt = (p, y) => (p.startYear <= y && y <= p.endYear) || (p.startYear === lastStart && y >= p.startYear);
    const update = () => {
      const y = +range.value;
      yearLabel.textContent = y;
      localStorage.setItem("places-year::" + activeJournalId(), String(y));
      // Highlight places whose span contains the year (the latest place stays current to today);
      // draw the trail of places begun by then.
      places.forEach((p, i) => markers[i].setIcon(markerIcon(L, p, activeAt(p, y))));
      const upTo = places.filter((p) => p.startYear <= y);
      if (trail) { map.removeLayer(trail); trail = null; }
      if (upTo.length > 1) trail = L.polyline(upTo.map((p) => [p.lat, p.lng]), { color: "#c45c26", weight: 2, opacity: 0.7, dashArray: "4 6" }).addTo(map);
    };
    range.addEventListener("input", update);
    update();
    setTimeout(() => map && map.invalidateSize(), 0); // the container was hidden at creation
  }

  return {
    open: () => { render(); },
    close: () => {
      destroyed = true;
      if (document.fullscreenElement) document.exitFullscreen?.();
      if (fsCleanup) { fsCleanup(); fsCleanup = null; }
      if (map) { map.remove(); map = null; } markers = []; trail = null;
    },
  };
}
