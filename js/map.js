// Screen: the Leaflet map with live vehicles, the selected stop and the
// user's own position.

import { getVehicles, lineKey } from "./vehicles.js";

const REFRESH_MS = 10000;
const CENTER = [59.437, 24.7536]; // Tallinn old town

let map;
const vehicleMarkers = new Map(); // vehicle id -> Leaflet marker
let stopMarker = null;
let highlight = null; // Set of line keys, or null for "show all normally"
let meMarker = null;
let myPos = null;
let watchId = null;
let timer = null;
let onStatus = () => {};

export function initMap(el, statusCallback) {
  onStatus = statusCallback;
  map = L.map(el, { zoomControl: false }).setView(CENTER, 13);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap contributors",
  }).addTo(map);
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

// ---------- Vehicles ----------

function vehicleIcon(v, dim) {
  const arrow =
    v.heading === null
      ? ""
      : `<span class="v-arrow" style="transform: rotate(${v.heading}deg)"></span>`;
  return L.divIcon({
    className: "",
    html: `<div class="vehicle ${v.mode}${dim ? " dim" : ""}">${arrow}<span class="v-label">${escapeHtml(v.line)}</span></div>`,
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
  let vehicles;
  try {
    vehicles = await getVehicles();
  } catch (err) {
    onStatus(`Couldn't load live vehicles: ${err.message}`, true);
    return;
  }

  const seen = new Set();
  let shown = 0;
  for (const v of vehicles) {
    seen.add(v.id);
    const dim = highlight !== null && !highlight.has(lineKey(v.mode, v.line));
    if (!dim) shown++;
    let m = vehicleMarkers.get(v.id);
    if (!m) {
      m = L.marker([v.lat, v.lon], { icon: vehicleIcon(v, dim) }).addTo(map);
      m.bindPopup(popupText(v));
      vehicleMarkers.set(v.id, m);
    } else {
      m.setLatLng([v.lat, v.lon]);
      m.setIcon(vehicleIcon(v, dim));
      m.setPopupContent(popupText(v));
    }
    m.setZIndexOffset(dim ? 0 : 1000);
  }
  // Remove vehicles that left the feed.
  for (const [id, m] of vehicleMarkers) {
    if (!seen.has(id)) {
      m.remove();
      vehicleMarkers.delete(id);
    }
  }

  const time = new Date().toLocaleTimeString("et-EE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const count = highlight === null ? `${vehicles.length} vehicles` : `${shown} on this stop's lines`;
  onStatus(`${count} · updated ${time}`, false);
}

// ---------- Selected stop ----------

/** Show a stop and highlight vehicles on the given lines ([{mode, shortName}]). */
export function setStop(stop, routes) {
  clearStop();
  highlight = new Set(routes.map((r) => lineKey(r.mode, r.shortName)));
  stopMarker = L.marker([stop.lat, stop.lon], {
    icon: L.divIcon({ className: "", html: `<div class="stop-pin"></div>`, iconSize: [22, 22], iconAnchor: [11, 11] }),
    zIndexOffset: 2000,
  })
    .addTo(map)
    .bindPopup(`<strong>${escapeHtml(stop.name)}</strong>`);
  map.setView([stop.lat, stop.lon], 15);
}

export function clearStop() {
  highlight = null;
  if (stopMarker) {
    stopMarker.remove();
    stopMarker = null;
  }
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
