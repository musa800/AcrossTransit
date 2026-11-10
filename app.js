// Step 1: search stops and show next departures, using the Peatus.ee
// OpenTripPlanner GraphQL API (open, no key needed).

const API = "https://api.peatus.ee/routing/v1/routers/estonia/index/graphql";

// Rough box around Tallinn, so a search like "Viru" doesn't return stops
// elsewhere in Estonia.
const TALLINN = { minLat: 59.33, maxLat: 59.53, minLon: 24.50, maxLon: 25.05 };

const REFRESH_MS = 30000;

const $ = (id) => document.getElementById(id);
let refreshTimer = null;
let currentStop = null;

// When a request fails before any answer arrives, find out why: send a
// "no-cors" probe, which the browser lets through without letting us read
// the answer. If the probe gets through, the server is reachable and the
// browser blocked our real request (CORS). If the probe also fails, it's a
// network problem or the page can't make requests at all.
async function diagnose(err) {
  const where = location.protocol === "file:" ? "opened as a local file" : `opened from ${location.host}`;
  let probe;
  try {
    await fetch(API, { method: "POST", mode: "no-cors", body: "{}" });
    probe = "server reachable → browser blocked the request (CORS)";
  } catch (e) {
    probe = "server not reachable from this page (network, or the page can't make requests)";
  }
  return new Error(`${err.name}: ${err.message} | ${probe} | page ${where}`);
}

async function gql(query, variables = {}) {
  let res;
  try {
    res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    throw await diagnose(err);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API error ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  if (json.errors) throw new Error(json.errors.map((e) => e.message).join("; "));
  return json.data;
}

function showMessage(text) {
  $("message").textContent = text || "";
}

// ---------- Stop search ----------

async function searchStops(name) {
  const data = await gql(
    `query ($name: String!) {
       stops(name: $name) { gtfsId name code desc lat lon }
     }`,
    { name }
  );
  return (data.stops || []).filter(
    (s) =>
      s.lat >= TALLINN.minLat && s.lat <= TALLINN.maxLat &&
      s.lon >= TALLINN.minLon && s.lon <= TALLINN.maxLon
  );
}

function renderStops(stops) {
  const list = $("stops");
  list.innerHTML = "";
  stops.sort((a, b) => a.name.localeCompare(b.name, "et"));
  for (const stop of stops) {
    const li = document.createElement("li");
    const extra = [stop.desc, stop.code ? `code ${stop.code}` : ""].filter(Boolean).join(" · ");
    li.innerHTML = `<strong></strong><p class="muted small"></p>`;
    li.querySelector("strong").textContent = stop.name;
    li.querySelector("p").textContent = extra;
    li.addEventListener("click", () => openStop(stop));
    list.appendChild(li);
  }
  $("stop-list").hidden = false;
  $("departures-panel").hidden = true;
}

// ---------- Departures ----------

async function loadDepartures(stopId) {
  const data = await gql(
    `query ($id: String!) {
       stop(id: $id) {
         stoptimesWithoutPatterns(numberOfDepartures: 20, omitNonPickups: true) {
           serviceDay
           scheduledDeparture
           realtimeDeparture
           realtime
           headsign
           trip { route { shortName mode } }
         }
       }
     }`,
    { id: stopId }
  );
  return data.stop ? data.stop.stoptimesWithoutPatterns : [];
}

function formatClock(unixSeconds) {
  return new Date(unixSeconds * 1000).toLocaleTimeString("et-EE", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function renderDepartures(deps) {
  const list = $("departures");
  list.innerHTML = "";
  const now = Date.now() / 1000;

  if (!deps.length) {
    list.innerHTML = `<li class="muted">No upcoming departures.</li>`;
  }

  for (const d of deps) {
    const when = d.serviceDay + (d.realtime ? d.realtimeDeparture : d.scheduledDeparture);
    const mins = Math.round((when - now) / 60);
    const route = (d.trip && d.trip.route) || {};
    const mode = ["BUS", "TROLLEYBUS", "TRAM", "RAIL"].includes(route.mode) ? route.mode : "OTHER";

    const li = document.createElement("li");
    li.className = "dep";
    li.innerHTML = `
      <span class="badge ${mode}"></span>
      <span class="headsign"></span>
      <span class="time">
        <div class="mins"></div>
        <div class="small muted clock"></div>
      </span>`;
    li.querySelector(".badge").textContent = route.shortName || "?";
    li.querySelector(".headsign").textContent = d.headsign || "";
    const minsEl = li.querySelector(".mins");
    minsEl.textContent = mins <= 0 ? "now" : `${mins} min`;
    if (d.realtime) minsEl.classList.add("live");
    li.querySelector(".clock").textContent = formatClock(when);
    list.appendChild(li);
  }

  $("updated").textContent =
    "Updated " + new Date().toLocaleTimeString("et-EE") + " · ● = live estimate";
}

async function refreshDepartures() {
  if (!currentStop) return;
  try {
    renderDepartures(await loadDepartures(currentStop.gtfsId));
    showMessage("");
  } catch (err) {
    showMessage("Couldn't load departures: " + err.message);
  }
}

function openStop(stop) {
  currentStop = stop;
  $("stop-name").textContent = stop.name;
  $("stop-meta").textContent = [stop.desc, stop.code ? `code ${stop.code}` : ""]
    .filter(Boolean)
    .join(" · ");
  $("stop-list").hidden = true;
  $("departures-panel").hidden = false;
  $("departures").innerHTML = `<li class="muted">Loading…</li>`;
  refreshDepartures();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshDepartures, REFRESH_MS);
}

function closeStop() {
  currentStop = null;
  clearInterval(refreshTimer);
  $("departures-panel").hidden = true;
  $("stop-list").hidden = false;
}

// ---------- Wiring ----------

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

$("back-btn").addEventListener("click", closeStop);
