// Screen: the Leaflet map, shared by two modes:
//  - "stops": stop dots, a chosen stop with its routes, route stops and live buses
//  - "plan":  stop dots for picking start/destination, a planned trip and its live buses

import { getVehicles, lineKey } from "./vehicles.js?v=36";

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
const cellTime = new Map();  // "i:j" -> when it was loaded (ms), for the 7-day memory
const stopsById = new Map(); // every stop loaded so far
// The same stops in small squares (~550 m), so only nearby ones are checked.
const GRID_LAT = 0.005, GRID_LON = 0.01;
const stopGrid = new Map(); // "i:j" -> Map gtfsId -> stop

function gridAdd(st) {
  const key = `${Math.floor(st.lat / GRID_LAT)}:${Math.floor(st.lon / GRID_LON)}`;
  let cellMap = stopGrid.get(key);
  if (!cellMap) stopGrid.set(key, (cellMap = new Map()));
  cellMap.set(st.gtfsId, st);
}

function putStop(st) {
  stopsById.set(st.gtfsId, st);
  gridAdd(st);
}

/** Stops within radius (m) of a point: only the grid squares around it are looked at. */
function stopsNear(lat, lon, radius) {
  const kx = 111320 * Math.cos((lat * Math.PI) / 180); // metres per degree of longitude here
  const ky = 110574;                                    // metres per degree of latitude
  const di = Math.ceil(radius / ky / GRID_LAT);
  const dj = Math.ceil(radius / kx / GRID_LON);
  const ci = Math.floor(lat / GRID_LAT), cj = Math.floor(lon / GRID_LON);
  const r2 = radius * radius;
  const out = [];
  for (let i = ci - di; i <= ci + di; i++) {
    for (let j = cj - dj; j <= cj + dj; j++) {
      const cellMap = stopGrid.get(`${i}:${j}`);
      if (!cellMap) continue;
      for (const st of cellMap.values()) {
        // Flat-map distance: accurate to centimetres at these distances, and fast.
        const dx = (st.lon - lon) * kx, dy = (st.lat - lat) * ky;
        if (dx * dx + dy * dy <= r2) out.push(st);
      }
    }
  }
  return out;
}
let stopLoader = null;       // async (box) => stops
let pendingPreload = null;   // { lat, lon } waiting for setStopSource

// Stops rarely change, so loaded squares are remembered on the phone for
// 7 days: reopening the app shows them without any request.
const STORE_KEY = "acrosstransit.stops.v1";
const STORE_MS = 7 * 24 * 3600 * 1000;
const STORE_MAX_CHARS = 3_500_000; // stay well inside the browser's storage limit

function cellOf(lat, lon) {
  return `${Math.floor(lat / CELL_LAT)}:${Math.floor(lon / CELL_LON)}`;
}

function loadStore() {
  let data;
  try {
    data = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
  } catch {
    return;
  }
  if (!data || !data.cells || !data.stops) return;
  const now = Date.now();
  for (const [key, t] of Object.entries(data.cells)) {
    if (now - t < STORE_MS && !cells.has(key)) {
      cells.set(key, "done");
      cellTime.set(key, t);
    }
  }
  for (const [gtfsId, name, code, desc, lat, lon] of data.stops) {
    if (cellTime.has(cellOf(lat, lon))) putStop({ gtfsId, name, code, desc, lat, lon });
  }
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveStore, 2000);
}

function saveStore() {
  // Newest squares first; drop the oldest if it gets too big.
  const keys = [...cellTime.keys()].sort((a, b) => cellTime.get(b) - cellTime.get(a));
  const byCell = new Map();
  for (const st of stopsById.values()) {
    const k = cellOf(st.lat, st.lon);
    if (!cellTime.has(k)) continue;
    if (!byCell.has(k)) byCell.set(k, []);
    byCell.get(k).push([st.gtfsId, st.name, st.code || "", st.desc || "", st.lat, st.lon]);
  }
  while (keys.length) {
    const data = { cells: {}, stops: [] };
    for (const k of keys) {
      data.cells[k] = cellTime.get(k);
      for (const row of byCell.get(k) || []) data.stops.push(row);
    }
    const json = JSON.stringify(data);
    if (json.length <= STORE_MAX_CHARS) {
      try {
        localStorage.setItem(STORE_KEY, json);
      } catch {
        /* storage full or unavailable: memory just isn't kept */
      }
      return;
    }
    keys.splice(Math.ceil(keys.length * 0.8)); // drop the oldest 20% and try again
  }
}

