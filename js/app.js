// Screen: tabs, stop search, departures (Stops tab and the map's stop panel).
// Wires everything together.

import {
  searchStops, getStopDepartures, getStopsInBox, getStopPatterns,
  getStopLineDepartures, getStopLineSchedule, getNearbyDepartures, getStopsPatterns,
} from "./peatus.js?v=36";
import {
  initMap, showMap, hideMap, resizeMap, setStop, clearStop, centreOnMe,
  setStopSource, getCenter, showStopRoutes, setLineFilter, lineColor, setMode,
  initLocation, getMyPosition, getLocationError, showRoute, clearRoute,
  showNearRoutes, setNearFilter, clearNearRoutes, setNearStops,
} from "./map.js?v=36";
import { initPlanner, isSheetOpen as isPlanSheetOpen } from "./plan.js?v=36";
import { initRoutes, enterRoutes } from "./routes.js?v=36";

const DEPARTURES_REFRESH_MS = 30000;
const MODES = ["BUS", "TROLLEYBUS", "TRAM", "RAIL"];

const $ = (id) => document.getElementById(id);
let depTimer = null;
let currentStop = null;
let currentRoutes = [];
let lastDepartures = [];
let selectedLine = null; // { mode, shortName } chosen in the panel, or null for all lines
let activeTab = "map"; // the app opens on the Map tab

function showMessage(text) {
  $("message").textContent = text || "";
}

function mapStatus(text, isError) {
  const el = $("map-status");
  el.textContent = text;
  el.classList.toggle("error", !!isError);
}

// ---------- Tabs ----------

function switchTab(tab) {
  activeTab = tab;
  for (const btn of document.querySelectorAll(".tab-btn")) {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  }
  const onMap = tab === "map" || tab === "plan";
  $("stops-view").hidden = tab !== "stops";
  $("routes-view").hidden = tab !== "routes";
  $("map-view").hidden = !onMap;
  if (tab === "routes") enterRoutes();
  $("map-view").classList.toggle("plan-mode", tab === "plan");
  if (onMap) {
    setMode(tab === "plan" ? "plan" : "stops");
    updateLayout(false);
    showMap();
  } else {
    hideMap();
  }
}

/** Shrink the map when the bottom panel of the current tab is open. */
function updateLayout(resize = true, force = false) {
  const open =
    activeTab === "map" ? !$("stop-sheet").hidden || !$("near-sheet").hidden :
    activeTab === "plan" ? isPlanSheetOpen() : false;
  const view = $("map-view");
  if (view.classList.contains("sheet-open") === open && !force) return;
  view.classList.toggle("sheet-open", open);
  if (resize) resizeMap();
}

for (const btn of document.querySelectorAll(".tab-btn")) {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
}

// ---------- Stop search ----------

const MAX_SEARCH_RESULTS = 30;

