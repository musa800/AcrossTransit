// The app's own check for tight connections the planner won't offer.
//
// For each planned trip with a transfer (ride 1 → walk → ride 2), look at the
// other trips of the same two lines around that time, at the same stops. Any
// combination where ride 1 gets you to the transfer stop with less than two
// minutes to spare (but still in time, at the walking time the planner
// calculated) becomes an extra trip, labelled Tight transfer.
//
// Pure planning logic is in buildTightTrips (no network), so it can be tested.

import { getDeparturesInWindows, getTripsStoptimes } from "./peatus.js?v=30";

const WINDOW_S = 90 * 60;   // look at trips up to 90 min before the planned ones
const WALK_SPEED = 5 / 3.6; // m/s
const DETOUR = 1.3;         // straight line → walking path (corners, crossings)

function distanceM(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const MAX_SPARE_S = 120;    // only combinations the planner would have called too tight
const MAX_TRIPS_PER_LINE = 8;

/** Index of a trip's first ride, the walking after it, and the second ride. */
function transferParts(it) {
  const rides = [];
  it.legs.forEach((l, i) => l.transit && rides.push(i));
  if (rides.length < 2) return null;
  const [i1, i2] = rides;
  const r1 = it.legs[i1];
  const r2 = it.legs[i2];
  if (!r1.fromStop || !r1.toStop || !r2.fromStop || !r2.toStop || !r1.routeId || !r2.routeId) return null;
  const plannerWalk = it.legs.slice(i1 + 1, i2).reduce((sum, l) => sum + (l.duration || 0), 0);
  // Our own estimate: straight line between the stops + 30%, at 5 km/h. Use the shorter one.
  let ownWalk = plannerWalk;
  if (r1.to?.lat != null && r2.from?.lat != null) {
    ownWalk = Math.round((distanceM(r1.to, r2.from) * DETOUR) / WALK_SPEED);
  }
  const walk = Math.min(plannerWalk, ownWalk);
  return { i1, i2, r1, r2, walk, plannerWalk };
}

function shift(leg, by) {
  return { ...leg, start: leg.start + by, end: leg.end + by };
}

/** A ride leg rebuilt from a trip's stop times between two stops. */
function rideFrom(orig, times, fromStop, toStop) {
  const a = times.findIndex((t) => t.stopId === fromStop);
  if (a < 0) return null;
  const b = times.findIndex((t, k) => k > a && t.stopId === toStop);
  if (b < 0) return null;
  const between = times.slice(a + 1, b);
  return {
    ...orig,
    start: times[a].dep,
    end: times[b].arr,
    duration: times[b].arr - times[a].dep,
    stops: b - a,
    passStops: between.map((t) => ({ gtfsId: t.stopId, name: t.name, lat: t.lat, lon: t.lon })),
  };
}

/**
 * Build the extra trips.
 * trip: a planned trip; parts: transferParts(trip);
 * line1 / line2: [{ times }] trips of the first and second line (stop times);
 * limits: { earliestStart, latestEnd } (Unix s, either may be null).
 */
export function buildTightTrips(trip, parts, line1, line2, limits, stats = null) {
  const { i1, i2, r1, r2, walk, plannerWalk = walk } = parts;
  const scale = plannerWalk > 0 ? walk / plannerWalk : 1;
  const out = [];
  const pre = trip.legs.slice(0, i1);
  const post = trip.legs.slice(i2 + 1);
  const postHasRide = post.some((l) => l.transit);

  // Second-line options: every trip of line 2 that runs from its boarding stop to its stop.
  const seconds = line2.map((t) => rideFrom(r2, t.times, r2.fromStop, r2.toStop)).filter(Boolean);
  const firsts = line1.map((t) => rideFrom(r1, t.times, r1.fromStop, r1.toStop)).filter(Boolean);

  for (const ride2 of seconds) {
    // The latest first-line trip that still makes it, with less than 2 min to spare.
    let best = null;
    for (const ride1 of firsts) {
      const spare = ride2.start - (ride1.end + walk);
      // Remember the closest miss/fit, for the Search line.
      if (stats && spare > -600 && spare < MAX_SPARE_S &&
          (stats.closest == null || Math.abs(spare) < Math.abs(stats.closest))) stats.closest = spare;
      if (spare < 0 || spare >= MAX_SPARE_S) continue;
      if (!best || ride1.start > best.start) best = ride1;
    }
    if (!best) continue;
    if (best.start === r1.start && ride2.start === r2.start) continue; // the planner's own trip

    const legs = [];
    const by1 = best.start - r1.start;
    for (const l of pre) legs.push(shift(l, by1));
    legs.push(best);
    let t = best.end;
    for (const l of trip.legs.slice(i1 + 1, i2)) {
      const d = Math.round((l.duration || 0) * scale);
      legs.push({ ...l, start: t, end: t + d, duration: d });
      t += d;
    }
    legs.push(ride2);
    if (postHasRide) {
      // Later rides stay as they are; walks before the next ride follow ride 2.
      let k = 0;
      let tt = ride2.end;
      while (k < post.length && !post[k].transit) {
        legs.push({ ...post[k], start: tt, end: tt + (post[k].duration || 0) });
        tt += post[k].duration || 0;
        k++;
      }
      for (; k < post.length; k++) legs.push(post[k]);
    } else {
      const by2 = ride2.end - r2.end;
      for (const l of post) legs.push(shift(l, by2));
    }

    const start = legs[0].start;
    const end = legs[legs.length - 1].end;
    if (limits.earliestStart != null && start < limits.earliestStart) continue;
    if (limits.latestEnd != null && end > limits.latestEnd) continue;
    out.push({ ...trip, legs, start, end, duration: end - start, tight: true, ownCheck: true });
  }
  return out;
}

/**
 * Find extra tight trips for a list of planned trips.
 * limits: { earliestStart, latestEnd }. Returns the extra trips (may contain duplicates of each other).
 */
export async function findTightConnections(trips, limits, stats = {}) {
  stats.checked = 0;
  stats.runs1 = 0;
  stats.runs2 = 0;
  stats.walk = null;
  stats.plannerWalk = null;
  stats.closest = null;
  const jobs = [];
  const seen = new Set();
  for (const trip of trips) {
    const parts = transferParts(trip);
    if (!parts) continue;
    const { r1, r2 } = parts;
    const key = `${r1.routeId}|${r1.fromStop}|${r1.toStop}|${r2.routeId}|${r2.fromStop}|${r2.toStop}|${r2.start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    jobs.push({ trip, parts });
  }
  stats.checked = jobs.length;
  if (!jobs.length) return [];

  // 1) Trips of each line at its boarding stop around the planned times (one request).
  const windows = [];
  for (const { parts } of jobs) {
    const { r1, r2 } = parts;
    windows.push({ stopId: r1.fromStop, start: r1.start - WINDOW_S, range: WINDOW_S + (r2.start - r1.start) + 60 });
    windows.push({ stopId: r2.fromStop, start: r2.start - WINDOW_S, range: WINDOW_S + 60 });
  }
  const deps = await getDeparturesInWindows(windows);

  // 2) Stop times of the matching trips (one request).
  const wanted = [];
  const wantedIndex = new Map();
  const pick = (list, routeId) => {
    const ids = [];
    for (const d of list) {
      if (d.routeId !== routeId) continue;
      if (!wantedIndex.has(d.tripId + "|" + d.serviceDay)) {
        wantedIndex.set(d.tripId + "|" + d.serviceDay, wanted.length);
        wanted.push({ tripId: d.tripId, serviceDay: d.serviceDay });
      }
      ids.push(wantedIndex.get(d.tripId + "|" + d.serviceDay));
      if (ids.length >= MAX_TRIPS_PER_LINE) break;
    }
    return ids;
  };
  const picks = jobs.map(({ parts }, k) => ({
    line1: pick(deps[2 * k], parts.r1.routeId),
    line2: pick(deps[2 * k + 1], parts.r2.routeId),
  }));
  if (!wanted.length) return [];
  const times = await getTripsStoptimes(wanted);

  // 3) Combine.
  const extra = [];
  jobs.forEach(({ trip, parts }, k) => {
    const line1 = picks[k].line1.map((i) => ({ times: times[i] }));
    const line2 = picks[k].line2.map((i) => ({ times: times[i] }));
    stats.runs1 += line1.length;
    stats.runs2 += line2.length;
    if (stats.walk == null || parts.walk < stats.walk) {
      stats.walk = parts.walk;
      stats.plannerWalk = parts.plannerWalk;
    }
    extra.push(...buildTightTrips(trip, parts, line1, line2, limits, stats));
  });
  return extra;
}