function addStops(stops) {
  for (const s of stops) putStop(s);
}

/** Load all stops within ~5 km of a point in one request (squares already known are skipped). */
function preloadAround(lat, lon, radiusM = 5000) {
  if (!stopLoader) {
    pendingPreload = { lat, lon };
    return;
  }
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
  const i0 = Math.floor((lat - dLat) / CELL_LAT);
  const i1 = Math.floor((lat + dLat) / CELL_LAT);
  const j0 = Math.floor((lon - dLon) / CELL_LON);
  const j1 = Math.floor((lon + dLon) / CELL_LON);
  const missing = [];
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      const key = `${i}:${j}`;
      if (!cells.has(key)) missing.push(key);
    }
  }
  if (!missing.length) return;
  for (const k of missing) cells.set(k, "loading");
  const box = {
    minLat: i0 * CELL_LAT,
    maxLat: (i1 + 1) * CELL_LAT,
    minLon: j0 * CELL_LON,
    maxLon: (j1 + 1) * CELL_LON,
  };
  stopLoader(box)
    .then((stops) => {
      addStops(stops);
      const t = Date.now();
      for (const k of missing) {
        cells.set(k, "done");
        cellTime.set(k, t);
      }
      render();
      scheduleSave();
    })
    .catch(() => {
      for (const k of missing) if (cells.get(k) === "loading") cells.delete(k);
    });
}
const stopDots = new Map(); // stop id -> circle marker
let onStopTap = () => {};
let onPlanTap = () => {};

// The chosen stop (stops mode):
// { stop, marker, lines: Set of line keys, colors: Map key->colour, routeLayer,
//   patterns: routes through it, lineFilter: one line key or null, routeStops: Map id->stop }
let selected = null;

// A whole route opened from the Routes tab (stops mode, when no stop is chosen):
// { key, color, layer, stops }
let routeView = null;

// Routes through the stops near you (stops mode, from the Near me panel):
// { layer, patterns, colors: Map key->colour, filter: line key or null, routeStops }
let nearView = null;
let nearRenderer = null; // canvas: many neutral lines stay light to draw
const NEUTRAL = "#7a8190";

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
  // Extra margin: the canvas only fully redraws when a drag ends, so draw
  // further beyond the screen edge to cover dots revealed while dragging.
  stopRenderer = L.canvas({ padding: 0.6, pane: "stopsPane" });

  plan.layer = L.layerGroup();
  plan.endpoints = L.layerGroup();

  map.on("moveend", render);
  map.on("move", onMoving);
  map.on("click", onMapTap);
  // Leaflet closes an open popup just before the tap reaches onMapTap;
  // remember when, so that tap only closes the popup.
  map.on("popupclose", () => (lastPopupClose = Date.now()));
}