function formatDistance(m) {
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  if (m < 10000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m / 1000)} km`;
}

function stopMeta(stop) {
  return [
    stop.desc,
    stop.code ? `code ${stop.code}` : "",
    stop.distance != null ? formatDistance(stop.distance) : "",
  ].filter(Boolean).join(" · ");
}

/** Stops are already sorted nearest first (from the map centre). */
function renderStops(stops) {
  const list = $("stops");
  list.innerHTML = "";
  for (const stop of stops) {
    const li = document.createElement("li");
    li.innerHTML = `<strong></strong><p class="muted small"></p>`;
    li.querySelector("strong").textContent = stop.name;
    li.querySelector("p").textContent = stopMeta(stop);
    li.addEventListener("click", () => openStop(stop));
    list.appendChild(li);
  }
  $("stop-list").hidden = false;
  $("departures-panel").hidden = true;
}

$("search-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("search-input").value.trim();
  if (!name) return;
  closeStop();
  showMessage("Searching…");
  try {
    const stops = (await searchStops(name, getCenter())).slice(0, MAX_SEARCH_RESULTS);
    renderStops(stops);
    showMessage(stops.length ? "" : "No stops match that name.");
  } catch (err) {
    $("stop-list").hidden = true;
    showMessage("Search failed: " + err.message);
  }
});

// ---------- Departures ----------

function formatClock(unixSeconds) {
  return new Date(unixSeconds * 1000).toLocaleTimeString("et-EE", { hour: "2-digit", minute: "2-digit" });
}

/** A line badge: the selected stop's line colour if it has one, else the vehicle-type colour. */
function makeBadge(line, mode, extraClass = "") {
  const span = document.createElement("span");
  span.className = `badge ${MODES.includes(mode) ? mode : "OTHER"} ${extraClass}`.trim();
  span.textContent = line;
  const color = lineColor(mode, line);
  if (color) span.style.background = color;
  return span;
}

function fillDepartureList(list, deps) {
  list.innerHTML = "";
  const now = Date.now() / 1000;
  if (!deps.length) {
    list.innerHTML = `<li class="muted">No upcoming departures.</li>`;
    return;
  }
  for (const d of deps) {
    const mins = Math.round((d.time - now) / 60);
    const li = document.createElement("li");
    li.className = "dep";
    li.appendChild(makeBadge(d.line, d.mode));
    const head = document.createElement("span");
    head.className = "headsign";
    head.textContent = d.headsign;
    li.appendChild(head);
    const time = document.createElement("span");
    time.className = "time";
    time.innerHTML = `<div class="mins"></div><div class="small muted clock"></div>`;
    time.querySelector(".mins").textContent = mins <= 0 ? "now" : `${mins} min`;
    time.querySelector(".clock").textContent = formatClock(d.time);
    li.appendChild(time);
    list.appendChild(li);
  }
}

/** The line chips in the stop panel, sorted by number. */
function renderLineChips() {
  const box = $("sheet-lines");
  box.innerHTML = "";
  const seen = new Set();
  const lines = currentRoutes
    .filter((r) => {
      const k = `${r.mode}|${r.shortName}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => String(a.shortName).localeCompare(String(b.shortName), "et", { numeric: true }));
  for (const r of lines) {
    const isOn = selectedLine && selectedLine.mode === r.mode && selectedLine.shortName === r.shortName;
    const chip = makeBadge(r.shortName, r.mode, "chip-badge");
    chip.setAttribute("role", "button");
    chip.tabIndex = 0;
    if (selectedLine) chip.classList.add(isOn ? "on" : "faded");
    chip.addEventListener("click", () => chooseLine(isOn ? null : r));
    box.appendChild(chip);
  }
  if (selectedLine) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sched-btn";
    btn.textContent = "Schedule";
    btn.addEventListener("click", openSchedule);
    box.appendChild(btn);
  }
}

/** Show one line only (route = {mode, shortName}), or all lines with null. */
function chooseLine(route) {
  selectedLine = route;
  lastDepartures = [];
  showingStale = false;
  $("sheet-updated").hidden = true;
  setLineFilter(route?.mode, route ? route.shortName : null);
  renderLineChips();
  $("sheet-departures").innerHTML = `<li class="muted">Loading…</li>`;
  $("sheet-departures").scrollTop = 0;
  refreshDepartures();
}

let lastLoadedAt = 0;   // when lastDepartures arrived (ms)
let showingStale = false;

/**
 * Show lastDepartures in both lists. stale: the latest refresh failed (e.g.
 * offline), so keep the old list, drop departures that have gone, and say
 * when it was last updated.
 */
function renderAllDepartures(stale = showingStale) {
  showingStale = stale;
  const now = Date.now() / 1000;
  const deps = stale ? lastDepartures.filter((d) => d.time >= now - 60) : lastDepartures;
  fillDepartureList($("departures"), deps);
  fillDepartureList($("sheet-departures"), deps);
  const at = new Date(lastLoadedAt).toLocaleTimeString("et-EE", { hour: "2-digit", minute: "2-digit" });
  const text = stale ? `Last updated ${at} · offline, not live` : `Updated ${at}`;
  $("updated").textContent = text;
  $("updated").classList.toggle("stale", stale);
  $("sheet-updated").textContent = stale ? text : "";
  $("sheet-updated").hidden = !stale;
}

async function refreshDepartures(firstLoad = false) {
  if (!currentStop) return;
  const stop = currentStop;
  const line = selectedLine;
  try {
    let routes = null;
    let departures;
    if (line && !firstLoad) {
      departures = await getStopLineDepartures(stop.gtfsId, line.mode, line.shortName, 20);
    } else {
      ({ routes, departures } = await getStopDepartures(stop.gtfsId, 20));
    }
    // Ignore the answer if another stop or line was chosen meanwhile.
    if (stop !== currentStop || line !== selectedLine) return;
    lastDepartures = departures;
    lastLoadedAt = Date.now();
    if (firstLoad) {
      currentRoutes = routes;
      setStop(stop, routes);
      renderLineChips();
      loadRoutes(stop);
    }
    renderAllDepartures(false);
    showMessage("");
  } catch (err) {
    // Keep the last loaded departures (marked as not live) if we have any.
    if (stop === currentStop && line === selectedLine && lastDepartures.length) {
      renderAllDepartures(true);
      return;
    }
    showMessage("Couldn't load departures: " + err.message);
    const list = $("sheet-departures");
    list.innerHTML = "";
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "Couldn't load departures: " + err.message;
    list.appendChild(li);
  }
}

