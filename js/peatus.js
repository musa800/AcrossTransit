// Data: Peatus.ee OpenTripPlanner GraphQL API (stops, departures, routes).
// No screen code here, so this file can be reused in other apps.

import { fetchChecked } from "./net.js?v=27";

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
/** Distance in metres between two { lat, lon } points. */
export function distanceM(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Stops anywhere in Estonia whose name matches.
 * near ({ lat, lon }, optional): adds `distance` (metres) and sorts nearest first.
 */
export async function searchStops(name, near = null) {
  const data = await gql(
    `query ($name: String!) {
       stops(name: $name) { gtfsId name code desc lat lon }
     }`,
    { name }
  );
  const stops = data.stops || [];
  if (near) {
    for (const s of stops) s.distance = distanceM(near, s);
    stops.sort((a, b) => a.distance - b.distance);
  }
  return stops;
}

export function inTallinnArea(p) {
  return inTallinn(p);
}

/** Every stop inside the Tallinn box (loaded once for the map). */
/** Stops inside a box { minLat, minLon, maxLat, maxLon } (anywhere in Estonia). */
export async function getStopsInBox(box) {
  const data = await gql(
    `query ($minLat: Float!, $minLon: Float!, $maxLat: Float!, $maxLon: Float!) {
       stopsByBbox(minLat: $minLat, minLon: $minLon, maxLat: $maxLat, maxLon: $maxLon) {
         gtfsId name code desc lat lon
       }
     }`,
    box
  );
  return data.stopsByBbox || [];
}

/** True if an operator name is Tallinna Linnatransport. */
export function isTlt(operatorName) {
  return /tallinna linnatransport/i.test(operatorName || "");
}

let otherAgenciesPromise = null;

/** Ids of every operator except Tallinna Linnatransport (looked up once). */
export function getNonTltAgencyIds() {
  if (!otherAgenciesPromise) {
    otherAgenciesPromise = gql(`{ agencies { gtfsId name } }`).then((data) =>
      (data.agencies || []).filter((a) => !isTlt(a.name)).map((a) => a.gtfsId)
    );
    otherAgenciesPromise.catch(() => (otherAgenciesPromise = null)); // allow a retry later
  }
  return otherAgenciesPromise;
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
 *   { transit, mode, line, headsign, operator, start, end, distance, duration,
 *     from: {name, lat, lon}, to: {name, lat, lon}, stops, points }
 */
export async function planTrip(from, to, when, arriveBy = false, options = {}) {
  const { bannedAgencies = null, count = 5 } = options;
  // Optional settings are only added to the query when used, so a server
  // that doesn't know one of them only fails the search that asked for it.
  const extraVars = [];
  const extraArgs = [];
  const extraValues = {};
  if (bannedAgencies) {
    extraVars.push("$banned: String!");
    extraArgs.push("banned: { agencies: $banned }");
    extraValues.banned = bannedAgencies;
  }
  // Optional numeric settings, each added only when given.
  const OPTIONAL = { walkSpeed: "Float", minTransferTime: "Int", boardSlack: "Int", alightSlack: "Int" };
  for (const [name, type] of Object.entries(OPTIONAL)) {
    if (options[name] == null) continue;
    extraVars.push(`$${name}: ${type}!`);
    extraArgs.push(`${name}: $${name}`);
    extraValues[name] = options[name];
  }
  const varsDecl = extraVars.length ? ", " + extraVars.join(", ") : "";
  const argsUse = extraArgs.length ? ", " + extraArgs.join(", ") : "";
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
  const time = `${pad(when.getHours())}:${pad(when.getMinutes())}:00`;
  const data = await gql(
    `query ($from: InputCoordinates!, $to: InputCoordinates!, $date: String!, $time: String!,
            $arriveBy: Boolean!, $count: Int!${varsDecl}) {
       plan(from: $from, to: $to, date: $date, time: $time, arriveBy: $arriveBy,
            numItineraries: $count${argsUse}) {
         itineraries {
           startTime endTime duration walkDistance
           legs {
             mode startTime endTime distance duration
             route { shortName mode agency { name } }
             trip { tripHeadsign }
             from { name lat lon }
             to { name lat lon }
             intermediateStops { gtfsId name lat lon }
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
      count,
      ...extraValues,
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
      operator: l.route?.agency?.name || "",
      start: Math.round(l.startTime / 1000),
      end: Math.round(l.endTime / 1000),
      distance: l.distance || 0,
      duration: l.duration || 0,
      from: l.from,
      to: l.to,
      stops: (l.intermediateStops || []).length + 1,
      passStops: l.intermediateStops || [],
      points: decodePolyline(l.legGeometry?.points || ""),
    })),
  }));
}

// ---------- Near me ----------

/**
 * Next departures from all stops within `radius` metres of a position,
 * combined and sorted soonest first.
 * Returns { stops: [stop with distance], departures: [departure + stop] }.
 */
export async function getNearbyDepartures(pos, radius = 200, count = 20) {
  const dLat = radius / 111320;
  const dLon = radius / (111320 * Math.cos((pos.lat * Math.PI) / 180));
  const inBox = await getStopsInBox({
    minLat: pos.lat - dLat,
    maxLat: pos.lat + dLat,
    minLon: pos.lon - dLon,
    maxLon: pos.lon + dLon,
  });
  const stops = inBox
    .map((s) => ({ ...s, distance: distanceM(pos, s) }))
    .filter((s) => s.distance <= radius);
  if (!stops.length) return { stops, departures: [] };

  const data = await gql(
    `query ($ids: [String], $n: Int!) {
       stops(ids: $ids) {
         gtfsId
         stoptimesWithoutPatterns(numberOfDepartures: $n, omitNonPickups: true) {
           serviceDay scheduledDeparture realtimeDeparture realtime headsign
           trip { route { shortName mode } }
         }
       }
     }`,
    { ids: stops.map((s) => s.gtfsId), n: count }
  );
  const byId = new Map(stops.map((s) => [s.gtfsId, s]));
  const departures = [];
  for (const st of data.stops || []) {
    const stop = byId.get(st.gtfsId);
    if (!stop) continue;
    for (const d of st.stoptimesWithoutPatterns || []) {
      departures.push({
        time: d.serviceDay + (d.realtime ? d.realtimeDeparture : d.scheduledDeparture),
        realtime: !!d.realtime,
        headsign: d.headsign || "",
        line: d.trip?.route?.shortName || "?",
        mode: d.trip?.route?.mode || "OTHER",
        stop,
      });
    }
  }
  departures.sort((a, b) => a.time - b.time);
  // All of them (up to `count` per stop): the screen shows the first 20,
  // or the first 20 of one line when a line is chosen.
  return { stops, departures };
}

/**
 * The routes (patterns) through several stops, without duplicates:
 * [{ code, line, mode, headsign, points, stops }].
 */
export async function getStopsPatterns(stopIds) {
  if (!stopIds.length) return [];
  const data = await gql(
    `query ($ids: [String]) {
       stops(ids: $ids) {
         patterns {
           code headsign
           route { shortName mode }
           patternGeometry { points }
           stops { gtfsId name code desc lat lon }
         }
       }
     }`,
    { ids: stopIds }
  );
  const seen = new Map();
  for (const st of data.stops || []) {
    for (const p of st.patterns || []) {
      if (seen.has(p.code)) continue;
      const points = decodePolyline(p.patternGeometry?.points || "");
      if (points.length < 2) continue;
      seen.set(p.code, {
        code: p.code,
        line: p.route?.shortName || "?",
        mode: p.route?.mode || "OTHER",
        headsign: p.headsign || "",
        points,
        stops: p.stops || [],
      });
    }
  }
  return [...seen.values()];
}

// ---------- Routes ----------

/** All operators: [{ id, name }], sorted by name. */
export async function getAgencies() {
  const data = await gql(`{ agencies { gtfsId name } }`);
  return (data.agencies || [])
    .map((a) => ({ id: a.gtfsId, name: a.name }))
    .sort((a, b) => a.name.localeCompare(b.name, "et"));
}

function routeRow(r, agencyName) {
  return {
    id: r.gtfsId,
    line: r.shortName || "",
    name: r.longName || "",
    mode: r.mode || "OTHER",
    operator: agencyName ?? r.agency?.name ?? "",
  };
}

/** One operator's routes. */
export async function getAgencyRoutes(agencyId) {
  const data = await gql(
    `query ($id: String!) {
       agency(id: $id) { name routes { gtfsId shortName longName mode } }
     }`,
    { id: agencyId }
  );
  const a = data.agency;
  return (a?.routes || []).map((r) => routeRow(r, a.name));
}

/** Routes whose number or name matches (any operator). */
export async function searchRoutes(text) {
  const data = await gql(
    `query ($name: String!) {
       routes(name: $name) { gtfsId shortName longName mode agency { name } }
     }`,
    { name: text }
  );
  return (data.routes || []).map((r) => routeRow(r));
}

/**
 * A route's directions. For each direction, the variant with the most stops:
 * [{ directionId, headsign, stops: [stop], points: [[lat, lon]] }].
 */
export async function getRouteDirections(routeId) {
  const data = await gql(
    `query ($id: String!) {
       route(id: $id) {
         patterns {
           directionId headsign
           stops { gtfsId name code desc lat lon }
           patternGeometry { points }
         }
       }
     }`,
    { id: routeId }
  );
  const best = new Map();
  for (const p of data.route?.patterns || []) {
    const dir = p.directionId ?? 0;
    const cur = best.get(dir);
    if (!cur || (p.stops || []).length > cur.stops.length) {
      best.set(dir, {
        directionId: dir,
        headsign: p.headsign || (p.stops?.length ? p.stops[p.stops.length - 1].name : ""),
        stops: p.stops || [],
        points: decodePolyline(p.patternGeometry?.points || ""),
      });
    }
  }
  return [...best.values()].sort((a, b) => a.directionId - b.directionId);
}