let lastPopupClose = 0;

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
    if (routeView) routeView.layer.remove();
    if (nearView) nearView.layer.remove();
    plan.layer.addTo(map);
    plan.endpoints.addTo(map);
  } else {
    plan.layer.remove();
    plan.endpoints.remove();
    if (selected) {
      selected.marker.addTo(map);
      selected.routeLayer.addTo(map);
    }
    if (routeView) routeView.layer.addTo(map);
    if (nearView) nearView.layer.addTo(map);
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
  const key = lineKey(lineMode, line);
  if (selected) return selected.colors.get(key) || "";
  if (nearView && nearView.filter === key) return nearView.colors.get(key) || "";
  return "";
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
  else if (!selected && nearView) {
    if (!nearView.filter) onStatus("Tap a line in the panel to see its buses", false);
    else onStatus(lastUpdate ? `${vehicleMarkers.size} on this line · updated ${lastUpdate}` : "Loading buses…", false);
  }
  else if (!selected && routeView) {
    onStatus(lastUpdate ? `${vehicleMarkers.size} on this route · updated ${lastUpdate}` : "Loading buses…", false);
  }
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
  if (!selected && routeView) {
    return { shows: (k) => k === routeView.key, color: () => routeView.color };
  }
  if (!selected && nearView) {
    if (!nearView.filter) return null; // buses only once a line is chosen
    return { shows: (k) => k === nearView.filter, color: (k) => nearView.colors.get(k) || "" };
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
  loadStore();
  const c = pendingPreload || getCenter();
  pendingPreload = null;
  preloadAround(c.lat, c.lon);
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
          addStops(stops);
          cells.set(key, "done");
          cellTime.set(key, Date.now());
          render();
          scheduleSave();
        })
        .catch(() => cells.delete(key)); // try again next time the map moves here
    }
  }
}

/** What to do when the map (or a stop) is tapped in plan mode: cb(latlng, stopOrNull). */
export function setPlanTapHandler(cb) {
  onPlanTap = cb;
}

// While the map is being dragged: update stop dots on every screen refresh
// (the browser skips frames by itself if the phone is busy), and load new
// squares of stops at most every 150 ms. Buses and lines wait until the drag
// ends (moveend → render).
const MOVE_LOAD_MS = 150;
let lastMoveLoad = 0;
let framePending = false;

let lastDrawCenter = null;
const MOVE_MIN_M = 20; // don't update the dots for smaller moves than this

function onMoving() {
  if (framePending) return;
  framePending = true;
  requestAnimationFrame(() => {
    framePending = false;
    const c = map.getCenter();
    if (lastDrawCenter) {
      const kx = 111320 * Math.cos((c.lat * Math.PI) / 180);
      const dx = (c.lng - lastDrawCenter.lng) * kx, dy = (c.lat - lastDrawCenter.lat) * 110574;
      if (dx * dx + dy * dy < MOVE_MIN_M * MOVE_MIN_M) return;
    }
    lastDrawCenter = c;
    const now = performance.now();
    const load = now - lastMoveLoad >= MOVE_LOAD_MS;
    if (load) lastMoveLoad = now;
    renderStops(tooWide(), { moving: true, load });
  });
}