function loadRoutes(stop) {
  getStopPatterns(stop.gtfsId)
    .then((patterns) => {
      if (stop !== currentStop) return;
      showStopRoutes(patterns);
      // Line colours are known now: recolour chips and badges to match the map.
      renderLineChips();
      renderAllDepartures();
    })
    .catch((err) => mapStatus("Couldn't load routes: " + err.message, true));
}

// ---------- Opening and closing a stop ----------

function openStop(stop) {
  closeNear(false);
  hideRouteBar();
  currentStop = stop;
  currentRoutes = [];
  lastDepartures = [];
  showingStale = false;
  $("sheet-updated").hidden = true;
  selectedLine = null;

  // Stops tab
  $("stop-name").textContent = stop.name;
  $("stop-meta").textContent = stopMeta(stop);
  $("stop-list").hidden = true;
  $("departures-panel").hidden = false;
  $("departures").innerHTML = `<li class="muted">Loading…</li>`;

  // Map panel
  $("sheet-stop-name").textContent = stop.name;
  $("sheet-lines").innerHTML = "";
  $("sheet-departures").innerHTML = `<li class="muted">Loading…</li>`;
  $("sheet-departures").scrollTop = 0;
  setSheetOpen(true);

  refreshDepartures(true);
  clearInterval(depTimer);
  depTimer = setInterval(() => refreshDepartures(), DEPARTURES_REFRESH_MS);
}

function closeStop() {
  currentStop = null;
  currentRoutes = [];
  selectedLine = null;
  clearInterval(depTimer);
  clearStop();
  setSheetOpen(false);
  $("departures-panel").hidden = true;
  $("stop-list").hidden = $("stops").children.length === 0;
}

function setSheetOpen(open) {
  $("stop-sheet").hidden = !open;
  if (activeTab === "map") updateLayout();
}

$("back-btn").addEventListener("click", closeStop);
$("show-on-map").addEventListener("click", () => switchTab("map"));
$("sheet-close").addEventListener("click", () => {
  closeSchedule();
  closeStop();
});

// ---------- Schedule (one line at this stop, whole day) ----------

// Date row: [<] [3 dates] [>]. The arrows move the chosen day by one; the
// row slides to keep it visible. Today up to 13 days ahead (14 days).
const SCHED_DAYS = 14;
const SCHED_VISIBLE = 3;
let scheduleDay = 0;        // days after today
let schedWindowStart = 0;   // first day shown in the row
const schedCache = new Map(); // day -> rows, while the schedule is open

function dayDate(offset) {
  const d = new Date();
  d.setHours(12, 0, 0, 0); // midday: safe across daylight-saving changes
  d.setDate(d.getDate() + offset);
  return d;
}

