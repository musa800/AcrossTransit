// Screen: the Leaflet map with live vehicles, stops, the selected stop and
// the user's own position.

import { getVehicles, lineKey } from "./vehicles.js?v=7";

const REFRESH_MS = 10000;
const CENTER = [59.437, 24.7536]; // Tallinn old town

// Limits that keep the map smooth on phones:
const VEHICLE_RADIUS_M = 1000; // vehicles: within this distance of the map centre (can be toggled off)
const STOP_RADIUS_M = 2000;    // stops: always within this distance of the map centre
const HIDE_WIDTH_M = 25000;    // when the visible map is this wide or wider, hide vehicles and stops

// Colours for the lines of a selected stop (route shapes and their vehicles).
const LINE_COLORS = ["#e6194b", "#4363d8", "#f58231", "#3cb44b", "#911eb4", "#f032e6", "#008080", "#9a6324", "#800000", "#000075"];

let map;
let stopRenderer;            // stops are drawn on one canvas layer (much lighter than many HTML markers)
let radiusCircle = null;
let vehicleRadiusOn = true;

const vehicleMarkers = new Map(); // vehicle id -> marker
let lastVehicles = [];            // latest feed, so panning can redraw without refetching
let lastUpdate = "";

let allStops = [];                // every stop in Tallinn
const stopDots = new Map();       // stop id -> circle marker
let onStopTap = () => {};

let selected = null;              // { stop, marker, lines: Set of line keys, colors: Map key->colour, routeLayer } or null

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
  if (best) {
    const stop = allStops.find((s) => s.gtfsId === best);
    if (stop) onStopTap(stop);
  }
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

function within(center, lat, lon, radius) {
  return map.distance(center, [lat, lon]) <= radius;
}

/** Turn the 1 km vehicle radius on or off. Returns the new state. */
export function toggleVehicleRadius() {
  vehicleRadiusOn = !vehicleRadiusOn;
  render();
  return vehicleRadiusOn;
}

function render() {
  if (!map) return;
  const { center, tooWide } = visibleArea();
  drawRadius(center, tooWide);
  renderStops(center, tooWide);
  renderVehicles(center, tooWide);
}

function drawRadius(center, tooWide) {
  if (tooWide || !vehicleRadiusOn) {
    if (radiusCircle) radiusCircle.remove();
    radiusCircle = null;
    return;
  }
  if (!radiusCircle) {
    radiusCircle = L.circle(center, {
      radius: VEHICLE_RADIUS_M,
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

function vehicleIcon(v, color) {
  const arrow =
    v.heading === null
      ? ""
      : `<span class="v-arrow" style="transform: rotate(${v.heading}deg)"></span>`;
  return L.divIcon({
    className: "",
    html: `<div class="vehicle ${v.mode}"${color ? ` style="background:${color}"` : ""}>${arrow}<span class="v-label">${escapeHtml(v.line)}</span></div>`,
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
          (!vehicleRadiusOn || within(center, v.lat, v.lon, VEHICLE_RADIUS_M))
      );

  const keep = new Set();
  for (const v of visible) {
    keep.add(v.id);
    const color = selected?.colors.get(lineKey(v.mode, v.line)) || "";
    // Only these require building a new marker; heading and destination are updated in place.
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

  if (!lastUpdate) return;
  let text;
  if (tooWide) text = "Zoom in to see vehicles and stops";
  else {
    const area = vehicleRadiusOn ? "within 1 km" : "in Tallinn";
    text = selected
      ? `${visible.length} on this stop's lines ${area}`
      : `${visible.length} vehicles ${area}`;
  }
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
      if (!within(center, s.lat, s.lon, STOP_RADIUS_M)) continue;
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
    pane: "selectedPane",
  }).addTo(map);
  marker.on("click", () => onStopTap(stop));
  selected = {
    stop,
    marker,
    lines: new Set(routes.map((r) => lineKey(r.mode, r.shortName))),
    colors: new Map(),
    routeLayer: L.layerGroup().addTo(map),
  };
  if (recenter) map.setView([stop.lat, stop.lon], Math.max(map.getZoom(), 15));
  else render();
}

/** Show a popup (a DOM element) on the selected stop. */
export function showStopPopup(content) {
  if (!selected) return;
  selected.marker.unbindPopup();
  selected.marker.bindPopup(content, { maxWidth: 260 }).openPopup();
}

/**
 * Draw the routes through the selected stop
 * (patterns: [{ line, mode, headsign, points }]), one colour per line.
 */
export function showStopRoutes(patterns) {
  if (!selected) return;
  selected.routeLayer.clearLayers();
  selected.colors.clear();
  for (const p of patterns) {
    const key = lineKey(p.mode, p.line);
    if (!selected.colors.has(key)) {
      selected.colors.set(key, LINE_COLORS[selected.colors.size % LINE_COLORS.length]);
    }
    const color = selected.colors.get(key);
    // White outline underneath so lines stay visible over the map.
    L.polyline(p.points, { color: "#fff", weight: 8, opacity: 0.9, interactive: false }).addTo(selected.routeLayer);
    L.polyline(p.points, { color, weight: 4, opacity: 0.9 })
      .bindPopup(`<strong>Line ${escapeHtml(p.line)}</strong><br>→ ${escapeHtml(p.headsign)}`)
      .addTo(selected.routeLayer);
  }
  render();
}

export function clearStop(redraw = true) {
  if (selected) {
    selected.marker.remove();
    selected.routeLayer.remove();
  }
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
