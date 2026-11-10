// Service worker: makes the app installable and lets it open without internet.
//
// - App files (page, code, styles, icons, Leaflet): always fetched fresh when
//   online ("network first"), so updates arrive on the next open. The copy kept
//   here is only a backup for when there's no connection.
// - Live data (departures, buses, routes, trip plans, search) and map tiles are
//   never stored here: they always go straight to the internet.
//
// Keep VERSION equal to the ?v= number used in index.html and js/.

const VERSION = "19";
const CACHE = `acrosstransit-v${VERSION}`;
const LEAFLET = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/";

const APP_FILES = [
  "./",
  "index.html",
  `style.css?v=${VERSION}`,
  ...["app", "map", "plan", "routes", "peatus", "vehicles", "geocode", "net"].map((f) => `js/${f}.js?v=${VERSION}`),
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
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("acrosstransit-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isAppFile(url) {
  return (url.origin === self.location.origin) || url.href.startsWith(LEAFLET);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (!isAppFile(url)) return; // live data and map tiles: browser handles it normally

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
