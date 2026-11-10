// Data: Peatus.ee OpenTripPlanner GraphQL API (stops, departures, routes).
// No screen code here, so this file can be reused in other apps.

import { fetchChecked } from "./net.js?v=4";

const API = "https://api.peatus.ee/routing/v1/routers/estonia/index/graphql";

// Rough box around Tallinn, so "Viru" doesn't return stops elsewhere.
export const TALLINN = { minLat: 59.33, maxLat: 59.53, minLon: 24.5, maxLon: 25.05 };

async function gql(query, variables = {}) {
  const res = await fetchChecked(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(json.errors.map((e) => e.message).join("; "));
  return json.data;
}

function inTallinn(s) {
  return (
    s.lat >= TALLINN.minLat && s.lat <= TALLINN.maxLat &&
    s.lon >= TALLINN.minLon && s.lon <= TALLINN.maxLon
  );
}

/** Stops in Tallinn whose name matches. */
export async function searchStops(name) {
  const data = await gql(
    `query ($name: String!) {
       stops(name: $name) { gtfsId name code desc lat lon }
     }`,
    { name }
  );
  return (data.stops || []).filter(inTallinn);
}

/** Next departures at a stop, plus the lines (routes) that serve it. */
export async function getStopDepartures(stopId, count = 20) {
  const data = await gql(
    `query ($id: String!, $n: Int!) {
       stop(id: $id) {
         routes { shortName mode }
         stoptimesWithoutPatterns(numberOfDepartures: $n, omitNonPickups: true) {
           serviceDay
           scheduledDeparture
           realtimeDeparture
           realtime
           headsign
           trip { route { shortName mode } }
         }
       }
     }`,
    { id: stopId, n: count }
  );
  const stop = data.stop || {};
  return {
    routes: stop.routes || [],
    departures: (stop.stoptimesWithoutPatterns || []).map((d) => ({
      time: d.serviceDay + (d.realtime ? d.realtimeDeparture : d.scheduledDeparture),
      realtime: !!d.realtime,
      headsign: d.headsign || "",
      line: d.trip?.route?.shortName || "?",
      mode: d.trip?.route?.mode || "OTHER",
    })),
  };
}
