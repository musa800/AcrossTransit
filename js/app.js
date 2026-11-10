// Screen: tabs, stop search, departures list. Wires everything together.

import { searchStops, getStopDepartures } from "./peatus.js";
import { initMap, showMap, hideMap, setStop, clearStop, centreOnMe } from "./map.js";

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

async function refreshDepartures(firstLoad = false) {
  if (!currentStop) return;
  try {
    const { routes, departures } = await getStopDepartures(currentStop.gtfsId);
    renderDepartures(departures);
    if (firstLoad) {
      setStop(currentStop, routes);
      $("map-stop-name").textContent = currentStop.name;
      $("map-stop-chip").hidden = false;
    }
    showMessage("");
  } catch (err) {
    showMessage("Couldn't load departures: " + err.message);
  }
}

function openStop(stop) {
  currentStop = stop;
  $("stop-name").textContent = stop.name;
  $("stop-meta").textContent = stopMeta(stop);
  $("stop-list").hidden = true;
  $("departures-panel").hidden = false;
  $("departures").innerHTML = `<li class="muted">Loading…</li>`;
  refreshDepartures(true);
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
