// Data: Peatus.ee OpenTripPlanner GraphQL API (stops, departures, routes).
// No screen code here, so this file can be reused in other apps.

import { fetchChecked } from "./net.js?v=11";

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

/** Every stop inside the Tallinn box (loaded once for the map). */
export async function getTallinnStops() {
  const data = await gql(
    `query ($minLat: Float!, $minLon: Float!, $maxLat: Float!, $maxLon: Float!) {
       stopsByBbox(minLat: $minLat, minLon: $minLon, maxLat: $maxLat, maxLon: $maxLon) {
         gtfsId name code desc lat lon
       }
     }`,
    TALLINN
  );
  return data.stopsByBbox || [];
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

/**
 * The routes (patterns) that pass through a stop, with their shape on the map.
 * Returns [{ line, mode, headsign, points: [[lat, lon], ...] }].
 */
export async function getStopPatterns(stopId) {
  const data = await gql(
    `query ($id: String!) {
       stop(id: $id) {
         patterns {
           headsign
           route { shortName mode }
           patternGeometry { points }
           stops { gtfsId name code desc lat lon }
         }
       }
     }`,
    { id: stopId }
  );
  const patterns = data.stop?.patterns || [];
  return patterns
    .map((p) => ({
      line: p.route?.shortName || "?",
      mode: p.route?.mode || "OTHER",
      headsign: p.headsign || "",
      points: decodePolyline(p.patternGeometry?.points || ""),
      stops: p.stops || [],
    }))
    .filter((p) => p.points.length > 1);
}

function sameLine(route, mode, line) {
  return route && route.mode === mode && route.shortName === line;
}

/** Next departures of one line at a stop (all its directions/variants merged). */
export async function getStopLineDepartures(stopId, mode, line, count = 20) {
  const data = await gql(
    `query ($id: String!, $n: Int!) {
       stop(id: $id) {
         stoptimesForPatterns(numberOfDepartures: $n, omitNonPickups: true) {
           pattern { route { shortName mode } }
           stoptimes { serviceDay scheduledDeparture realtimeDeparture realtime headsign }
         }
       }
     }`,
    { id: stopId, n: count }
  );
  const deps = [];
  for (const group of data.stop?.stoptimesForPatterns || []) {
    if (!sameLine(group.pattern?.route, mode, line)) continue;
    for (const d of group.stoptimes || []) {
      deps.push({
        time: d.serviceDay + (d.realtime ? d.realtimeDeparture : d.scheduledDeparture),
        realtime: !!d.realtime,
        headsign: d.headsign || "",
        line,
        mode,
      });
    }
  }
  deps.sort((a, b) => a.time - b.time);
  return deps.slice(0, count);
}

/**
 * One line's whole-day timetable at a stop.
 * date: a JS Date (its local calendar day is used).
 * Returns [{ secs, time, headsign }] sorted, where secs = seconds after the
 * start of the service day (can exceed 24 h for after-midnight trips).
 */
export async function getStopLineSchedule(stopId, mode, line, date) {
  const ymd =
    date.getFullYear() +
    String(date.getMonth() + 1).padStart(2, "0") +
    String(date.getDate()).padStart(2, "0");
  const data = await gql(
    `query ($id: String!, $date: String!) {
       stop(id: $id) {
         stoptimesForServiceDate(date: $date, omitNonPickups: true) {
           pattern { headsign route { shortName mode } }
           stoptimes { serviceDay scheduledDeparture headsign }
         }
       }
     }`,
    { id: stopId, date: ymd }
  );
  const rows = [];
  for (const group of data.stop?.stoptimesForServiceDate || []) {
    if (!sameLine(group.pattern?.route, mode, line)) continue;
    for (const d of group.stoptimes || []) {
      rows.push({
        secs: d.scheduledDeparture,
        time: d.serviceDay + d.scheduledDeparture,
        headsign: d.headsign || group.pattern.headsign || "",
      });
    }
  }
  rows.sort((a, b) => a.secs - b.secs);
  return rows;
}

/** Decode a Google "encoded polyline" string into [[lat, lon], ...]. */
export function decodePolyline(str) {
  const points = [];
  let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    for (const which of [0, 1]) {
      let shift = 0, result = 0, b;
      do {
        b = str.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20 && i < str.length);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta;
      else lon += delta;
    }
    points.push([lat / 1e5, lon / 1e5]);
  }
  return points;
}

/**
 * Plan a trip with transfers.
 * from/to: { lat, lon }; when: JS Date; arriveBy: true = arrive by `when`.
 * Returns itineraries: [{ start, end, duration, walkDistance, legs: [...] }]
 * with times in Unix seconds. Each leg:
 *   { transit, mode, line, headsign, start, end, distance, duration,
 *     from: {name, lat, lon}, to: {name, lat, lon}, stops, points }
 */
export async function planTrip(from, to, when, arriveBy = false) {
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
  const time = `${pad(when.getHours())}:${pad(when.getMinutes())}:00`;
  const data = await gql(
    `query ($from: InputCoordinates!, $to: InputCoordinates!, $date: String!, $time: String!, $arriveBy: Boolean!) {
       plan(from: $from, to: $to, date: $date, time: $time, arriveBy: $arriveBy, numItineraries: 5) {
         itineraries {
           startTime endTime duration walkDistance
           legs {
             mode startTime endTime distance duration
             route { shortName mode }
             trip { tripHeadsign }
             from { name lat lon }
             to { name lat lon }
             intermediateStops { name }
             legGeometry { points }
           }
         }
       }
     }`,
    {
      from: { lat: from.lat, lon: from.lon },
      to: { lat: to.lat, lon: to.lon },
      date,
      time,
      arriveBy,
    }
  );
  return (data.plan?.itineraries || []).map((it) => ({
    start: Math.round(it.startTime / 1000),
    end: Math.round(it.endTime / 1000),
    duration: it.duration,
    walkDistance: it.walkDistance || 0,
    legs: (it.legs || []).map((l) => ({
      transit: !!l.route && !["WALK", "BICYCLE", "CAR"].includes(l.mode),
      mode: l.route?.mode || l.mode,
      line: l.route?.shortName || "",
      headsign: l.trip?.tripHeadsign || "",
      start: Math.round(l.startTime / 1000),
      end: Math.round(l.endTime / 1000),
      distance: l.distance || 0,
      duration: l.duration || 0,
      from: l.from,
      to: l.to,
      stops: (l.intermediateStops || []).length + 1,
      points: decodePolyline(l.legGeometry?.points || ""),
    })),
  }));
}
