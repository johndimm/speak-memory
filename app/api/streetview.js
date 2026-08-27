// Google Street View Static API proxy. Keeps the API key server-side (never in the browser).
//
//   GET /api/streetview?meta=1&lat=..&lng=..   → { ok: bool }   (free metadata check — is there
//                                                                 imagery at this spot?)
//   GET /api/streetview?lat=..&lng=..&size=WxH → the JPEG image  (or 404 when none / no key)
//
// The key is read from GOOGLE_PLACES_API_KEY (or GOOGLE_MAPS_API_KEY). It must be a Google Maps
// Platform key with the **Street View Static API** enabled and not restricted away from it.

const KEY = () => process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY || "";

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

export default async function handler(req, res) {
  const q = req.query || {};
  const lat = num(q.lat), lng = num(q.lng);
  const key = KEY();
  if (lat == null || lng == null) { res.status(400).json({ error: "lat and lng required" }); return; }
  if (!key) { res.status(404).json({ error: "no key" }); return; } // graceful: client falls back to a pin
  const loc = `${lat},${lng}`;

  // Metadata check (free, no image quota) — also used to decide whether to show a photo at all.
  let metaOk = false, metaStatus = "";
  try {
    const m = await fetch(`https://maps.googleapis.com/maps/api/streetview/metadata?location=${encodeURIComponent(loc)}&key=${key}`);
    const j = await m.json();
    metaStatus = j.status || "";
    metaOk = j.status === "OK";
  } catch { /* treat as no imagery */ }

  if (q.meta) {
    // Surface auth/enable problems so we can diagnose the key; otherwise just ok/not.
    if (metaStatus === "REQUEST_DENIED" || metaStatus === "OVER_QUERY_LIMIT") {
      res.status(200).json({ ok: false, status: metaStatus, hint: "Enable the Street View Static API for this key/project and don't restrict the key away from it." });
    } else {
      res.status(200).json({ ok: metaOk, status: metaStatus });
    }
    return;
  }

  if (!metaOk) { res.status(404).json({ error: "no imagery", status: metaStatus }); return; }

  // Fetch and stream the image, key kept server-side.
  const size = /^\d{2,4}x\d{2,4}$/.test(String(q.size || "")) ? q.size : "400x300";
  const fov = q.fov || "80";
  const url = `https://maps.googleapis.com/maps/api/streetview?size=${size}&location=${encodeURIComponent(loc)}&fov=${fov}&return_error_code=true&key=${key}`;
  try {
    const img = await fetch(url);
    if (!img.ok) { res.status(404).json({ error: "no image", status: img.status }); return; }
    const buf = Buffer.from(await img.arrayBuffer());
    res.setHeader("Content-Type", img.headers.get("content-type") || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=604800, immutable"); // a location's view is stable
    res.status(200).send(buf);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
