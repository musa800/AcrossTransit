// Screen: tabs, stop search, departures (Stops tab and the map's stop panel).
// Wires everything together.

import { searchStops, getStopDepartures, getTallinnStops, getStopPatterns } from "./peatus.js?v=8";
import {
  initMap, showMap, hideMap, resizeMap, setStop, clearStop, centreOnMe,
  setStops, showStopRoutes, lineColor,
} from "./map.js?v=8";

const DEPARTURES_REFRESH_MS = 30000;
const MODES = ["BUS", "TROLLEYBUS", "TRAM", "RAIL"];

const $ = (id) => document.getElementById(id);
let depTimer = null;
let currentStop = null;
let currentRoutes = [];
let lastDepartures = [];
let activeTab = "stops";

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
  $("stops-view").hidden = tab !== "stops";
  $("map-view").hidden = tab !== "map";
  if (tab === "map") showMap();
  else hideMap();
}

for (const btn of document.querySelectorAll(".tab-btn")) {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
}

// ---------- Stop search ----------

function stopMeta(stop) {
  return [stop.desc, stop.code ? `code ${stop.code}` : ""].filter(Boolean).join(" · ");
}

function renderStops(stops) {
  const list = $("stops");
  list.innerHTML = "";
  stops.sort((a, b) => a.name.localeCompare(b.name, "et"));
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
    const stops = await searchStops(name);
    renderStops(stops);
    showMessage(stops.length ? "" : "No stops in Tallinn match that name.");
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
  for (const r of lines) box.appendChild(makeBadge(r.shortName, r.mode, "chip-badge"));
}

function renderAllDepartures() {
  fillDepartureList($("departures"), lastDepartures);
  fillDepartureList($("sheet-departures"), lastDepartures);
  $("updated").textContent = "Updated " + new Date().toLocaleTimeString("et-EE");
}

async function refreshDepartures(firstLoad = false) {
  if (!currentStop) return;
  const stop = currentStop;
  try {
    const { routes, departures } = await getStopDepartures(stop.gtfsId, 20);
    if (stop !== currentStop) return; // another stop was opened meanwhile
    lastDepartures = departures;
    if (firstLoad) {
      currentRoutes = routes;
      setStop(stop, routes);
      renderLineChips();
      loadRoutes(stop);
    }
    renderAllDepartures();
    showMessage("");
  } catch (err) {
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
  currentStop = stop;
  currentRoutes = [];
  lastDepartures = [];

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
  clearInterval(depTimer);
  clearStop();
  setSheetOpen(false);
  $("departures-panel").hidden = true;
  $("stop-list").hidden = $("stops").children.length === 0;
}

function setSheetOpen(open) {
  const wasOpen = !$("stop-sheet").hidden;
  $("stop-sheet").hidden = !open;
  $("map-view").classList.toggle("sheet-open", open);
  if (wasOpen !== open && activeTab === "map") resizeMap();
}

$("back-btn").addEventListener("click", closeStop);
$("show-on-map").addEventListener("click", () => switchTab("map"));
$("sheet-close").addEventListener("click", closeStop);

// ---------- Map ----------

initMap($("map"), mapStatus);

// Load all Tallinn stops once; the map shows those within 2 km of its centre.
getTallinnStops()
  .then((stops) => setStops(stops, openStop))
  .catch((err) => mapStatus("Couldn't load stops: " + err.message, true));

$("centre-btn").addEventListener("click", () => centreOnMe((msg) => mapStatus(msg, true)));

// Resume updates when the app comes back from the background.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && activeTab === "map") showMap();
});
