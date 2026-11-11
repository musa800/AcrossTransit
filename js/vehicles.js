// Data: Tallinn live vehicle positions (transport.tallinn.ee/gps.txt).
// No screen code here, so this file can be reused in other apps.
//
// Each line of the feed is one vehicle:
//   type,line,lon,lat,,heading,vehicle_id,status,unknown,destination
// type: 1 = trolleybus, 2 = bus, 3 = tram
// lon/lat: whole numbers in microdegrees (divide by 1,000,000)
// heading: degrees, 999 = unknown

import { fetchChecked } from "./net.js?v=39";

// The city's feed blocks requests from other websites (CORS), so the app
// reads it through our Cloudflare Worker relay (see relay/cloudflare-worker.js).
// While RELAY_URL is empty, the app tries the feed directly.
const RELAY_URL = "https://acrosstransit-relay.musa-quliyev97.workers.dev/gps";
const GPS_URL = RELAY_URL || "https://transport.tallinn.ee/gps.txt";

const TYPES = { 1: "TROLLEYBUS", 2: "BUS", 3: "TRAM" };

export async function getVehicles() {
  // The time parameter stops the browser from reusing an old copy.
  const res = await fetchChecked(`${GPS_URL}?t=${Date.now()}`, { cache: "no-store" });
  const text = await res.text();
  const vehicles = [];
  for (const row of text.split("\n")) {
    const f = row.trim().split(",");
    if (f.length < 7) continue;
    const lon = Number(f[2]) / 1e6;
    const lat = Number(f[3]) / 1e6;
    if (!lat || !lon) continue;
    const heading = Number(f[5]);
    vehicles.push({
      id: f[6],
      mode: TYPES[f[0]] || "OTHER",
      line: f[1],
      lat,
      lon,
      heading: heading >= 0 && heading < 360 ? heading : null,
      destination: (f[9] || "").trim(),
    });
  }
  return vehicles;
}

// Buses and trolleybuses are treated as the same family when matching,
// in case the two sources label a line differently.
function family(mode) {
  return mode === "TROLLEYBUS" ? "BUS" : mode;
}

/** Key used to match a vehicle to a line from Peatus.ee. */
export function lineKey(mode, line) {
  return `${family(mode)}:${String(line).trim()}`;
}
