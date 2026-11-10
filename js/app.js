// Screen: tabs, stop search, departures (Stops tab and the map's stop panel).
// Wires everything together.

import {
  searchStops, getStopDepartures, getTallinnStops, getStopPatterns,
  getStopLineDepartures, getStopLineSchedule,
} from "./peatus.js?v=9";
import {
  initMap, showMap, hideMap, resizeMap, setStop, clearStop, centreOnMe,
  setStops, showStopRoutes, setLineFilter, lineColor,
} from "./map.js?v=9";

const DEPARTURES_REFRESH_MS = 30000;
const MODES = ["BUS", "TROLLEYBUS", "TRAM", "RAIL"];

const $ = (id) => document.getElementById(id);
let depTimer = null;
let currentStop = null;
let currentRoutes = [];
let lastDepartures = [];
let selectedLine = null; // { mode, shortName } chosen in the panel, or null for all lines
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
  setLineFilter(route?.mode, route ? route.shortName : null);
  renderLineChips();
  $("sheet-departures").innerHTML = `<li class="muted">Loading…</li>`;
  $("sheet-departures").scrollTop = 0;
  refreshDepartures();
}

function renderAllDepartures() {
  fillDepartureList($("departures"), lastDepartures);
  fillDepartureList($("sheet-departures"), lastDepartures);
  $("updated").textContent = "Updated " + new Date().toLocaleTimeString("et-EE");
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
  const wasOpen = !$("stop-sheet").hidden;
  $("stop-sheet").hidden = !open;
  $("map-view").classList.toggle("sheet-open", open);
  if (wasOpen !== open && activeTab === "map") resizeMap();
}

$("back-btn").addEventListener("click", closeStop);
$("show-on-map").addEventListener("click", () => switchTab("map"));
$("sheet-close").addEventListener("click", () => {
  closeSchedule();
  closeStop();
});

// ---------- Schedule (one line at this stop, whole day) ----------

let scheduleDay = 0; // 0 = today, 1 = tomorrow

function openSchedule() {
  if (!currentStop || !selectedLine) return;
  $("sched-title").textContent = `Line ${selectedLine.shortName}`;
  $("sched-stop").textContent = currentStop.name;
  const badge = $("sched-badge");
  badge.replaceWith(Object.assign(makeBadge(selectedLine.shortName, selectedLine.mode), { id: "sched-badge" }));
  $("schedule-view").hidden = false;
  loadSchedule(0);
}

function closeSchedule() {
  $("schedule-view").hidden = true;
}

async function loadSchedule(dayOffset) {
  scheduleDay = dayOffset;
  for (const b of document.querySelectorAll(".day-btn")) {
    b.classList.toggle("active", Number(b.dataset.day) === dayOffset);
  }
  const date = new Date();
  date.setDate(date.getDate() + dayOffset);
  const body = $("sched-body");
  body.innerHTML = `<p class="muted">Loading…</p>`;
  $("sched-legend").innerHTML = "";
  const stop = currentStop;
  const line = selectedLine;
  try {
    const rows = await getStopLineSchedule(stop.gtfsId, line.mode, line.shortName, date);
    if (stop !== currentStop || line !== selectedLine || dayOffset !== scheduleDay) return;
    renderSchedule(rows, dayOffset === 0);
  } catch (err) {
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
    body.innerHTML = `<p class="muted">No departures of this line from this stop on that day.</p>`;
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
for (const b of document.querySelectorAll(".day-btn")) {
  b.addEventListener("click", () => loadSchedule(Number(b.dataset.day)));
}

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
