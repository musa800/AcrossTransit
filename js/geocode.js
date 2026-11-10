// Data: place and address search via OpenStreetMap's Nominatim service.
// Free to use, with a limit of about one request per second; this module
// waits between requests so the app stays within it.

import { fetchChecked } from "./net.js?v=11";
import { TALLINN } from "./peatus.js?v=11";

const URL_BASE = "https://nominatim.openstreetmap.org/search";
const MIN_GAP_MS = 1100;
let lastRequest = 0;

/** Places in Tallinn matching the text: [{ name, detail, lat, lon }]. */
export async function searchPlaces(text) {
  const wait = lastRequest + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequest = Date.now();

  const params = new URLSearchParams({
    q: text,
    format: "jsonv2",
    limit: "6",
    bounded: "1",
    viewbox: `${TALLINN.minLon},${TALLINN.maxLat},${TALLINN.maxLon},${TALLINN.minLat}`,
    "accept-language": "et,en",
    addressdetails: "1",
  });
  const res = await fetchChecked(`${URL_BASE}?${params}`);
  const items = await res.json();
  return items.map((it) => {
    const a = it.address || {};
    const street = [a.road, a.house_number].filter(Boolean).join(" ");
    const name = it.name || street || it.display_name.split(",")[0];
    const detail = [street !== name ? street : "", a.suburb || a.city_district || a.neighbourhood || ""]
      .filter(Boolean)
      .join(", ");
    return { name, detail, lat: Number(it.lat), lon: Number(it.lon) };
  });
}
