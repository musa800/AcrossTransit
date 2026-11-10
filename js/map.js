// Screen: the Leaflet map, shared by two modes:
//  - "stops": stop dots, a chosen stop with its routes, route stops and live buses
//  - "plan":  stop dots for picking start/destination, a planned trip and its live buses

import { getVehicles, lineKey } from "./vehicles.js?v=15";

const REFRESH_MS = 10000;
const CENTER = [59.437, 24.7536]; // Tallinn old town

const STOP_RADIUS_M = 2000;  // stops: shown within this distance of the map centre (no stop chosen)
const HIDE_WIDTH_M = 25000;  // when the visible map is this wide or wider, hide stops and vehicles

// Colours for lines (route shapes, their vehicles, badges in the panels).
const LINE_COLORS = ["#e6194b", "#4363d8", "#f58231", "#3cb44b", "#911eb4", "#f032e6", "#008080", "#9a6324", "#800000", "#000075"];

let map;
let stopRenderer; // stops are painted on one canvas (much lighter than many HTML markers)
let mode = "stops";

const vehicleMarkers = new Map(); // vehicle id -> marker
let lastVehicles = [];
let lastUpdate = "";

// Stops are loaded on demand in small squares ("cells") around the map centre,
// only while the map is less than 25 km wide, and each cell only once.
const CELL_LAT = 0.02;  // ≈ 2.2 km
const CELL_LON = 0.04;  // ≈ 2.3 km at Estonian latitudes
const cells = new Map();     // "i:j" -> "loading" | "done"
const stopsById = new Map(); // every stop loaded so far
let stopLoader = null;       // async (box) => stops
const stopDots = new Map(); // stop id -> circle marker
let onStopTap = () => {};
let onPlanTap = () => {};

// The chosen stop (stops mode):
// { stop, marker, lines: Set of line keys, colors: Map key->colour, routeLayer,
//   patterns: routes through it, lineFilter: one line key or null, routeStops: Map id->stop }
let selected = null;

// The planner (plan mode).
const plan = {
  layer: null,          // trip drawing
  endpoints: null,      // A/B markers
  lines: new Set(),     // line keys of the chosen trip
  colors: new Map(),    // line key -> colour
  tripStops: [],        // in-between stops of the shown trip's rides
};

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

  // Layers, bottom to top: routes → vehicles → stops → selected stop/A-B → popups.
  // The stops layer lets taps pass through (so buses under it stay tappable);
  // stop taps are found by position in onMapTap instead.
  const stopsPane = map.createPane("stopsPane");
  stopsPane.style.zIndex = 650;
  stopsPane.style.pointerEvents = "none";
  map.createPane("selectedPane").style.zIndex = 660;
  stopRenderer = L.canvas({ padding: 0.3, pane: "stopsPane" });

  plan.layer = L.layerGroup();
  plan.endpoints = L.layerGroup();

  map.on("moveend", render);
  map.on("click", onMapTap);
}

/** Switch between "stops" and "plan". Each mode keeps its own state. */
export function setMode(newMode) {
  if (newMode === mode) return;
  mode = newMode;
  map.closePopup();
  if (mode === "plan") {
    if (selected) {
      selected.marker.remove();
      selected.routeLayer.remove();
    }
    plan.layer.addTo(map);
    plan.endpoints.addTo(map);
  } else {
    plan.layer.remove();
    plan.endpoints.remove();
    if (selected) {
      selected.marker.addTo(map);
      selected.routeLayer.addTo(map);
    }
  }
  lastUpdate = "";
  render();
}

/** Call when the map becomes visible (it can't measure itself while hidden). */
export function showMap() {
  map.invalidateSize();
  if (mode === "stops" && selected) {
    map.setView([selected.stop.lat, selected.stop.lon], Math.max(map.getZoom(), 15), { animate: false });
  }
  refresh();
  clearInterval(timer);
  timer = setInterval(refresh, REFRESH_MS);
}

export function hideMap() {
  clearInterval(timer);
  timer = null;
}

/** Call after the map area changed size (e.g. a bottom panel opened or closed). */
export function resizeMap() {
  map.invalidateSize({ pan: false });
  if (mode === "stops" && selected) map.panTo([selected.stop.lat, selected.stop.lon]);
}

/** The colour given to a line of the chosen stop, or "" if none. */
export function lineColor(lineMode, line) {
  return selected?.colors.get(lineKey(lineMode, line)) || "";
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
  const vf = vehicleFilter();
  if (mode === "plan") {
    if (!vf) onStatus("Tap the map or a stop to set start or destination", false);
    else if (hide) onStatus("Zoom in to see the trip's buses", false);
    else if (!lastUpdate) onStatus("Loading buses…", false);
    else onStatus(`${vehicleMarkers.size} buses of this trip's lines · updated ${lastUpdate}`, false);
    return;
  }
  if (hide) onStatus("Zoom in to see stops", false);
  else if (!selected) onStatus("Tap a stop to see its buses", false);
  else if (!lastUpdate) onStatus("Loading buses…", false);
  else {
    const what = selected.lineFilter ? "on this line" : "on this stop's lines";
    onStatus(`${vehicleMarkers.size} ${what} · updated ${lastUpdate}`, false);
  }
}

