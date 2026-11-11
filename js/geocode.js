// Data: place and address search via OpenStreetMap's Nominatim service.
// Free to use, with a limit of about one request per second; this module
// waits between requests so the app stays within it.

import { fetchChecked } from "./net.js?v=26";
import { distanceM } from "./peatus.js?v=26";

const URL_BASE = "https://nominatim.openstreetmap.org/search";
const MIN_GAP_MS = 1100;
let lastRequest = 0;

/**
 * Places in Estonia matching the text: [{ name, detail, lat, lon, distance }].
 * near ({ lat, lon }): results around it are preferred, and distance is filled in.
 */
export async function searchPlaces(text, near) {
  const wait = lastRequest + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequest = Date.now();

  const params = new URLSearchParams({
    q: text,
    format: "jsonv2",
    limit: "6",
    countrycodes: "ee",
    // Prefer (but don't require) places around the map's current area.
    viewbox: `${near.lon - 0.3},${near.lat + 0.15},${near.lon + 0.3},${near.lat - 0.15}`,
    bounded: "0",
    "accept-language": "et,en",
    addressdetails: "1",
  });
  const res = await fetchChecked(`${URL_BASE}?${params}`);
  const items = await res.json();
  return items.map((it) => {
    const a = it.address || {};
    const street = [a.road, a.house_number].filter(Boolean).join(" ");
    const name = it.name || street || it.display_name.split(",")[0];
    const town = a.city || a.town || a.village || a.municipality || "";
    const area = a.suburb || a.city_district || a.neighbourhood || "";
    const detail = [street !== name ? street : "", area, town].filter(Boolean).join(", ");
    const lat = Number(it.lat);
    const lon = Number(it.lon);
    return { name, detail, lat, lon, distance: distanceM(near, { lat, lon }) };
  });
}
