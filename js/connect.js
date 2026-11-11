// The app's own check for faster transfers the planner doesn't offer.
//
// The planner sometimes prefers "stay on the bus and walk" over a quick
// transfer. So for the first few trips, the app takes the first ride and,
// for each stop that ride passes, asks the planner: "from this stop, leaving
// when the bus gets here, what's the fastest way on?" (no transfer margin,
// 5 km/h). If getting off there gets you to the destination earlier, the two
// pieces are joined into one trip. With less than two minutes to spare at the
// transfer it's labelled Tight transfer.
//
// Network calls come in through ctx, so joinTrip/transferSpare can be tested alone.

import { getTripsStoptimes } from "./peatus.js?v=38";

const MAX_TRIPS = 3;        // check the first ride of this many trips
const MAX_STOPS = 8;        // at most this many stops per ride
const MAX_PLANS = 18;       // at most this many planner questions in total
const MIN_GAIN_S = 60;      // must arrive at least a minute earlier
const TIGHT_S = 120;        // less than this to spare = Tight transfer

function localMidnight(unix) {
  const d = new Date(unix * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/** The ride's map line, cut at the point closest to where you get off. */
function cutPoints(points, stop) {
  if (!points.length) return points;
  let best = 0;
  let bestD = Infinity;
  points.forEach(([lat, lon], i) => {
    const d = (lat - stop.lat) ** 2 + ((lon - stop.lon) * 0.5) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return points.slice(0, best + 1);
}

/** Seconds to spare at the first transfer of a trip (null if it has no transfer). */
export function transferSpare(trip) {
  let prev = null;
  let walk = 0;
  for (const l of trip.legs) {
    if (!l.transit) {
      if (prev) walk += l.duration || 0;
      continue;
    }
    if (prev) return l.start - prev.end - walk;
    prev = l;
  }
  return null;
}

/**
 * Join: the original trip up to its first ride, that ride cut short at stop
 * index k of its stop times, then the planner's trip from that stop.
 */
export function joinTrip(orig, rideIndex, times, a, k, sub) {
  const ride = orig.legs[rideIndex];
  const x = times[k];
  const cut = {
    ...ride,
    end: x.arr,
    duration: x.arr - ride.start,
    stops: k - a,
    passStops: times.slice(a + 1, k).map((t) => ({ gtfsId: t.stopId, name: t.name, lat: t.lat, lon: t.lon })),
    to: { name: x.name, lat: x.lat, lon: x.lon, stop: { gtfsId: x.stopId } },
    toStop: x.stopId,
    points: cutPoints(ride.points || [], x),
  };
  const legs = [...orig.legs.slice(0, rideIndex), cut, ...sub.legs];
  const start = legs[0].start;
  const end = sub.end;
  const trip = { ...orig, legs, start, end, duration: end - start, walkDistance: (orig.walkDistance || 0), ownCheck: true };
  const spare = transferSpare(trip);
  trip.tight = spare != null && spare < TIGHT_S;
  return trip;
}

/**
 * Look for faster transfers along the first ride of the first few trips.
 * ctx: { to: {lat, lon}, planFrom: async ([{ from, when }]) => trips per request, keep: trip => bool }
 * Returns the extra trips.
 */
export async function findBetterTransfers(trips, ctx, stats = {}) {
  stats.rides = 0;
  stats.asked = 0;
  stats.better = 0;

  // 1) The first ride of the first few trips (each bus run once).
  const rides = [];
  const seen = new Set();
  for (const trip of trips) {
    if (rides.length >= MAX_TRIPS) break;
    const idx = trip.legs.findIndex((l) => l.transit);
    if (idx < 0) continue;
    const ride = trip.legs[idx];
    if (!ride.tripId || !ride.fromStop || !ride.toStop) continue;
    const key = `${ride.tripId}|${ride.start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rides.push({ trip, idx, ride });
  }
  stats.rides = rides.length;
  if (!rides.length) return [];

  // 2) The stops each ride passes, with times (one request).
  const times = await getTripsStoptimes(rides.map((r) => ({ tripId: r.ride.tripId, serviceDay: localMidnight(r.ride.start) })));

  // 3) One planner question per stop passed (one request).
  const asks = []; // { r, a, k }
  rides.forEach((r, n) => {
    const t = times[n] || [];
    const a = t.findIndex((s) => s.stopId === r.ride.fromStop && Math.abs(s.dep - r.ride.start) < 120);
    const b = t.findIndex((s, i) => i > a && s.stopId === r.ride.toStop);
    if (a < 0 || b < 0) return;
    r.times = t;
    r.a = a;
    for (let k = a + 1; k < b && k <= a + MAX_STOPS; k++) asks.push({ r, a, k });
  });
  const limited = asks.slice(0, MAX_PLANS);
  stats.asked = limited.length;
  if (!limited.length) return [];
  const results = await ctx.planFrom(
    limited.map(({ r, k }) => ({ from: { lat: r.times[k].lat, lon: r.times[k].lon }, to: ctx.to, when: new Date(r.times[k].arr * 1000) }))
  );

  // 4) Join the ones that get there earlier.
  const extra = [];
  limited.forEach(({ r, a, k }, i) => {
    for (const sub of results[i] || []) {
      const firstRide = sub.legs.find((l) => l.transit);
      if (!firstRide) continue; // walking the rest is what the planner already compared
      if (firstRide.routeId === r.ride.routeId) continue; // just staying on the same line
      if (sub.end > r.trip.end - MIN_GAIN_S) continue; // not faster
      const joined = joinTrip(r.trip, r.idx, r.times, a, k, sub);
      if (ctx.keep && !ctx.keep(joined)) continue;
      extra.push(joined);
    }
  });
  stats.better = extra.length;
  return extra;
}
