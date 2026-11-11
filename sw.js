// Service worker: makes the app installable and lets it open without internet.
//
// - App files (page, code, styles, icons, Leaflet): always fetched fresh when
//   online ("network first"), so updates arrive on the next open. The copy kept
//   here is only a backup for when there's no connection.
// - Live data (departures, buses, routes, trip plans, search) is never stored
//   here: it always goes straight to the internet.
// - Map squares (tiles) you've viewed are kept (about 30 MB, oldest dropped
//   first), so the map still shows those areas without internet.
//
// Keep VERSION equal to the ?v= number used in index.html and js/.

const VERSION = "44";
const CACHE = `acrosstransit-v${VERSION}`;
const LEAFLET = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/";
const TILES = "acrosstransit-tiles-v1";
const MAX_TILES = 1500; // ≈ 30 MB

const APP_FILES = [
  "./",
  "index.html",
  `style.css?v=${VERSION}`,
  ...["app", "map", "plan", "routes", "connect", "offline", "colors", "peatus", "vehicles", "geocode", "net"].map((f) => `js/${f}.js?v=${VERSION}`),
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/favicon-32.png",
  `${LEAFLET}leaflet.min.css`,
  `${LEAFLET}leaflet.min.js`,
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(APP_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      // Only old app-file copies; the offline timetable and map squares are kept.
      .then((keys) => Promise.all(keys.filter((k) => /^acrosstransit-v\d+$/.test(k) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isAppFile(url) {
  // data/ (timetables, walking maps) is kept by the offline planner itself.
  if (url.origin === self.location.origin && url.pathname.includes("/data/")) return false;
  return (url.origin === self.location.origin) || url.href.startsWith(LEAFLET);
}

let tilePuts = 0;
const keptTiles = new Set(); // squares known to be kept (since the worker started)

async function trimTiles(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await cache.delete(keys[i]); // oldest first
}

/** Keep a map square, in the background (skipped if it's already kept). */
async function keepTile(req, res) {
  if (keptTiles.has(req.url)) return;
  const cache = await caches.open(TILES);
  if (!(await cache.match(req))) {
    await cache.put(req, res);
    if (++tilePuts % 400 === 0) await trimTiles(cache);
  }
  keptTiles.add(req.url);
}

/**
 * Map squares: straight from the internet when possible (handed to the map
 * at once, kept afterwards), else the kept copy.
 */
async function tile(event) {
  const req = event.request;
  try {
    const res = await fetch(req);
    if (res.ok && res.type !== "opaque") event.waitUntil(keepTile(req, res.clone()).catch(() => {}));
    return res;
  } catch {
    const cache = await caches.open(TILES);
    return (await cache.match(req)) || Response.error();
  }
}

// The app pings while it's open, so the phone doesn't put this worker to
// sleep (waking it up delayed the first map squares of a drag).
self.addEventListener("message", () => {});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname.endsWith("tile.openstreetmap.org")) {
    event.respondWith(tile(event));
    return;
  }
  if (!isAppFile(url)) return; // live data: browser handles it normally

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        // Opening the app offline: fall back to the stored page.
        if (req.mode === "navigate") return caches.match("index.html");
        return Response.error();
      })
  );
});
