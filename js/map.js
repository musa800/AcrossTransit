// Screen: the Leaflet map with live vehicles, stops, the selected stop and
// the user's own position.

import { getVehicles, lineKey } from "./vehicles.js?v=5";

const REFRESH_MS = 10000;
const CENTER = [59.437, 24.7536]; // Tallinn old town

// Limits that keep the map smooth on phones:
const RADIUS_M = 2000;       // vehicles and stops are shown within this distance of the map centre
const HIDE_WIDTH_M = 25000;  // when the visible map is this wide or wider, hide them all

let map;
let stopRenderer;            // stops are drawn on one canvas layer (much lighter than many HTML markers)
let radiusCircle = null;

const vehicleMarkers = new Map(); // vehicle id -> marker
let lastVehicles = [];            // latest feed, so panning can redraw without refetching
let lastUpdate = "";

let allStops = [];                // every stop in Tallinn
const stopDots = new Map();       // stop id -> circle marker
let onStopTap = () => {};

let selected = null;              // { stop, marker, lines: Set of line keys } or null

let meMarker = null;
let myPos = null;
let watchId = null;
let timer = null;
let onStatus = () => {};

export function initMap(el, statusCallback) {
  onStatus = statusCallback;
  map = L.map(el, { zoomControl: false }).setView(CENTER, 15);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap contributors",
  }).addTo(map);
  stopRenderer = L.canvas({ padding: 0.3 });
  map.on("moveend", render);
}

/** Call when the map becomes visible (it can't measure itself while hidden). */
export function showMap() {
  map.invalidateSize();
  refresh();
  clearInterval(timer);
  timer = setInterval(refresh, REFRESH_MS);
}

export function hideMap() {
  clearInterval(timer);
  timer = null;
}

// ---------- Which things are visible ----------

function visibleArea() {
  const b = map.getBounds();
  const y = map.getCenter().lat;
  const width = map.distance([y, b.getWest()], [y, b.getEast()]);
  return { center: map.getCenter(), tooWide: width >= HIDE_WIDTH_M };
}

function within(center, lat, lon) {
  return map.distance(center, [lat, lon]) <= RADIUS_M;
}

function render() {
  if (!map) return;
  const { center, tooWide } = visibleArea();
  drawRadius(center, tooWide);
  renderStops(center, tooWide);
  renderVehicles(center, tooWide);
}

function drawRadius(center, tooWide) {
  if (tooWide) {
    if (radiusCircle) radiusCircle.remove();
    radiusCircle = null;
    return;
  }
  if (!radiusCircle) {
    radiusCircle = L.circle(center, {
      radius: RADIUS_M,
      interactive: false,
      color: "#0b6bcb",
      weight: 1,
      opacity: 0.5,
      dashArray: "6 6",
      fill: false,
    }).addTo(map);
  } else {
    radiusCircle.setLatLng(center);
  }
}

// ---------- Vehicles ----------