function renderStops(hide, { moving = false, load = true } = {}) {
  const center = map.getCenter();
  const keep = new Set();
  // Which stop dots to show:
  //  - trip shown (plan): the trip's stops, small
  //  - route from the Routes tab: its stops, small
  //  - stop chosen: none, until a line is chosen; then that line's stops, small
  //  - Near me: only the stops within 200 m (normal size), until a line is
  //    chosen; then that line's stops, small
  //  - otherwise: all stops within 2 km of the centre, normal size
  const tripView = mode === "plan" && plan.tripStops.length > 0;
  const stopsMode = mode === "stops";
  const wholeRoute = stopsMode && !selected && routeView;
  const nearLine = stopsMode && !selected && !routeView && nearView && nearView.filter;
  const nearCircle = stopsMode && !selected && !routeView && nearView && !nearView.filter;
  const stopLine = stopsMode && selected && selected.lineFilter;
  const stopOnly = stopsMode && selected && !selected.lineFilter;
  const small = tripView || wholeRoute || nearLine || stopLine;
  const limited = small || nearCircle || stopOnly; // no 2 km rule, no loading
  // A fixed set of stops is shown (chosen stop, route, trip, Near me): nothing to update while dragging.
  if (moving && limited) return;
  if (!hide && !limited && load) ensureCells(center);
  const source = tripView
    ? plan.tripStops
    : wholeRoute
      ? routeView.stops
      : nearLine
        ? [...nearView.routeStops.values()]
        : nearCircle
          ? nearView.circleStops
          : stopLine
            ? [...selected.routeStops.values()].filter((s) => s.gtfsId !== selected.stop.gtfsId)
            : stopOnly
              ? []
              : stopsNear(center.lat, center.lng, STOP_RADIUS_M); // already within 2 km
  if (!moving) lastDrawCenter = center;
  if (!hide) {
    for (const s of source) {
      keep.add(s.gtfsId);
      const existing = stopDots.get(s.gtfsId);
      if (existing && existing._small === !!small) continue;
      if (existing) existing.remove();
      const dot = L.circleMarker([s.lat, s.lon], {
        renderer: stopRenderer,
        pane: "stopsPane",
        interactive: false,
        radius: small ? 4 : 6,
        color: "#ffffff",
        weight: small ? 1.5 : 2,
        fillColor: "#3a3f47",
        fillOpacity: 1,
      }).addTo(map);
      dot._stop = s;
      dot._small = !!small;
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
  if (Date.now() - lastPopupClose < 400) return; // this tap closed a popup
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
  clearRoute(false);
  clearNearRoutes(false);
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

// ---------- A whole route (from the Routes tab) ----------

/**
 * Show one direction of a route: its shape, its stops and its live buses.
 * route: { mode, line }, direction: { points, stops }.
 */
export function showRoute(route, direction) {
  clearStop(false);
  clearRoute(false);
  clearNearRoutes(false);
  routeView = {
    key: lineKey(route.mode, route.line),
    color: LINE_COLORS[0],
    layer: L.layerGroup(),
    stops: direction.stops,
  };
  drawLine(routeView.layer, direction.points, routeView.color, null);
  if (mode === "stops") routeView.layer.addTo(map);
  const pts = direction.points.length ? direction.points : direction.stops.map((s) => [s.lat, s.lon]);
  if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [30, 30] });
  lastUpdate = "";
  render();
  refresh();
}

export function clearRoute(redraw = true) {
  if (routeView) routeView.layer.remove();
  routeView = null;
  if (redraw) render();
}

export function hasRoute() {
  return !!routeView;
}

// ---------- Routes near you (from the Near me panel) ----------

/** Start the Near me view: only the stops within 200 m are shown. */
export function setNearStops(stops) {
  clearStop(false);
  clearRoute(false);
  clearNearRoutes(false);
  if (!nearRenderer) nearRenderer = L.canvas({ padding: 0.3 });
  nearView = {
    layer: L.layerGroup(),
    patterns: [],
    colors: new Map(),
    filter: null,
    routeStops: new Map(),
    circleStops: stops,
  };
  if (mode === "stops") nearView.layer.addTo(map);
  render();
}

/** Draw all routes through the nearby stops in one neutral colour. */
export function showNearRoutes(patterns) {
  if (!nearView) return;
  nearView.patterns = patterns;
  nearView.colors.clear();
  for (const p of patterns) {
    const key = lineKey(p.mode, p.line);
    if (!nearView.colors.has(key)) {
      nearView.colors.set(key, LINE_COLORS[nearView.colors.size % LINE_COLORS.length]);
    }
  }
  drawNear();
}

/** Show one line (mode + line number) in colour with its stops and buses, or all neutral with null. */
export function setNearFilter(lineMode, line) {
  if (!nearView) return;
  nearView.filter = line == null ? null : lineKey(lineMode, line);
  lastUpdate = "";
  drawNear();
  refresh();
}

function drawNear() {
  nearView.layer.clearLayers();
  nearView.routeStops.clear();
  for (const p of nearView.patterns) {
    const key = lineKey(p.mode, p.line);
    if (nearView.filter && key !== nearView.filter) continue;
    if (nearView.filter) {
      drawLine(nearView.layer, p.points, nearView.colors.get(key),
        `<strong>Line ${escapeHtml(p.line)}</strong><br>→ ${escapeHtml(p.headsign)}`);
      for (const st of p.stops) nearView.routeStops.set(st.gtfsId, st);
    } else {
      L.polyline(p.points, { renderer: nearRenderer, color: NEUTRAL, weight: 3, opacity: 0.6, interactive: false })
        .addTo(nearView.layer);
    }
  }
  render();
}

export function clearNearRoutes(redraw = true) {
  if (nearView) nearView.layer.remove();
  nearView = null;
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
//
// While the app is open (and visible), the position is watched continuously.
// The map is centred on you once, on the first fix after opening, unless you
// have already dragged the map. Blue pulsing dot = live; grey dot = last known
// position (no update for a minute, or location unavailable); no dot if the
// position has never been known. The last position is remembered on this
// device so the grey dot can show straight away next time.

const LAST_POS_KEY = "acrosstransit.lastPos";
const STALE_MS = 60000;

let lastFixAt = 0;
let centredOnce = false;
let userDragged = false;
let locationError = "";

function loadLastPos() {
  try {
    const p = JSON.parse(localStorage.getItem(LAST_POS_KEY) || "null");
    return p && typeof p.lat === "number" ? [p.lat, p.lon] : null;
  } catch {
    return null;
  }
}

let lastSaved = 0;
function saveLastPos(pos) {
  if (Date.now() - lastSaved < 30000) return;
  lastSaved = Date.now();
  try {
    localStorage.setItem(LAST_POS_KEY, JSON.stringify({ lat: pos[0], lon: pos[1] }));
  } catch {
    /* not critical */
  }
}

function isLive() {
  return !!myPos && Date.now() - lastFixAt < STALE_MS;
}

function drawMe() {
  if (!myPos) {
    if (meMarker) meMarker.remove();
    meMarker = null;
    return;
  }
  const cls = isLive() ? "me" : "me grey";
  if (!meMarker) {
    meMarker = L.marker(myPos, {
      icon: L.divIcon({ className: "", html: `<div class="${cls}"></div>`, iconSize: [20, 20], iconAnchor: [10, 10] }),
      zIndexOffset: 3000,
      interactive: false,
    }).addTo(map);
  } else {
    meMarker.setLatLng(myPos);
    const el = meMarker.getElement()?.firstChild;
    if (el) el.className = cls;
  }
}

function startWatching() {
  if (!navigator.geolocation || watchId !== null) return;
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      myPos = [pos.coords.latitude, pos.coords.longitude];
      lastFixAt = Date.now();
      locationError = "";
      saveLastPos(myPos);
      drawMe();
      if (!centredOnce) {
        centredOnce = true;
        if (!userDragged) map.setView(myPos, Math.max(map.getZoom(), 16));
        preloadAround(myPos[0], myPos[1]); // skips squares already loaded
      }
    },
    (err) => {
      locationError = err.code === 1 ? "Location permission was denied." : "Couldn't get your location.";
      if (err.code === 1) stopWatching();
      drawMe(); // turns grey (or stays hidden)
    },
    { enableHighAccuracy: true, maximumAge: 10000 }
  );
}

function stopWatching() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

/** Start following the position; pauses while the app is in the background. */
export function initLocation() {
  const last = loadLastPos();
  if (last) {
    myPos = last; // grey until a live fix arrives
    map.setView(last, 16, { animate: false });
    drawMe();
  }
  map.on("dragstart", () => (userDragged = true));
  startWatching();
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopWatching();
    else startWatching();
  });
  // Turn the dot grey when updates stop.
  setInterval(drawMe, 15000);
}

/** Centre on the current (or last known) position. */
export function centreOnMe(onError) {
  if (!navigator.geolocation) {
    onError("This browser can't share your location.");
    return;
  }
  if (myPos) map.setView(myPos, Math.max(map.getZoom(), 16));
  else onError(locationError || "Waiting for your location…");
  if (watchId === null && !document.hidden) startWatching(); // try again (e.g. after allowing it)
}

/** The current position { lat, lon, live } or null. */
export function getMyPosition() {
  return myPos ? { lat: myPos[0], lon: myPos[1], live: isLive() } : null;
}

export function getLocationError() {
  return locationError;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
