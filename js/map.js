// Screen: the Leaflet map with stops, the selected stop with its routes and
// live vehicles, and the user's own position.

import { getVehicles, lineKey } from "./vehicles.js?v=9";

const REFRESH_MS = 10000;
const CENTER = [59.437, 24.7536]; // Tallinn old town

const STOP_RADIUS_M = 2000;  // stops: shown within this distance of the map centre
const HIDE_WIDTH_M = 25000;  // when the visible map is this wide or wider, hide stops and vehicles

// Colours for the lines of a selected stop (route shapes, their vehicles, the panel chips).
const LINE_COLORS = ["#e6194b", "#4363d8", "#f58231", "#3cb44b", "#911eb4", "#f032e6", "#008080", "#9a6324", "#800000", "#000075"];

let map;
let stopRenderer; // stops are painted on one canvas (much lighter than many HTML markers)

const vehicleMarkers = new Map(); // vehicle id -> marker
let lastVehicles = [];
let lastUpdate = "";

let allStops = [];
const stopDots = new Map(); // stop id -> circle marker
let onStopTap = () => {};

// The chosen stop:
// { stop, marker, lines: Set of line keys, colors: Map key->colour, routeLayer,
//   patterns: routes through it, lineFilter: one line key or null, routeStops: Map id->stop }
let selected = null;

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

  // Layers, bottom to top: routes → vehicles → stops → selected stop → popups.
  // The stops layer lets taps pass through (so buses under it stay tappable);
  // stop taps are found by position in onMapTap instead.
  const stopsPane = map.createPane("stopsPane");
  stopsPane.style.zIndex = 650;
  stopsPane.style.pointerEvents = "none";
  map.createPane("selectedPane").style.zIndex = 660;
  stopRenderer = L.canvas({ padding: 0.3, pane: "stopsPane" });

  map.on("moveend", render);
  map.on("click", onMapTap);
}

/** Call when the map becomes visible (it can't measure itself while hidden). */
export function showMap() {
  map.invalidateSize();
  if (selected) map.setView([selected.stop.lat, selected.stop.lon], Math.max(map.getZoom(), 15), { animate: false });
  refresh();
  clearInterval(timer);
  timer = setInterval(refresh, REFRESH_MS);
}

export function hideMap() {
  clearInterval(timer);
  timer = null;
}

/** Call after the map area changed size (e.g. the stop panel opened or closed). */
export function resizeMap() {
  map.invalidateSize({ pan: false });
  if (selected) map.panTo([selected.stop.lat, selected.stop.lon]);
}

/** The colour given to a line of the selected stop, or "" if none yet. */
export function lineColor(mode, line) {
  return selected?.colors.get(lineKey(mode, line)) || "";
}

// ---------- Drawing ----------

function tooWide() {
  const b = map.getBounds();
  const y = map.getCenter().lat;
  return map.distance([y, b.getWest()], [y, b.getEast()]) >= HIDE_WIDTH_M;
}

function render() {
  if (!map) return;
  const hide = tooWide();
  renderStops(hide);
  renderVehicles(hide);
  updateStatus(hide);
}

function updateStatus(hide) {
  if (hide) onStatus("Zoom in to see stops", false);
  else if (!selected) onStatus("Tap a stop to see its buses", false);
  else if (!lastUpdate) onStatus("Loading buses…", false);
  else {
    const what = selected.lineFilter ? "on this line" : "on this stop's lines";
    onStatus(`${vehicleMarkers.size} ${what} · updated ${lastUpdate}`, false);
  }
}

// ---------- Vehicles (only for the selected stop's lines) ----------