function vehicleIcon(v) {
  const arrow =
    v.heading === null
      ? ""
      : `<span class="v-arrow" style="transform: rotate(${v.heading}deg)"></span>`;
  return L.divIcon({
    className: "",
    html: `<div class="vehicle ${v.mode}">${arrow}<span class="v-label">${escapeHtml(v.line)}</span></div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

function popupText(v) {
  const kind = { BUS: "Bus", TROLLEYBUS: "Trolleybus", TRAM: "Tram" }[v.mode] || "Vehicle";
  return `<strong>${kind} ${escapeHtml(v.line)}</strong>` +
    (v.destination ? `<br>→ ${escapeHtml(v.destination)}` : "");
}

async function refresh() {
  if (document.hidden) return;
  try {
    lastVehicles = await getVehicles();
  } catch (err) {
    onStatus(`Couldn't load live vehicles: ${err.message}`, true);
    return;
  }
  lastUpdate = new Date().toLocaleTimeString("et-EE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  render();
}

function renderVehicles(center, tooWide) {
  const visible = tooWide
    ? []
    : lastVehicles.filter(
        (v) =>
          (!selected || selected.lines.has(lineKey(v.mode, v.line))) &&
          within(center, v.lat, v.lon)
      );

  const keep = new Set();
  for (const v of visible) {
    keep.add(v.id);
    const sig = `${v.mode}|${v.line}|${v.heading}`;
    let m = vehicleMarkers.get(v.id);
    if (!m) {
      m = L.marker([v.lat, v.lon], { icon: vehicleIcon(v), zIndexOffset: 1000 }).addTo(map);
      m.bindPopup(popupText(v));
      m._sig = sig;
      vehicleMarkers.set(v.id, m);
    } else {
      m.setLatLng([v.lat, v.lon]);
      if (m._sig !== sig) {
        m.setIcon(vehicleIcon(v));
        m.setPopupContent(popupText(v));
        m._sig = sig;
      }
    }
  }
  for (const [id, m] of vehicleMarkers) {
    if (!keep.has(id)) {
      m.remove();
      vehicleMarkers.delete(id);
    }
  }

  if (!lastUpdate) return;
  let text;
  if (tooWide) text = "Zoom in to see vehicles and stops";
  else if (selected) text = `${visible.length} on this stop's lines within 2 km`;
  else text = `${visible.length} vehicles within 2 km`;
  onStatus(`${text} · updated ${lastUpdate}`, false);
}

// ---------- Stops ----------

/** Give the map the full list of stops; it shows those within the radius. */
export function setStops(stops, tapCallback) {
  allStops = stops;
  onStopTap = tapCallback;
  render();
}

function renderStops(center, tooWide) {
  const keep = new Set();
  if (!tooWide) {
    for (const s of allStops) {
      if (!within(center, s.lat, s.lon)) continue;
      keep.add(s.gtfsId);
      if (stopDots.has(s.gtfsId)) continue;
      const dot = L.circleMarker([s.lat, s.lon], {
        renderer: stopRenderer,
        radius: 6,
        color: "#ffffff",
        weight: 2,
        fillColor: "#3a3f47",
        fillOpacity: 1,
      }).addTo(map);
      dot.on("click", () => onStopTap(s));
      stopDots.set(s.gtfsId, dot);
    }
  }
  for (const [id, dot] of stopDots) {
    if (!keep.has(id)) {
      dot.remove();
      stopDots.delete(id);
    }
  }
}

// ---------- Selected stop ----------

/**
 * Select a stop: mark it, and show only vehicles on its lines
 * (routes: [{mode, shortName}]). recenter: move the map to it.
 */
export function setStop(stop, routes, recenter = true) {
  clearStop(false);
  const marker = L.marker([stop.lat, stop.lon], {
    icon: L.divIcon({ className: "", html: `<div class="stop-pin"></div>`, iconSize: [22, 22], iconAnchor: [11, 11] }),
    zIndexOffset: 2000,
  }).addTo(map);
  marker.on("click", () => onStopTap(stop));
  selected = { stop, marker, lines: new Set(routes.map((r) => lineKey(r.mode, r.shortName))) };
  if (recenter) map.setView([stop.lat, stop.lon], Math.max(map.getZoom(), 15));
  else render();
}

/** Show a popup (a DOM element) on the selected stop. */
export function showStopPopup(content) {
  if (!selected) return;
  selected.marker.unbindPopup();
  selected.marker.bindPopup(content, { maxWidth: 260 }).openPopup();
}

export function clearStop(redraw = true) {
  if (selected) selected.marker.remove();
  selected = null;
  if (redraw) render();
}

// ---------- My position ----------

export function centreOnMe(onError) {
  if (!navigator.geolocation) {
    onError("This browser can't share your location.");
    return;
  }
  if (myPos) map.setView(myPos, Math.max(map.getZoom(), 16));
  if (watchId !== null) return;
  let first = !myPos;
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      myPos = [pos.coords.latitude, pos.coords.longitude];
      if (!meMarker) {
        meMarker = L.marker(myPos, {
          icon: L.divIcon({ className: "", html: `<div class="me"></div>`, iconSize: [20, 20], iconAnchor: [10, 10] }),
          zIndexOffset: 3000,
          interactive: false,
        }).addTo(map);
      } else {
        meMarker.setLatLng(myPos);
      }
      if (first) {
        map.setView(myPos, 16);
        first = false;
      }
    },
    (err) => {
      onError(err.code === 1 ? "Location permission was denied." : "Couldn't get your location.");
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    },
    { enableHighAccuracy: true, maximumAge: 10000 }
  );
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