// ---------- Vehicles ----------

/** Which buses to show in the current mode: { shows(key), color(key) } or null for none. */
function vehicleFilter() {
  if (mode === "plan") {
    if (!plan.lines.size) return null;
    return { shows: (k) => plan.lines.has(k), color: (k) => plan.colors.get(k) || "" };
  }
  if (!selected) return null;
  return {
    shows: (k) => (selected.lineFilter ? k === selected.lineFilter : selected.lines.has(k)),
    color: (k) => selected.colors.get(k) || "",
  };
}

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
  if (document.hidden || !vehicleFilter()) return;
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
  const vf = vehicleFilter();
  const visible = hide || !vf ? [] : lastVehicles.filter((v) => vf.shows(lineKey(v.mode, v.line)));

  const keep = new Set();
  for (const v of visible) {
    keep.add(v.id);
    const color = vf.color(lineKey(v.mode, v.line));
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

/**
 * Tell the map how to load stops for an area (loader: async box => stops)
 * and what to do when a stop is tapped.
 */
export function setStopSource(loader, stopTapCallback) {
  stopLoader = loader;
  onStopTap = stopTapCallback;
  render();
}

/** The map centre as { lat, lon }. */
export function getCenter() {
  const c = map.getCenter();
  return { lat: c.lat, lon: c.lng };
}

/** Load any not-yet-loaded cells that touch the 2 km circle around the centre. */
function ensureCells(center) {
  if (!stopLoader) return;
  const dLat = STOP_RADIUS_M / 111320;
  const dLon = STOP_RADIUS_M / (111320 * Math.cos((center.lat * Math.PI) / 180));
  const i0 = Math.floor((center.lat - dLat) / CELL_LAT);
  const i1 = Math.floor((center.lat + dLat) / CELL_LAT);
  const j0 = Math.floor((center.lng - dLon) / CELL_LON);
  const j1 = Math.floor((center.lng + dLon) / CELL_LON);
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      const key = `${i}:${j}`;
      if (cells.has(key)) continue;
      cells.set(key, "loading");
      const box = {
        minLat: i * CELL_LAT,
        maxLat: (i + 1) * CELL_LAT,
        minLon: j * CELL_LON,
        maxLon: (j + 1) * CELL_LON,
      };
      stopLoader(box)
        .then((stops) => {
          for (const s of stops) stopsById.set(s.gtfsId, s);
          cells.set(key, "done");
          render();
        })
        .catch(() => cells.delete(key)); // try again next time the map moves here
    }
  }
}

/** What to do when the map (or a stop) is tapped in plan mode: cb(latlng, stopOrNull). */
export function setPlanTapHandler(cb) {
  onPlanTap = cb;
}

