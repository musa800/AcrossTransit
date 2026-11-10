// Screen: tabs, stop search, departures list. Wires everything together.

import { searchStops, getStopDepartures, getTallinnStops } from "./peatus.js?v=5";
import { initMap, showMap, hideMap, setStop, clearStop, centreOnMe, setStops, showStopPopup } from "./map.js?v=5";

const DEPARTURES_REFRESH_MS = 30000;

const $ = (id) => document.getElementById(id);
let depTimer = null;
let currentStop = null;
let activeTab = "stops";

function showMessage(text) {
  $("message").textContent = text || "";
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

function renderDepartures(deps) {
  const list = $("departures");
  list.innerHTML = "";
  const now = Date.now() / 1000;
  if (!deps.length) list.innerHTML = `<li class="muted">No upcoming departures.</li>`;

  for (const d of deps) {
    const mins = Math.round((d.time - now) / 60);
    const mode = ["BUS", "TROLLEYBUS", "TRAM", "RAIL"].includes(d.mode) ? d.mode : "OTHER";
    const li = document.createElement("li");
    li.className = "dep";
    li.innerHTML = `
      <span class="badge ${mode}"></span>
      <span class="headsign"></span>
      <span class="time"><div class="mins"></div><div class="small muted clock"></div></span>`;
    li.querySelector(".badge").textContent = d.line;
    li.querySelector(".headsign").textContent = d.headsign;
    li.querySelector(".mins").textContent = mins <= 0 ? "now" : `${mins} min`;
    li.querySelector(".clock").textContent = formatClock(d.time);
    list.appendChild(li);
  }
  $("updated").textContent = "Updated " + new Date().toLocaleTimeString("et-EE");
}

// Small departures list shown in a popup when a stop is tapped on the map.
function stopPopup(stop, deps) {
  const now = Date.now() / 1000;
  const el = document.createElement("div");
  el.className = "stop-popup";
  const title = document.createElement("strong");
  title.textContent = stop.name;
  el.appendChild(title);
  const list = document.createElement("div");
  list.className = "pop-deps";
  for (const d of deps.slice(0, 5)) {
    const mins = Math.round((d.time - now) / 60);
    const mode = ["BUS", "TROLLEYBUS", "TRAM", "RAIL"].includes(d.mode) ? d.mode : "OTHER";
    const row = document.createElement("div");
    row.className = "pop-dep";
    row.innerHTML = `<span class="badge small-badge ${mode}"></span><span class="headsign"></span><span class="pop-mins"></span>`;
    row.querySelector(".badge").textContent = d.line;
    row.querySelector(".headsign").textContent = d.headsign;
    row.querySelector(".pop-mins").textContent = mins <= 0 ? "now" : `${mins} min`;
    list.appendChild(row);
  }
  if (!deps.length) list.textContent = "No upcoming departures.";
  el.appendChild(list);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pop-btn";
  btn.textContent = "All departures";
  btn.addEventListener("click", () => switchTab("stops"));
  el.appendChild(btn);
  return el;
}

async function refreshDepartures(firstLoad = false, fromMap = false) {
  if (!currentStop) return;
  const stop = currentStop;
  try {
    const { routes, departures } = await getStopDepartures(stop.gtfsId);
    if (stop !== currentStop) return; // another stop was opened meanwhile
    renderDepartures(departures);
    if (firstLoad) {
      setStop(stop, routes, !fromMap);
      $("map-stop-name").textContent = stop.name;
      $("map-stop-chip").hidden = false;
      if (fromMap) showStopPopup(stopPopup(stop, departures));
    }
    showMessage("");
  } catch (err) {
    showMessage("Couldn't load departures: " + err.message);
  }
}

function openStop(stop, fromMap = false) {
  currentStop = stop;
  $("stop-name").textContent = stop.name;
  $("stop-meta").textContent = stopMeta(stop);
  $("stop-list").hidden = true;
  $("departures-panel").hidden = false;
  $("departures").innerHTML = `<li class="muted">Loading…</li>`;
  refreshDepartures(true, fromMap);
  clearInterval(depTimer);
  depTimer = setInterval(() => refreshDepartures(), DEPARTURES_REFRESH_MS);
}

function closeStop() {
  currentStop = null;
  clearInterval(depTimer);
  clearStop();
  $("map-stop-chip").hidden = true;
  $("departures-panel").hidden = true;
  $("stop-list").hidden = $("stops").children.length === 0;
}

$("back-btn").addEventListener("click", closeStop);
$("show-on-map").addEventListener("click", () => switchTab("map"));
$("map-stop-clear").addEventListener("click", closeStop);

// ---------- Map ----------

initMap($("map"), (text, isError) => {
  const el = $("map-status");
  el.textContent = text;
  el.classList.toggle("error", isError);
});

// Load all Tallinn stops once; the map shows those within 2 km of its centre.
getTallinnStops()
  .then((stops) => setStops(stops, (stop) => openStop(stop, true)))
  .catch((err) => {
    const el = $("map-status");
    el.textContent = "Couldn't load stops: " + err.message;
    el.classList.add("error");
  });

$("centre-btn").addEventListener("click", () =>
  centreOnMe((msg) => {
    const el = $("map-status");
    el.textContent = msg;
    el.classList.add("error");
  })
);

// Pause/resume updates when the app goes to the background.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && activeTab === "map") showMap();
});