function dayLabel(offset) {
  if (offset === 0) return "Today";
  if (offset === 1) return "Tomorrow";
  const d = dayDate(offset);
  const wd = d.toLocaleDateString("en-GB", { weekday: "short" });
  return `${wd} ${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function renderDayRow() {
  if (scheduleDay < schedWindowStart) schedWindowStart = scheduleDay;
  if (scheduleDay > schedWindowStart + SCHED_VISIBLE - 1) schedWindowStart = scheduleDay - SCHED_VISIBLE + 1;
  const row = $("sched-days");
  row.innerHTML = "";
  const prev = document.createElement("button");
  prev.type = "button";
  prev.className = "day-arrow";
  prev.textContent = "<";
  prev.setAttribute("aria-label", "Previous day");
  prev.disabled = scheduleDay === 0;
  prev.addEventListener("click", () => loadSchedule(scheduleDay - 1));
  row.appendChild(prev);
  for (let i = schedWindowStart; i < schedWindowStart + SCHED_VISIBLE && i < SCHED_DAYS; i++) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "day-btn" + (i === scheduleDay ? " active" : "");
    b.textContent = dayLabel(i);
    b.addEventListener("click", () => loadSchedule(i));
    row.appendChild(b);
  }
  const next = document.createElement("button");
  next.type = "button";
  next.className = "day-arrow";
  next.textContent = ">";
  next.setAttribute("aria-label", "Next day");
  next.disabled = scheduleDay === SCHED_DAYS - 1;
  next.addEventListener("click", () => loadSchedule(scheduleDay + 1));
  row.appendChild(next);
}

function openSchedule() {
  if (!currentStop || !selectedLine) return;
  $("sched-title").textContent = `Line ${selectedLine.shortName}`;
  $("sched-stop").textContent = currentStop.name;
  const badge = $("sched-badge");
  badge.replaceWith(Object.assign(makeBadge(selectedLine.shortName, selectedLine.mode), { id: "sched-badge" }));
  schedCache.clear();
  schedWindowStart = 0;
  $("schedule-view").hidden = false;
  loadSchedule(0);
}

function closeSchedule() {
  $("schedule-view").hidden = true;
}

async function loadSchedule(dayOffset) {
  dayOffset = Math.max(0, Math.min(SCHED_DAYS - 1, dayOffset));
  scheduleDay = dayOffset;
  renderDayRow();
  const body = $("sched-body");
  $("sched-legend").innerHTML = "";
  if (schedCache.has(dayOffset)) {
    renderSchedule(schedCache.get(dayOffset), dayOffset === 0);
    return;
  }
  body.innerHTML = `<p class="muted">Loading…</p>`;
  const stop = currentStop;
  const line = selectedLine;
  try {
    const rows = await getStopLineSchedule(stop.gtfsId, line.mode, line.shortName, dayDate(dayOffset));
    if (stop !== currentStop || line !== selectedLine) return;
    schedCache.set(dayOffset, rows);
    if (dayOffset !== scheduleDay) return;
    renderSchedule(rows, dayOffset === 0);
  } catch (err) {
    if (dayOffset !== scheduleDay) return;
    body.innerHTML = "";
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "Couldn't load the schedule: " + err.message;
    body.appendChild(p);
  }
}

function renderSchedule(rows, isToday) {
  const body = $("sched-body");
  const legend = $("sched-legend");
  body.innerHTML = "";
  legend.innerHTML = "";
  if (!rows.length) {
    body.innerHTML = "";
    const p = document.createElement("p");
    p.className = "muted";
    const when = scheduleDay === 0 ? "today" : scheduleDay === 1 ? "tomorrow" : `on ${dayLabel(scheduleDay)}`;
    p.textContent = `No departures of this line from this stop ${when}.`;
    body.appendChild(p);
    return;
  }

  // Destinations: the most common one has no mark; others get a, b, c…
  const counts = new Map();
  for (const r of rows) counts.set(r.headsign, (counts.get(r.headsign) || 0) + 1);
  const heads = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
  const mark = new Map(heads.map((h, i) => [h, i === 0 ? "" : String.fromCharCode(96 + i)]));
  for (const h of heads) {
    const p = document.createElement("p");
    p.className = "small";
    p.textContent = (mark.get(h) ? `${mark.get(h)} = ` : "") + `→ ${h}`;
    legend.appendChild(p);
  }

  const now = Date.now() / 1000;
  const nextIdx = isToday ? rows.findIndex((r) => r.time >= now) : -1;
  let currentRow = null;

  // One row per hour.
  const byHour = new Map();
  rows.forEach((r, i) => {
    const h = Math.floor(r.secs / 3600);
    if (!byHour.has(h)) byHour.set(h, []);
    byHour.get(h).push({ ...r, i });
  });
  for (const [h, list] of byHour) {
    const row = document.createElement("div");
    row.className = "sched-row";
    const hour = document.createElement("span");
    hour.className = "sched-hour";
    hour.textContent = String(h % 24).padStart(2, "0");
    row.appendChild(hour);
    const mins = document.createElement("span");
    mins.className = "sched-mins";
    for (const r of list) {
      const m = document.createElement("span");
      m.className = "sched-min";
      m.textContent = String(Math.floor((r.secs % 3600) / 60)).padStart(2, "0");
      if (mark.get(r.headsign)) {
        const sup = document.createElement("sup");
        sup.textContent = mark.get(r.headsign);
        m.appendChild(sup);
      }
      if (isToday && r.time < now) m.classList.add("past");
      if (r.i === nextIdx) {
        m.classList.add("next");
        currentRow = row;
      }
      mins.appendChild(m);
    }
    row.appendChild(mins);
    body.appendChild(row);
  }
  if (currentRow) currentRow.scrollIntoView({ block: "center" });
}

$("sched-back").addEventListener("click", closeSchedule);

// ---------- Map ----------

initMap($("map"), mapStatus);
initLocation(); // centre on you once, keep the position updated while the app is open
initPlanner(() => {
  // force: the panel may only have changed height (hidden/shown steps).
  if (activeTab === "plan") updateLayout(true, true);
});

// The map loads stops itself, a small area at a time, only when zoomed in.
setStopSource(getStopsInBox, openStop);

$("centre-btn").addEventListener("click", () => centreOnMe((msg) => mapStatus(msg, true)));

// Resume updates when the app comes back from the background.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && (activeTab === "map" || activeTab === "plan")) showMap();
});

// ---------- Near me: departures from all stops within 200 m ----------

const NEAR_RADIUS_M = 200;
let nearPos = null;   // fixed where the button was tapped (doesn't follow you)
let nearTimer = null;
let nearRun = 0;
let nearLast = null;  // { stops, departures, at }
let nearLines = [];   // [{ mode, shortName }] serving the nearby stops
let nearLine = null;  // the chosen line, or null for all
let nearSession = 0;  // changes each time the panel is opened or closed

function nearDistance(m) {
  return `${Math.round(m / 10) * 10} m`;
}

function renderNear(stale) {
  const list = $("near-departures");
  list.innerHTML = "";
  const now = Date.now() / 1000;
  const { stops, departures, at } = nearLast;
  let deps = stale ? departures.filter((d) => d.time >= now - 60) : departures;
  if (nearLine) deps = deps.filter((d) => d.mode === nearLine.mode && d.line === nearLine.shortName);
  deps = deps.slice(0, 20);
  const when = new Date(at).toLocaleTimeString("et-EE", { hour: "2-digit", minute: "2-digit" });
  const n = stops.length;
  $("near-note").textContent =
    `${n} ${n === 1 ? "stop" : "stops"} within ${NEAR_RADIUS_M} m · ` +
    (stale ? `last updated ${when}, offline, not live` : `updated ${when}`);
  $("near-note").classList.toggle("stale", stale);
  if (!n) {
    list.innerHTML = `<li class="muted">No stops within ${NEAR_RADIUS_M} m of you.</li>`;
    return;
  }
  if (!deps.length) {
    list.innerHTML = nearLine
      ? `<li class="muted">No upcoming departures of this line from these stops.</li>`
      : `<li class="muted">No upcoming departures from these stops.</li>`;
    return;
  }
  for (const d of deps) {
    const mins = Math.round((d.time - now) / 60);
    const li = document.createElement("li");
    li.className = "dep near-dep";
    li.appendChild(makeBadge(d.line, d.mode));
    const head = document.createElement("span");
    head.className = "headsign";
    const dest = document.createElement("span");
    dest.textContent = d.headsign;
    const where = document.createElement("span");
    where.className = "near-stop";
    where.textContent = `${d.stop.name} · ${nearDistance(d.stop.distance)}`;
    head.append(dest, where);
    li.appendChild(head);
    const time = document.createElement("span");
    time.className = "time";
    time.innerHTML = `<div class="mins"></div><div class="small muted clock"></div>`;
    time.querySelector(".mins").textContent = mins <= 0 ? "now" : `${mins} min`;
    time.querySelector(".clock").textContent = formatClock(d.time);
    li.appendChild(time);
    li.addEventListener("click", () => openStop(d.stop));
    list.appendChild(li);
  }
}

async function refreshNear() {
  if (!nearPos) return;
  const run = ++nearRun;
  try {
    const r = await getNearbyDepartures(nearPos, NEAR_RADIUS_M, 20);
    if (run !== nearRun || !nearPos) return;
    nearLast = { ...r, at: Date.now() };
    renderNear(false);
  } catch (err) {
    if (run !== nearRun || !nearPos) return;
    if (nearLast) renderNear(true);
    else $("near-departures").innerHTML = "";
    if (!nearLast) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = "Couldn't load departures: " + err.message;
      $("near-departures").appendChild(li);
    }
  }
}

/** The line chips in the Near you panel (tap one to show only that line). */
function renderNearChips() {
  const box = $("near-lines");
  box.innerHTML = "";
  for (const r of nearLines) {
    const isOn = nearLine && nearLine.mode === r.mode && nearLine.shortName === r.shortName;
    const chip = makeBadge(r.shortName, r.mode, "chip-badge");
    chip.setAttribute("role", "button");
    chip.tabIndex = 0;
    if (nearLine) chip.classList.add(isOn ? "on" : "faded");
    chip.addEventListener("click", () => chooseNearLine(isOn ? null : r));
    box.appendChild(chip);
  }
}

function chooseNearLine(r) {
  nearLine = r;
  setNearFilter(r?.mode, r ? r.shortName : null);
  renderNearChips();
  $("near-departures").scrollTop = 0;
  if (nearLast) renderNear(false);
}

/** Lines serving the nearby stops, from their routes and departures, sorted by number. */
function collectNearLines(patterns) {
  const seen = new Map();
  for (const p of patterns) seen.set(`${p.mode}|${p.line}`, { mode: p.mode, shortName: p.line });
  for (const d of nearLast?.departures || []) seen.set(`${d.mode}|${d.line}`, { mode: d.mode, shortName: d.line });
  return [...seen.values()].sort((a, b) => String(a.shortName).localeCompare(String(b.shortName), "et", { numeric: true }));
}

function openNear() {
  const pos = getMyPosition();
  if (!pos) {
    mapStatus(getLocationError() || "Waiting for your location…", true);
    return;
  }
  closeStop();
  hideRouteBar();
  nearPos = pos;
  nearLast = null;
  nearLine = null;
  nearLines = [];
  $("near-lines").innerHTML = "";
  $("near-note").textContent = pos.live ? "" : "Using your last known position.";
  $("near-departures").innerHTML = `<li class="muted">Loading…</li>`;
  $("near-departures").scrollTop = 0;
  $("near-sheet").hidden = false;
  if (activeTab === "map") updateLayout();
  const session = ++nearSession;
  refreshNear().then(async () => {
    // Routes through the nearby stops: drawn neutral; chips to pick one line.
    if (session !== nearSession || !nearLast) return;
    setNearStops(nearLast.stops); // map: only the stops within 200 m
    if (!nearLast.stops.length) return;
    try {
      const patterns = await getStopsPatterns(nearLast.stops.map((s) => s.gtfsId));
      if (session !== nearSession) return;
      showNearRoutes(patterns);
      nearLines = collectNearLines(patterns);
      renderNearChips();
    } catch (err) {
      mapStatus("Couldn't load routes: " + err.message, true);
    }
  });
  clearInterval(nearTimer);
  nearTimer = setInterval(refreshNear, DEPARTURES_REFRESH_MS);
}

function closeNear(layout = true) {
  if ($("near-sheet").hidden) return;
  nearPos = null;
  nearLine = null;
  nearRun++;
  nearSession++;
  clearInterval(nearTimer);
  clearNearRoutes();
  $("near-sheet").hidden = true;
  if (layout && activeTab === "map") updateLayout();
}

$("near-btn").addEventListener("click", openNear);
$("near-close").addEventListener("click", () => closeNear());

// ---------- A route opened from the Routes tab ----------

const ROUTE_COLOR = "#e6194b";

function hideRouteBar() {
  if ($("route-bar").hidden) return;
  $("route-bar").hidden = true;
  clearRoute();
}

initRoutes({
  onShowOnMap(route, direction) {
    closeNear(false);
    closeStop();
    switchTab("map");
    showRoute(route, direction);
    const b = $("route-bar-badge");
    const nb = makeBadge(route.line, route.mode);
    nb.id = "route-bar-badge";
    nb.style.background = ROUTE_COLOR; // same colour as the drawn route and its buses
    b.replaceWith(nb);
    $("route-bar-text").textContent = `→ ${direction.headsign}`;
    $("route-bar").hidden = false;
  },
  onOpenStop(stop) {
    switchTab("map");
    openStop(stop);
  },
});
$("route-bar-close").addEventListener("click", hideRouteBar);

// ---------- Offline / online ----------

function updateOnlineState() {
  const offline = !navigator.onLine;
  $("offline-banner").hidden = !offline;
  if (!offline) {
    // Back online: reload what's on screen.
    if (currentStop) refreshDepartures();
    if (nearPos) refreshNear();
    if (activeTab === "map" || activeTab === "plan") showMap();
  }
}
window.addEventListener("online", updateOnlineState);
window.addEventListener("offline", updateOnlineState);
$("offline-banner").hidden = navigator.onLine;

// ---------- Start ----------

switchTab("map");

// Installable app + opening without internet (see sw.js).
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {
    /* not critical: the app works without it, just not offline */
  });
}