function vehicleIcon(v, color) {
  const arrow =
    v.heading === null
      ? ""
      : `<span class="v-arrow" style="transform: rotate(${v.heading}deg)"></span>`;
  return L.divIcon({
    className: "",
    html: `<div class="vehicle ${v.mode}"${color ? ` style="background:${color}"` : ""}>${arrow}<span class="v-label">${escapeHtml(v.line)}</span></div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

function popupText(v) {
  const kind = { BUS: "Bus", TROLLEYBUS: "Trolleybus", TRAM: "Tram" }[v.mode] || "Vehicle";
  return `<strong>${kind} ${escapeHtml(v.line)}</strong>` +
    (v.destination ? `<br>→ ${escapeHtml(v.destination)}` : "");
}

async function refresh() {
  if (document.hidden || !selected) return;
  try {
    lastVehicles = await getVehicles();
  } catch (err) {
    onStatus(`Couldn't load buses: ${err.message}`, true);
    return;
  }
  lastUpdate = new Date().toLocaleTimeString("et-EE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  render();
}

function renderVehicles(hide) {
  const visible =
    hide || !selected
      ? []
      : lastVehicles.filter((v) => {
          const key = lineKey(v.mode, v.line);
          return selected.lineFilter ? key === selected.lineFilter : selected.lines.has(key);
        });

  const keep = new Set();
  for (const v of visible) {
    keep.add(v.id);
    const color = selected.colors.get(lineKey(v.mode, v.line)) || "";
    // Only these require a new marker; heading and destination are updated in place.
    const base = `${v.mode}|${v.line}|${color}|${v.heading === null ? "no-arrow" : "arrow"}`;
    let m = vehicleMarkers.get(v.id);
    if (!m || m._base !== base) {
      if (m) m.remove();
      m = L.marker([v.lat, v.lon], { icon: vehicleIcon(v, color), zIndexOffset: 1000 }).addTo(map);
      m.bindPopup(popupText(v));
      m._base = base;
      m._heading = v.heading;
      m._dest = v.destination;
      vehicleMarkers.set(v.id, m);
      continue;
    }
    const pos = m.getLatLng();
    if (pos.lat !== v.lat || pos.lng !== v.lon) m.setLatLng([v.lat, v.lon]);
    if (m._heading !== v.heading) {
      const arrow = m.getElement()?.querySelector(".v-arrow");
      if (arrow) arrow.style.transform = `rotate(${v.heading}deg)`;
      m._heading = v.heading;
    }
    if (m._dest !== v.destination) {
      m.setPopupContent(popupText(v));
      m._dest = v.destination;
    }
  }
  for (const [id, m] of vehicleMarkers) {
    if (!keep.has(id)) {
      m.remove();
      vehicleMarkers.delete(id);
    }
  }
}

// ---------- Stops ----------

/** Give the map the full list of stops; it shows those within 2 km of the centre. */
export function setStops(stops, tapCallback) {
  allStops = stops;
  onStopTap = tapCallback;
  render();
}

function renderStops(hide) {
  const center = map.getCenter();
  const keep = new Set();
  // No stop chosen: all stops. Stop chosen: only stops along its routes (not the stop itself).
  const source = selected
    ? [...selected.routeStops.values()].filter((s) => s.gtfsId !== selected.stop.gtfsId)
    : allStops;
  if (!hide) {
    for (const s of source) {
      if (map.distance(center, [s.lat, s.lon]) > STOP_RADIUS_M) continue;
      keep.add(s.gtfsId);
      if (stopDots.has(s.gtfsId)) continue;
      const dot = L.circleMarker([s.lat, s.lon], {
        renderer: stopRenderer,
        pane: "stopsPane",
        interactive: false,
        radius: 6,
        color: "#ffffff",
        weight: 2,
        fillColor: "#3a3f47",
        fillOpacity: 1,
      }).addTo(map);
      dot._stop = s;
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

/** A tap on the map (not on a bus): open the nearest stop dot, if close enough. */
function onMapTap(e) {
  const p = e.containerPoint;
  let best = null;
  let bestDist = 22; // pixels
  for (const [id, dot] of stopDots) {
    const d = p.distanceTo(map.latLngToContainerPoint(dot.getLatLng()));
    if (d < bestDist) {
      bestDist = d;
      best = id;
    }
  }
  if (best) onStopTap(stopDots.get(best)._stop);
}

// ---------- Selected stop ----------

/** Choose a stop: mark it and show buses on its lines (routes: [{mode, shortName}]). */
export function setStop(stop, routes) {
  clearStop(false);
  const marker = L.marker([stop.lat, stop.lon], {
    icon: L.divIcon({ className: "", html: `<div class="stop-pin"></div>`, iconSize: [22, 22], iconAnchor: [11, 11] }),
    pane: "selectedPane",
    interactive: false,
  }).addTo(map);
  selected = {
    stop,
    marker,
    lines: new Set(routes.map((r) => lineKey(r.mode, r.shortName))),
    colors: new Map(),
    routeLayer: L.layerGroup().addTo(map),
    patterns: [],
    lineFilter: null,
    routeStops: new Map(),
  };
  map.panTo([stop.lat, stop.lon]);
  lastUpdate = "";
  render();
  refresh();
}

/**
 * Give the map the routes through the selected stop
 * (patterns: [{ line, mode, headsign, points, stops }]); one colour per line.
 */
export function showStopRoutes(patterns) {
  if (!selected) return;
  selected.patterns = patterns;
  selected.colors.clear();
  for (const p of patterns) {
    const key = lineKey(p.mode, p.line);
    if (!selected.colors.has(key)) {
      selected.colors.set(key, LINE_COLORS[selected.colors.size % LINE_COLORS.length]);
    }
  }
  drawSelection();
}

/** Show only one line (mode + line number), or all lines again with null. */
export function setLineFilter(mode, line) {
  if (!selected) return;
  selected.lineFilter = line == null ? null : lineKey(mode, line);
  drawSelection();
}

function drawSelection() {
  selected.routeLayer.clearLayers();
  selected.routeStops.clear();
  for (const p of selected.patterns) {
    const key = lineKey(p.mode, p.line);
    if (selected.lineFilter && key !== selected.lineFilter) continue;
    const color = selected.colors.get(key);
    // White outline underneath so lines stay visible over the map.
    L.polyline(p.points, { color: "#fff", weight: 8, opacity: 0.9, interactive: false }).addTo(selected.routeLayer);
    L.polyline(p.points, { color, weight: 4, opacity: 0.9 })
      .bindPopup(`<strong>Line ${escapeHtml(p.line)}</strong><br>→ ${escapeHtml(p.headsign)}`)
      .addTo(selected.routeLayer);
    for (const st of p.stops) selected.routeStops.set(st.gtfsId, st);
  }
  render();
}

export function clearStop(redraw = true) {
  if (selected) {
    selected.marker.remove();
    selected.routeLayer.remove();
  }
  selected = null;
  lastVehicles = [];
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