function renderStops(hide) {
  const center = map.getCenter();
  const keep = new Set();
  // Stop chosen (stops mode): every stop along its routes, small, no distance limit.
  // Otherwise: all stops within 2 km of the centre, normal size.
  // Small dots, no distance limit: a chosen stop's route stops, or a shown trip's stops.
  const tripView = mode === "plan" && plan.tripStops.length > 0;
  const routeView = (mode === "stops" && selected) || tripView;
  if (!hide && !routeView) ensureCells(center);
  const source = tripView
    ? plan.tripStops
    : routeView
      ? [...selected.routeStops.values()].filter((s) => s.gtfsId !== selected.stop.gtfsId)
      : stopsById.values();
  if (!hide) {
    for (const s of source) {
      if (!routeView && map.distance(center, [s.lat, s.lon]) > STOP_RADIUS_M) continue;
      keep.add(s.gtfsId);
      const existing = stopDots.get(s.gtfsId);
      if (existing && existing._small === !!routeView) continue;
      if (existing) existing.remove();
      const dot = L.circleMarker([s.lat, s.lon], {
        renderer: stopRenderer,
        pane: "stopsPane",
        interactive: false,
        radius: routeView ? 4 : 6,
        color: "#ffffff",
        weight: routeView ? 1.5 : 2,
        fillColor: "#3a3f47",
        fillOpacity: 1,
      }).addTo(map);
      dot._stop = s;
      dot._small = !!routeView;
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

/** A tap on the map (not on a bus or a line): find the nearest stop dot, if close enough. */
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
  const stop = best ? stopDots.get(best)._stop : null;
  // Stops of a shown trip are for looking at only.
  if (mode === "plan" && stop && plan.tripStops.length) return;
  if (mode === "plan") onPlanTap(stop ? L.latLng(stop.lat, stop.lon) : e.latlng, stop);
  else if (stop) onStopTap(stop);
}

/** Open a popup (DOM element) at a position. */
export function openPopupAt(latlng, el) {
  L.popup({ maxWidth: 240 }).setLatLng(latlng).setContent(el).openOn(map);
}

export function closeMapPopup() {
  map.closePopup();
}

// ---------- Selected stop (stops mode) ----------

/** Choose a stop: mark it and show buses on its lines (routes: [{mode, shortName}]). */
export function setStop(stop, routes) {
  clearStop(false);
  const marker = L.marker([stop.lat, stop.lon], {
    icon: L.divIcon({ className: "", html: `<div class="stop-pin"></div>`, iconSize: [22, 22], iconAnchor: [11, 11] }),
    pane: "selectedPane",
    interactive: false,
  });
  selected = {
    stop,
    marker,
    lines: new Set(routes.map((r) => lineKey(r.mode, r.shortName))),
    colors: new Map(),
    routeLayer: L.layerGroup(),
    patterns: [],
    lineFilter: null,
    routeStops: new Map(),
  };
  if (mode === "stops") {
    marker.addTo(map);
    selected.routeLayer.addTo(map);
    map.panTo([stop.lat, stop.lon]);
  }
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
export function setLineFilter(lineMode, line) {
  if (!selected) return;
  selected.lineFilter = line == null ? null : lineKey(lineMode, line);
  drawSelection();
}

function drawSelection() {
  selected.routeLayer.clearLayers();
  selected.routeStops.clear();
  for (const p of selected.patterns) {
    const key = lineKey(p.mode, p.line);
    if (selected.lineFilter && key !== selected.lineFilter) continue;
    drawLine(selected.routeLayer, p.points, selected.colors.get(key),
      `<strong>Line ${escapeHtml(p.line)}</strong><br>→ ${escapeHtml(p.headsign)}`);
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
  if (redraw) render();
}

// ---------- Planner (plan mode) ----------

function pin(letter, cls) {
  return L.divIcon({ className: "", html: `<div class="ab-pin ${cls}">${letter}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
}

/** Show the start (A) and destination (B) markers; either may be null. */
export function setPlanEndpoints(from, to) {
  plan.endpoints.clearLayers();
  if (from) L.marker([from.lat, from.lon], { icon: pin("A", "a"), pane: "selectedPane", interactive: false }).addTo(plan.endpoints);
  if (to) L.marker([to.lat, to.lon], { icon: pin("B", "b"), pane: "selectedPane", interactive: false }).addTo(plan.endpoints);
}

/** Move the map so both points are visible. */
export function fitPoints(points) {
  if (!points.length) return;
  if (points.length === 1) map.panTo(points[0]);
  else map.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 16 });
}

/**
 * Colours for the lines of a list of trip legs, without drawing anything.
 * Used for the badges in the results list.
 */
export function colorsForLegs(legs) {
  const colors = new Map();
  for (const l of legs) {
    if (!l.transit) continue;
    const key = lineKey(l.mode, l.line);
    if (!colors.has(key)) colors.set(key, LINE_COLORS[colors.size % LINE_COLORS.length]);
  }
  return colors;
}

/**
 * Draw a planned trip: legs [{ transit, mode, line, points, from, to }].
 * Walking is grey and dashed, rides in their line colour; dots mark where
 * you get on and off. Live buses of the trip's lines are shown too.
 */
export function showItinerary(legs) {
  plan.layer.clearLayers();
  plan.colors = colorsForLegs(legs);
  plan.lines = new Set(plan.colors.keys());
  const seen = new Set();
  plan.tripStops = [];
  for (const l of legs) {
    for (const st of l.passStops || []) {
      const id = st.gtfsId || `${st.lat},${st.lon}`;
      if (seen.has(id)) continue;
      seen.add(id);
      plan.tripStops.push({ ...st, gtfsId: id });
    }
  }
  const all = [];
  for (const l of legs) {
    all.push(...l.points);
    if (l.transit) {
      drawLine(plan.layer, l.points, plan.colors.get(lineKey(l.mode, l.line)), null);
    } else {
      L.polyline(l.points, { color: "#fff", weight: 7, opacity: 0.8, interactive: false }).addTo(plan.layer);
      L.polyline(l.points, { color: "#555", weight: 4, opacity: 0.9, dashArray: "2 8", lineCap: "round", interactive: false }).addTo(plan.layer);
    }
  }
  // Boarding and alighting points.
  for (const l of legs) {
    if (!l.transit) continue;
    for (const p of [l.from, l.to]) {
      L.circleMarker([p.lat, p.lon], {
        radius: 6, color: "#222", weight: 2, fillColor: "#fff", fillOpacity: 1, interactive: false,
      }).addTo(plan.layer);
    }
  }
  if (all.length) map.fitBounds(L.latLngBounds(all), { padding: [30, 30] });
  lastUpdate = "";
  render();
  refresh();
}

export function clearItinerary() {
  plan.layer.clearLayers();
  plan.tripStops = [];
  plan.lines = new Set();
  plan.colors = new Map();
  render();
}

// ---------- Shared helpers ----------

function drawLine(layer, points, color, popupHtml) {
  // White outline underneath so lines stay visible over the map.
  L.polyline(points, { color: "#fff", weight: 8, opacity: 0.9, interactive: false }).addTo(layer);
  const line = L.polyline(points, { color, weight: 4, opacity: 0.9, interactive: !!popupHtml });
  if (popupHtml) line.bindPopup(popupHtml);
  line.addTo(layer);
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
