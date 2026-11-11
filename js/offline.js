// The app's own trip planner, working entirely on the phone.
//
// Data (built every night on GitHub, see tools/build_data.py) is downloaded
// once and kept on the phone:
//   data/report.json, stops.json.gz, transfers.json.gz,
//   data/day-YYYYMMDD.json.gz (one per day), data/walk-<area>.json.gz
//
// Planning uses the Connection Scan Algorithm: every departure of the day,
// in time order, keeping the earliest arrival at every stop. Walking to the
// first stop, between stops and from the last stop uses the real paths from
// OpenStreetMap at 5 km/h, with no transfer margin; transfers with less than
// two minutes to spare are labelled tight.

import { decodePolyline } from "./peatus.js?v=39";

const BASE = "data/";
const CACHE = "acrosstransit-data-v1";
const WALK_SPEED = 5 / 3.6;     // m/s
const ACCESS_M = 1200;          // walk at most this far to the first / from the last stop
const SEED_M = 150;             // a point joins the walking network at nodes this close (straight line)
const SEED_NODES = 8;
const STOP_SNAP_M = 60;         // a stop joins the walking network at nodes this close
const FALLBACK_DETOUR = 1.3;    // outside the walking maps: straight line + 30%
const TIGHT_S = 120;
const MAX_RESULTS = 5;
// Choosing where to get on (and off) the same bus: normally leave as late as
// possible (and arrive as early as possible), but prefer a stop that saves at
// least PREFER_WALK_S of walking if it costs at most PREFER_TIME_S.
const PREFER_WALK_S = 3 * 60;
const PREFER_TIME_S = 5 * 60;
const WALK_ONLY_M = 2000;       // also offer walking all the way up to this distance
const SEARCH_WINDOW_S = 3 * 3600;
const DAY = 86400;

const HOUR = 3600 * 1000;
const MAX_AGE = { report: 0, stops: 24 * HOUR, transfers: 24 * HOUR, day: 12 * HOUR, walk: 7 * 24 * HOUR, shapes: 7 * 24 * HOUR };

// ---------------------------------------------------------------- downloading and keeping files

async function openCache() {
  try {
    return await caches.open(CACHE);
  } catch {
    return null; // storage unavailable: files are just downloaded each time
  }
}

/** A data file's bytes: from the phone if fresh enough, otherwise downloaded (and kept). */
async function getFile(name, maxAge) {
  const url = new URL(BASE + name, location.href).href;
  const cache = await openCache();
  let hit = null;
  if (cache) {
    hit = await cache.match(url);
    if (hit) {
      const age = Date.now() - Number(hit.headers.get("x-fetched") || 0);
      if (age < maxAge || !navigator.onLine) return hit.arrayBuffer();
    }
  }
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    if (cache) {
      await cache.put(url, new Response(buf, { headers: { "x-fetched": String(Date.now()) } })).catch(() => {});
    }
    return buf;
  } catch (err) {
    if (hit) return hit.arrayBuffer(); // offline or failed: use the kept copy, however old
    throw err;
  }
}

async function gunzipJson(buf) {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text());
}

/** Remove kept day files for days that have passed. */
async function dropOldDays(todayYmd) {
  const cache = await openCache();
  if (!cache) return;
  for (const req of await cache.keys()) {
    const m = req.url.match(/day-(\d{8})\.json\.gz$/);
    if (m && m[1] < todayYmd) await cache.delete(req);
  }
}

// ---------------------------------------------------------------- data in memory

let report = null;
let stops = null;        // [{ id, name, code, desc, lat, lon }]
let stopIndex = null;    // national stop id -> index
let transfers = null;    // per stop: [[to stop, metres], ...]
const days = new Map();  // yyyymmdd -> prepared day
const areas = new Map(); // area name -> prepared walking network (or a promise)

function ymdOf(date) {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
}

function localMidnight(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function metres(aLat, aLon, bLat, bLon) {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad;
  const dLon = (bLon - aLon) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function loadBasics() {
  if (!report) report = JSON.parse(new TextDecoder().decode(await getFile("report.json", MAX_AGE.report)));
  if (!stops) {
    const raw = await gunzipJson(await getFile("stops.json.gz", MAX_AGE.stops));
    stops = raw.map(([id, name, code, desc, lat, lon]) => ({ id, name, code, desc, lat, lon }));
    stopIndex = new Map(stops.map((s, i) => [s.id, i]));
  }
  if (!transfers) transfers = (await gunzipJson(await getFile("transfers.json.gz", MAX_AGE.transfers))).walks_m;
}

/** A day's timetable, turned into departures ("connections") sorted by time. */
async function loadDay(ymd) {
  if (days.has(ymd)) return days.get(ymd);
  const d = await gunzipJson(await getFile(`day-${ymd}.json.gz`, MAX_AGE.day));
  let n = 0;
  for (const t of d.trips) n += d.patterns[t[1]].length - 1;
  const dep = new Int32Array(n), arr = new Int32Array(n), from = new Int32Array(n), to = new Int32Array(n);
  const trip = new Int32Array(n), seq = new Int32Array(n);
  let k = 0;
  d.trips.forEach((t, ti) => {
    const pat = d.patterns[t[1]];
    const prof = d.profiles[t[2]];
    let a = t[3];
    let dp = a + prof[0];
    for (let i = 1; i < pat.length; i++) {
      const ai = dp + prof[2 * i - 1];
      dep[k] = dp; arr[k] = ai; from[k] = pat[i - 1]; to[k] = pat[i]; trip[k] = ti; seq[k] = i - 1;
      k++;
      dp = ai + prof[2 * i];
    }
  });
  // Sort by departure time.
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((x, y) => dep[x] - dep[y]);
  const pick = (src) => { const out = new Int32Array(n); for (let i = 0; i < n; i++) out[i] = src[order[i]]; return out; };
  const day = {
    ymd, raw: d,
    dep: pick(dep), arr: pick(arr), from: pick(from), to: pick(to), trip: pick(trip), seq: pick(seq),
    count: n,
    tlt: d.trips.map((t) => /tallinna linnatransport/i.test(d.agencies[d.routes[t[0]][3]] || "")),
  };
  // Each trip's connections in stop order (to choose where to get on and off).
  day.tripConns = d.trips.map((t) => new Int32Array(d.patterns[t[1]].length - 1));
  for (let c = 0; c < n; c++) day.tripConns[day.trip[c]][day.seq[c]] = c;
  days.set(ymd, day);
  return day;
}

// ---------------------------------------------------------------- route lines (road shapes)

let shapes = null;          // encoded lines, or false if unavailable
const decoded = new Map();  // shape index -> [[lat, lon], ...]

async function loadShapes() {
  if (shapes !== null) return shapes;
  try {
    shapes = (await gunzipJson(await getFile("shapes.json.gz", MAX_AGE.shapes))).shapes || false;
  } catch {
    shapes = false; // draw rides stop to stop instead
  }
  return shapes;
}

function shapeLine(i) {
  let line = decoded.get(i);
  if (!line) decoded.set(i, (line = decodePolyline(shapes[i])));
  return line;
}

/**
 * The road line of a ride from stop i0 to stop i1 of a pattern, or null if
 * there's no shape (then the ride is drawn stop to stop).
 */
function ridePoints(raw, p, i0, i1) {
  if (!shapes || !raw.pshape) return null;
  const si = raw.pshape[p];
  const pos = raw.pstops?.[p];
  if (si == null || si < 0 || !pos || !pos[i0] || !pos[i1]) return null;
  const line = shapeLine(si);
  const [s0, f0] = pos[i0];
  const [s1, f1] = pos[i1];
  if (s1 < s0 || s1 >= line.length - 1 + (f1 === 0 ? 1 : 0)) return null;
  const at = (seg, f) => {
    const a = line[seg], b = line[Math.min(seg + 1, line.length - 1)];
    const t = f / 1000;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };
  const pts = [at(s0, f0)];
  for (let k = s0 + 1; k <= s1; k++) pts.push(line[k]);
  pts.push(at(s1, f1));
  return pts;
}

// ---------------------------------------------------------------- walking networks

function areaFor(lat, lon) {
  for (const r of report?.regions || []) {
    const [a, b, c, d] = r.bbox;
    if (lat >= a && lat <= c && lon >= b && lon <= d) return r;
  }
  return null;
}

async function loadArea(region) {
  if (areas.has(region.name)) return areas.get(region.name);
  const p = (async () => {
    const w = await gunzipJson(await getFile(region.file, MAX_AGE.walk));
    const n = w.lat.length;
    const lat = new Float64Array(n), lon = new Float64Array(n);
    let la = 0, lo = 0;
    for (let i = 0; i < n; i++) {
      la += w.lat[i]; lo += w.lon[i];
      lat[i] = la / 1e5; lon[i] = lo / 1e5;
    }
    const m = w.from.length;
    const deg = new Int32Array(n + 1);
    for (let e = 0; e < m; e++) { deg[w.from[e] + 1]++; deg[w.to[e] + 1]++; }
    for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
    const fill = deg.slice(0, n);
    const nbr = new Int32Array(2 * m), len = new Float32Array(2 * m), edge = new Int32Array(2 * m);
    for (let e = 0; e < m; e++) {
      const a = w.from[e], b = w.to[e], l = w.len_dm[e] / 10;
      nbr[fill[a]] = b; len[fill[a]] = l; edge[fill[a]++] = e;
      nbr[fill[b]] = a; len[fill[b]] = l; edge[fill[b]++] = e;
    }
    // Grid for finding nearby nodes.
    const cell = 0.002;
    const grid = new Map();
    for (let i = 0; i < n; i++) {
      const key = Math.floor(lat[i] / cell) * 100000 + Math.floor(lon[i] / cell);
      let list = grid.get(key);
      if (!list) grid.set(key, (list = []));
      list.push(i);
    }
    const area = { name: region.name, n, lat, lon, off: deg, nbr, len, edge, from: w.from, to: w.to, geom: w.geom, grid, cell };
    // Stops in this area, joined to nearby nodes.
    area.nodeStops = new Map();
    stops.forEach((s, si) => {
      for (const [d, node] of nearNodes(area, s.lat, s.lon, STOP_SNAP_M, 4)) {
        let list = area.nodeStops.get(node);
        if (!list) area.nodeStops.set(node, (list = []));
        list.push([si, d]);
      }
    });
    return area;
  })();
  areas.set(region.name, p);
  try {
    return await p;
  } catch (err) {
    areas.delete(region.name);
    throw err;
  }
}

function nearNodes(area, la, lo, radius, max) {
  const r = Math.ceil(radius / 111000 / area.cell) + 1;
  const ci = Math.floor(la / area.cell), cj = Math.floor(lo / area.cell);
  const out = [];
  for (let di = -r; di <= r; di++) {
    for (let dj = -2 * r; dj <= 2 * r; dj++) {
      const list = area.grid.get((ci + di) * 100000 + (cj + dj));
      if (!list) continue;
      for (const i of list) {
        const d = metres(la, lo, area.lat[i], area.lon[i]);
        if (d <= radius) out.push([d, i]);
      }
    }
  }
  out.sort((x, y) => x[0] - y[0]);
  return out.slice(0, max);
}

/** Small binary heap of [cost, node]. */
class Heap {
  constructor() { this.c = []; this.v = []; }
  get size() { return this.c.length; }
  push(cost, val) {
    const c = this.c, v = this.v;
    let i = c.length;
    c.push(cost); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (c[p] <= cost) break;
      c[i] = c[p]; v[i] = v[p]; i = p;
    }
    c[i] = cost; v[i] = val;
  }
  pop() {
    const c = this.c, v = this.v;
    const top = [c[0], v[0]];
    const lc = c.pop(), lv = v.pop();
    if (c.length) {
      let i = 0;
      const n = c.length;
      for (;;) {
        let s = 2 * i + 1;
        if (s >= n) break;
        if (s + 1 < n && c[s + 1] < c[s]) s++;
        if (c[s] >= lc) break;
        c[i] = c[s]; v[i] = v[s]; i = s;
      }
      c[i] = lc; v[i] = lv;
    }
    return top;
  }
}

/**
 * Walk the network from a point (seeded from nearby nodes, straight line to
 * them). Returns { dist: Map node->metres, prev: Map node->[node, edge] }.
 * stopAt(node) may return true to stop early.
 */
function walkFrom(area, la, lo, limit, stopAt = null) {
  const dist = new Map(), prev = new Map();
  const heap = new Heap();
  for (const [d, node] of nearNodes(area, la, lo, SEED_M, SEED_NODES)) {
    if (d < (dist.get(node) ?? Infinity)) {
      dist.set(node, d);
      prev.set(node, [-1, -1]);
      heap.push(d, node);
    }
  }
  while (heap.size) {
    const [d, node] = heap.pop();
    if (d > (dist.get(node) ?? Infinity)) continue;
    if (stopAt && stopAt(node, d)) break;
    for (let k = area.off[node]; k < area.off[node + 1]; k++) {
      const m = area.nbr[k];
      const nd = d + area.len[k];
      if (nd <= limit && nd < (dist.get(m) ?? Infinity)) {
        dist.set(m, nd);
        prev.set(m, [node, area.edge[k]]);
        heap.push(nd, m);
      }
    }
  }
  return { dist, prev };
}

/** Walking distance (m) from a point to every stop within ACCESS_M. Map stop -> metres. */
async function stopsReachable(pt) {
  const out = new Map();
  const region = areaFor(pt.lat, pt.lon);
  if (region) {
    try {
      const area = await loadArea(region);
      const { dist } = walkFrom(area, pt.lat, pt.lon, ACCESS_M);
      for (const [node, d] of dist) {
        for (const [si, sd] of area.nodeStops.get(node) || []) {
          const total = d + sd;
          if (total <= ACCESS_M && total < (out.get(si) ?? Infinity)) out.set(si, total);
        }
      }
      if (out.size) return out;
    } catch {
      /* fall back to straight lines */
    }
  }
  stops.forEach((s, si) => {
    if (Math.abs(s.lat - pt.lat) > 0.015) return;
    const m = metres(pt.lat, pt.lon, s.lat, s.lon) * FALLBACK_DETOUR;
    if (m <= ACCESS_M) out.set(si, m);
  });
  return out;
}

/** The walking path between two points, as [[lat, lon]...] and its length, or a straight line. */
async function walkPath(a, b) {
  const straight = { points: [[a.lat, a.lon], [b.lat, b.lon]], metres: metres(a.lat, a.lon, b.lat, b.lon) * FALLBACK_DETOUR };
  const region = areaFor(a.lat, a.lon);
  if (!region) return straight;
  let area;
  try {
    area = await loadArea(region);
  } catch {
    return straight;
  }
  const targets = new Map(nearNodes(area, b.lat, b.lon, SEED_M, SEED_NODES).map(([d, n]) => [n, d]));
  if (!targets.size) return straight;
  let best = null;
  const limit = Math.max(2500, straight.metres * 2);
  const { prev } = walkFrom(area, a.lat, a.lon, limit, (node, d) => {
    if (best && d > best.total) return true;
    if (targets.has(node)) {
      const total = d + targets.get(node);
      if (!best || total < best.total) best = { node, total };
    }
    return false;
  });
  if (!best) return straight;
  // Rebuild the path, including each link's shape.
  const pts = [[b.lat, b.lon]];
  let node = best.node;
  while (node >= 0) {
    pts.push([area.lat[node], area.lon[node]]);
    const [p, e] = prev.get(node) || [-1, -1];
    if (p < 0) break;
    const g = area.geom[e];
    if (g && g.length) {
      // Shape is stored from the link's "from" end; walk it in the right direction.
      const shape = [];
      let x = Math.round(area.lat[area.from[e]] * 1e5), y = Math.round(area.lon[area.from[e]] * 1e5);
      for (let i = 0; i < g.length; i += 2) {
        x += g[i]; y += g[i + 1];
        shape.push([x / 1e5, y / 1e5]);
      }
      if (area.from[e] === p) shape.reverse();
      pts.push(...shape);
    }
    node = p;
  }
  pts.push([a.lat, a.lon]);
  pts.reverse();
  return { points: pts, metres: best.total };
}

// ---------------------------------------------------------------- Connection Scan

/**
 * Earliest arrival from access stops (Map stop -> seconds of day when you get
 * there) to the egress stops (Map stop -> seconds of walking to the destination).
 */
function scan(day, startS, access, egress, cityOnly) {
  const nS = stops.length;
  // ready: earliest time you can be at a stop to board (walking from the start, or by ride).
  // byRide: earliest arrival at a stop by a ride (+ a walk after it); trips end only from these,
  // so a stop you could walk to from the start doesn't hide the buses that go there.
  const ready = new Float64Array(nS).fill(Infinity);
  const byRide = new Float64Array(nS).fill(Infinity);
  const inConn = new Int32Array(nS).fill(-1);
  const inWalk = new Int32Array(nS).fill(-1);
  const boarded = new Int32Array(day.raw.trips.length).fill(-1);
  for (const [s, t] of access) ready[s] = t;
  let best = Infinity, bestStop = -1;
  const consider = (s) => {
    const e = egress.get(s);
    if (e !== undefined && byRide[s] + e < best) {
      best = byRide[s] + e;
      bestStop = s;
    }
  };

  // First departure at or after the start.
  let lo = 0, hi = day.count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (day.dep[mid] < startS) lo = mid + 1; else hi = mid;
  }
  for (let c = lo; c < day.count; c++) {
    const d = day.dep[c];
    if (d >= best) break;
    const t = day.trip[c];
    if (cityOnly && !day.tlt[t]) continue;
    if (boarded[t] < 0) {
      if (ready[day.from[c]] > d) continue;
      boarded[t] = c;
    }
    const s = day.to[c];
    const a = day.arr[c];
    if (a < byRide[s]) {
      byRide[s] = a;
      inConn[s] = c;
      inWalk[s] = -1;
      if (a < ready[s]) ready[s] = a;
      consider(s);
      for (const [s2, m] of transfers[s] || []) {
        const a2 = a + m / WALK_SPEED;
        if (a2 < byRide[s2]) {
          byRide[s2] = a2;
          inConn[s2] = -1;
          inWalk[s2] = s;
          if (a2 < ready[s2]) ready[s2] = a2;
          consider(s2);
        }
      }
    }
  }
  if (bestStop < 0) return null;

  // Walk back from the last stop to the start. At each boarding stop, prefer
  // having walked there from the start (fewer transfers) when that was in time.
  const parts = []; // { ride: [boardConn, alightConn] } or { walk: [fromStop, toStop] } or { access: stop }
  let s = bestStop;
  let viaRide = true; // the last stop was reached by a ride (or a walk after one)
  for (let guard = 0; guard < 50; guard++) {
    if (viaRide && inConn[s] >= 0) {
      const c = inConn[s];
      const b = boarded[day.trip[c]];
      parts.push({ ride: [b, c] });
      s = day.from[b];
      const walkedIn = access.has(s) && access.get(s) <= day.dep[b];
      viaRide = !walkedIn && byRide[s] <= day.dep[b];
      if (!viaRide) {
        parts.push({ access: s });
        break;
      }
    } else if (viaRide && inWalk[s] >= 0) {
      parts.push({ walk: [inWalk[s], s] });
      s = inWalk[s];
    } else {
      parts.push({ access: s });
      break;
    }
  }
  parts.reverse();
  return { parts, lastStop: bestStop, arrival: best };
}

// ---------------------------------------------------------------- building trips for the screen

const MODE_OF = { BUS: "BUS", TRAM: "TRAM", TROLLEYBUS: "TROLLEYBUS", RAIL: "RAIL", FERRY: "FERRY", SUBWAY: "SUBWAY" };

function stopPlace(si) {
  const s = stops[si];
  return { name: s.name, lat: s.lat, lon: s.lon, stop: { gtfsId: s.id } };
}

async function buildTrip(day, midnight, result, from, to) {
  await loadShapes();
  const legs = [];
  const raw = day.raw;
  const walkLeg = async (a, b, start, metresGuess) => {
    const path = await walkPath(a, b);
    const m = path.metres || metresGuess;
    const dur = Math.round(m / WALK_SPEED);
    return { transit: false, mode: "WALK", start, end: start + dur, duration: dur, distance: m, from: a, to: b, points: path.points };
  };
  let t = null;
  for (const p of result.parts) {
    if (p.access !== undefined) {
      continue; // the first walk is added once the first ride's time is known
    }
    if (p.walk) {
      const [a, b] = p.walk;
      legs.push(await walkLeg(stopPlace(a), stopPlace(b), t, 0));
      t = legs[legs.length - 1].end;
      continue;
    }
    const [bc, ac] = p.ride;
    const ti = day.trip[bc];
    const tr = raw.trips[ti];
    const route = raw.routes[tr[0]];
    const pat = raw.patterns[tr[1]];
    const i0 = day.seq[bc], i1 = day.seq[ac] + 1;
    const leg = {
      transit: true,
      mode: MODE_OF[route[2]] || "BUS",
      line: route[0],
      headsign: raw.headsigns[tr[4]] || "",
      operator: raw.agencies[route[3]] || "",
      routeId: `own:${tr[0]}`,
      tripId: "",
      fromStop: stops[pat[i0]].id,
      toStop: stops[pat[i1]].id,
      start: midnight + day.dep[bc],
      end: midnight + day.arr[ac],
      duration: day.arr[ac] - day.dep[bc],
      distance: 0,
      from: stopPlace(pat[i0]),
      to: stopPlace(pat[i1]),
      stops: i1 - i0,
      passStops: pat.slice(i0 + 1, i1).map((si) => ({ gtfsId: stops[si].id, name: stops[si].name, lat: stops[si].lat, lon: stops[si].lon })),
      points: ridePoints(raw, tr[1], i0, i1) || pat.slice(i0, i1 + 1).map((si) => [stops[si].lat, stops[si].lon]),
    };
    if (legs.length === 0) {
      // First walk: leave just in time for the first ride.
      const first = await walkLeg(from, leg.from, 0, 0);
      first.start = leg.start - first.duration;
      first.end = leg.start;
      legs.push(first);
    }
    legs.push(leg);
    t = leg.end;
  }
  if (legs.length === 0) return null;
  legs.push(await walkLeg(stopPlace(result.lastStop), to, t, 0));
  // Leave out zero-length walks (start or end at the stop itself).
  const kept = legs.filter((l) => l.transit || l.distance > 5);
  const start = kept[0].start, end = kept[kept.length - 1].end;
  const trip = {
    start, end, duration: end - start,
    walkDistance: kept.filter((l) => !l.transit).reduce((s, l) => s + l.distance, 0),
    legs: kept,
    source: "offline",
  };
  // Tight if any transfer leaves less than two minutes.
  let prev = null, walk = 0;
  for (const l of kept) {
    if (!l.transit) { if (prev) walk += l.duration; continue; }
    if (prev && l.start - prev.end - walk < TIGHT_S) trip.tight = true;
    prev = l;
    walk = 0;
  }
  return trip;
}

// ---------------------------------------------------------------- where to get on and off

/** Pick an option: best by `score` (higher = better), but prefer much less walking if it costs little. */
function pickStop(cands, score) {
  if (!cands.length) return null;
  let base = cands[0];
  for (const c of cands) {
    if (score(c) > score(base) || (score(c) === score(base) && c.walk < base.walk)) base = c;
  }
  let alt = null;
  for (const c of cands) {
    if (c.walk <= base.walk - PREFER_WALK_S && score(c) >= score(base) - PREFER_TIME_S) {
      if (!alt || c.walk < alt.walk || (c.walk === alt.walk && score(c) > score(alt))) alt = c;
    }
  }
  return alt || base;
}

/**
 * For the trip's first bus, choose the stop to get on; for its last bus (when
 * you walk straight from it to the destination), the stop to get off.
 * access / egress: Map stop -> walking seconds. Limits: earliest leave, latest arrival (seconds of day).
 */
function chooseStops(day, r, accessS, egressS, minLeave, maxArrive) {
  const parts = r.parts;
  const rides = parts.map((p, i) => (p.ride ? i : -1)).filter((i) => i >= 0);
  if (!rides.length) return r;
  const out = { ...r, parts: parts.map((p) => ({ ...p })) };

  // Get off: last ride, if nothing but the final walk comes after it.
  const li = rides[rides.length - 1];
  if (li === parts.length - 1) {
    const [b, c] = out.parts[li].ride;
    const conns = day.tripConns[day.trip[c]];
    const cands = [];
    for (let k = day.seq[b]; k < conns.length; k++) {
      const cc = conns[k];
      const e = egressS.get(day.to[cc]);
      if (e === undefined) continue;
      const arrive = day.arr[cc] + e;
      if (arrive > maxArrive) continue;
      cands.push({ conn: cc, walk: e, arrive });
    }
    const pick = pickStop(cands, (x) => -x.arrive);
    if (pick) {
      out.parts[li].ride = [b, pick.conn];
      out.lastStop = day.to[pick.conn];
      out.arrival = pick.arrive;
    }
  }

  // Get on: first ride, if you walk to it from the start.
  const fi = rides[0];
  if (fi > 0 && out.parts[fi - 1].access !== undefined) {
    const [b, c] = out.parts[fi].ride;
    const conns = day.tripConns[day.trip[c]];
    const cands = [];
    for (let k = 0; k <= day.seq[c]; k++) {
      const cc = conns[k];
      const a = accessS.get(day.from[cc]);
      if (a === undefined) continue;
      const leave = day.dep[cc] - a;
      if (leave < minLeave) continue;
      cands.push({ conn: cc, walk: a, leave });
    }
    const pick = pickStop(cands, (x) => x.leave);
    if (pick) {
      out.parts[fi].ride = [pick.conn, c];
      out.parts[fi - 1] = { access: day.from[pick.conn] };
    }
  }
  return out;
}

// ---------------------------------------------------------------- public

/** True if the phone can run the offline planner at all. */
export function offlineSupported() {
  return typeof DecompressionStream === "function" && typeof caches !== "undefined";
}

/**
 * Plan trips. from/to: { lat, lon, name }, when: Date, arriveBy: bool, cityOnly: bool.
 * onStatus(text) gets progress messages. Returns { trips, info }.
 */
export async function planOffline(from, to, when, arriveBy, cityOnly, onStatus = () => {}) {
  const t0 = performance.now();
  onStatus("Loading offline data…");
  await loadBasics();
  const ymd = ymdOf(when);
  dropOldDays(ymdOf(new Date())).catch(() => {});
  if (!report.days?.some((d) => d.date === ymd)) {
    return { trips: [], info: `no offline timetable for ${ymd.slice(6)}.${ymd.slice(4, 6)}` };
  }
  const [day, access, egress] = await Promise.all([loadDay(ymd), stopsReachable(from), stopsReachable(to)]);
  const midnight = localMidnight(when);
  const nowS = Math.floor(when.getTime() / 1000) - midnight;
  onStatus("Planning…");

  const accessAt = (startS) => new Map([...access].map(([s, m]) => [s, startS + m / WALK_SPEED]));
  const egressS = new Map([...egress].map(([s, m]) => [s, m / WALK_SPEED]));

  const results = [];
  const seen = new Set();
  // Earliest arrival, then again leaving a little later each time, for several options.
  let startS = arriveBy ? nowS - SEARCH_WINDOW_S : nowS;
  const limitS = arriveBy ? nowS : nowS + SEARCH_WINDOW_S;
  const accessS = new Map([...access].map(([s, m]) => [s, m / WALK_SPEED]));
  const minLeave = arriveBy ? -Infinity : nowS - 60;
  const maxArrive = arriveBy ? limitS : Infinity;
  for (let round = 0; round < 16 && results.length < (arriveBy ? 12 : MAX_RESULTS); round++) {
    const found = scan(day, startS, accessAt(startS), egressS, cityOnly);
    if (!found) break;
    const r = chooseStops(day, found, accessS, egressS, minLeave, maxArrive);
    const firstRide = r.parts.find((p) => p.ride);
    if (!firstRide) break; // walking is quicker: no trip needed
    const boardS = day.dep[firstRide.ride[0]];
    if (!arriveBy && boardS > limitS) break;
    if (arriveBy && r.arrival > limitS) break;
    // Same bus runs = the same trip, whichever stop you get on at.
    const key = r.parts.filter((p) => p.ride).map((p) => day.trip[p.ride[0]]).join("|");
    if (!seen.has(key)) {
      seen.add(key);
      results.push(r);
    }
    // Next search: leave so as to catch a departure after this one's first bus
    // (counted from where the scan boarded it, so the same bus isn't found again).
    const scanRide = found.parts.find((p) => p.ride);
    const firstStop = day.from[scanRide.ride[0]];
    startS = Math.max(startS + 60, day.dep[scanRide.ride[0]] - (access.get(firstStop) ?? 0) / WALK_SPEED + 60);
  }
  let chosen = results;
  if (arriveBy) chosen = results.filter((r) => r.arrival <= limitS).slice(-MAX_RESULTS);
  const trips = [];
  for (const r of chosen) {
    const trip = await buildTrip(day, midnight, r, from, to);
    if (trip) trips.push(trip);
  }
  // Walking all the way, if it's not far.
  const direct = await walkPath(from, to);
  if (direct.metres <= WALK_ONLY_M) {
    const dur = Math.round(direct.metres / WALK_SPEED);
    const start = arriveBy ? midnight + nowS - dur : midnight + nowS;
    trips.push({
      start, end: start + dur, duration: dur, walkDistance: direct.metres, source: "offline",
      legs: [{ transit: false, mode: "WALK", start, end: start + dur, duration: dur, distance: direct.metres, from, to, points: direct.points }],
    });
  }
  const ms = Math.round(performance.now() - t0);
  const built = report.generated ? new Date(report.generated).toLocaleString("et-EE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "?";
  return { trips, info: `offline: ${trips.length} trips in ${ms} ms, data from ${built}, ${access.size}/${egress.size} stops in walking range` };
}

// ---------------------------------------------------------------- the map without internet
//
// Stops, departures, lines and schedules from the offline timetable, in the
// same shapes the online functions in peatus.js return. Stops from here have
// ids "off:<n>" so the app knows they're from the offline data.

const OFF = "off:";

function offStop(i, extra = {}) {
  const s = stops[i];
  return { gtfsId: OFF + i, name: s.name, code: s.code, desc: s.desc, lat: s.lat, lon: s.lon, offline: true, ...extra };
}

/** True for stops that came from the offline timetable. */
export function isOfflineStop(stop) {
  return !!stop && String(stop.gtfsId || "").startsWith(OFF);
}

/** The days the offline timetable covers: Set of "yyyymmdd". */
export async function offlineDays() {
  await loadBasics();
  return new Set((report.days || []).map((d) => d.date));
}

/** Stops in a box (from the offline data); the list is marked .offline. */
export async function offlineStopsInBox(box) {
  await loadBasics();
  const out = [];
  stops.forEach((s, i) => {
    if (s.lat >= box.minLat && s.lat <= box.maxLat && s.lon >= box.minLon && s.lon <= box.maxLon) out.push(offStop(i));
  });
  out.offline = true;
  return out;
}

const norm = (t) => String(t || "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * The offline stop for a stop on the map: itself if it came from here,
 * otherwise the same code, else the nearest one with the same name (within
 * 80 m), else the nearest within 25 m. -1 if none.
 */
async function matchStop(stop) {
  await loadBasics();
  if (isOfflineStop(stop)) return Number(stop.gtfsId.slice(OFF.length));
  const name = norm(stop.name);
  let byCode = -1, byName = -1, byPos = -1, dName = 80, dPos = 25;
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i];
    if (Math.abs(s.lat - stop.lat) > 0.001) continue;
    const d = metres(stop.lat, stop.lon, s.lat, s.lon);
    if (d > 150) continue;
    if (stop.code && s.code && s.code === stop.code) byCode = i;
    if (norm(s.name) === name && d < dName) { dName = d; byName = i; }
    if (d < dPos) { dPos = d; byPos = i; }
  }
  return byCode >= 0 ? byCode : byName >= 0 ? byName : byPos;
}

function routeInfo(raw, ri) {
  const r = raw.routes[ri];
  return { shortName: r[0], mode: MODE_OF[r[2]] || "BUS", operator: raw.agencies[r[3]] || "" };
}

/** Day files for today and tomorrow (if kept or downloadable), with their midnights. */
async function nearDays(now) {
  const out = [];
  for (let k = 0; k < 2; k++) {
    const d = new Date(now);
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() + k);
    const ymd = ymdOf(d);
    if (!report.days?.some((x) => x.date === ymd)) continue;
    try {
      out.push({ day: await loadDay(ymd), midnight: localMidnight(d), later: k > 0 });
    } catch {
      /* not kept on this phone */
    }
  }
  if (!out.length) throw new Error("no offline timetable kept for today");
  return out;
}

/** First connection index departing at or after s. */
function firstAt(day, s) {
  let lo = 0, hi = day.count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (day.dep[mid] < s) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Departures from a set of stop indices, soonest first: [{ time, si, trip, day }]. */
function departuresFrom(daysList, set, nowUnix, count, keep) {
  const out = [];
  for (const { day, midnight, later } of daysList) {
    const raw = day.raw;
    for (let c = firstAt(day, nowUnix - midnight - 30); c < day.count && out.length < count; c++) {
      if (!set.has(day.from[c])) continue;
      const tr = raw.trips[day.trip[c]];
      if (later && tr[3] < 0) continue; // started the day before: already in that day's file
      if (keep && !keep(raw, tr)) continue;
      out.push({ time: midnight + day.dep[c], si: day.from[c], tr, raw });
    }
    if (out.length >= count) break;
  }
  return out;
}

function toDeparture(d, extra = {}) {
  const info = routeInfo(d.raw, d.tr[0]);
  return {
    time: d.time,
    realtime: false,
    headsign: d.raw.headsigns[d.tr[4]] || "",
    line: info.shortName,
    mode: info.mode,
    operator: info.operator,
    ...extra,
  };
}

const sameLine = (line) => (raw, tr) => {
  const r = raw.routes[tr[0]];
  return r[0] === line.shortName && (MODE_OF[r[2]] || "BUS") === line.mode;
};

/** Lines (routes) that leave from these stops on these days. */
function linesAt(daysList, set) {
  const seen = new Map();
  for (const { day } of daysList) {
    const raw = day.raw;
    const pats = new Set();
    raw.patterns.forEach((pat, p) => {
      for (let i = 0; i < pat.length - 1; i++) if (set.has(pat[i])) { pats.add(p); break; }
    });
    for (const tr of raw.trips) {
      if (!pats.has(tr[1])) continue;
      const info = routeInfo(raw, tr[0]);
      seen.set(`${info.mode}|${info.shortName}`, info);
    }
  }
  return [...seen.values()];
}

/**
 * Like getStopDepartures / getStopLineDepartures, from the offline timetable.
 * line: { mode, shortName } or null. Returns { routes, departures }.
 */
export async function offlineStopDepartures(stop, line = null, count = 20) {
  const si = await matchStop(stop);
  if (si < 0) throw new Error("this stop isn't in the offline timetable");
  const now = Math.floor(Date.now() / 1000);
  const daysList = await nearDays(new Date());
  const set = new Set([si]);
  const deps = departuresFrom(daysList, set, now, count, line ? sameLine(line) : null).map((d) => toDeparture(d));
  return { routes: linesAt(daysList, set), departures: deps };
}

/**
 * Like getStopPatterns / getStopsPatterns: the routes through these stops,
 * drawn along the road where a route line is known.
 * Returns [{ code, line, mode, operator, headsign, points, stops }].
 */
export async function offlinePatterns(stopList) {
  await loadBasics();
  await loadShapes();
  const idx = [];
  for (const s of stopList) {
    const i = await matchStop(s);
    if (i >= 0) idx.push(i);
  }
  const set = new Set(idx);
  const { day } = (await nearDays(new Date()))[0];
  const raw = day.raw;
  const heads = new Map(); // pattern -> { route, headsign counts }
  raw.trips.forEach((tr) => {
    const p = tr[1];
    let h = heads.get(p);
    if (!h) {
      const pat = raw.patterns[p];
      let through = false;
      for (let i = 0; i < pat.length; i++) if (set.has(pat[i])) { through = true; break; }
      if (!through) { heads.set(p, null); return; }
      heads.set(p, (h = { route: tr[0], counts: new Map() }));
    }
    if (h) h.counts.set(tr[4], (h.counts.get(tr[4]) || 0) + 1);
  });
  const out = [];
  for (const [p, h] of heads) {
    if (!h) continue;
    const pat = raw.patterns[p];
    const info = routeInfo(raw, h.route);
    const hs = [...h.counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const si = raw.pshape?.[p];
    const points = shapes && si != null && si >= 0 ? shapeLine(si) : pat.map((i) => [stops[i].lat, stops[i].lon]);
    out.push({
      code: `off:${p}`,
      line: info.shortName,
      mode: info.mode,
      operator: info.operator,
      headsign: raw.headsigns[hs] || "",
      points,
      stops: pat.map((i) => offStop(i)),
    });
  }
  return out.filter((p) => p.points.length > 1);
}

/** Like getNearbyDepartures, from the offline data. */
export async function offlineNearby(pos, radius = 200, count = 20) {
  await loadBasics();
  const near = [];
  stops.forEach((s, i) => {
    if (Math.abs(s.lat - pos.lat) > 0.01) return;
    const d = metres(pos.lat, pos.lon, s.lat, s.lon);
    if (d <= radius) near.push(offStop(i, { distance: d }));
  });
  if (!near.length) return { stops: near, departures: [], offline: true };
  const byIdx = new Map(near.map((s) => [Number(s.gtfsId.slice(OFF.length)), s]));
  const daysList = await nearDays(new Date());
  const now = Math.floor(Date.now() / 1000);
  const deps = departuresFrom(daysList, new Set(byIdx.keys()), now, count * near.length, null)
    .map((d) => toDeparture(d, { stop: byIdx.get(d.si) }));
  return { stops: near, departures: deps, offline: true };
}

/** Like getStopLineSchedule, from the offline data. Returns [{ secs, time, headsign }]. */
export async function offlineSchedule(stop, mode, line, date) {
  const si = await matchStop(stop);
  if (si < 0) throw new Error("this stop isn't in the offline timetable");
  const ymd = ymdOf(date);
  if (!report.days?.some((x) => x.date === ymd)) throw new Error("no offline timetable for that day");
  const day = await loadDay(ymd);
  const raw = day.raw;
  const midnight = localMidnight(date);
  const want = sameLine({ mode, shortName: line });
  const rows = [];
  raw.trips.forEach((tr, ti) => {
    if (tr[3] < 0 || !want(raw, tr)) return; // started the day before: that day's schedule
    const conns = day.tripConns[ti];
    for (let k = 0; k < conns.length; k++) {
      const c = conns[k];
      if (day.from[c] !== si) continue;
      rows.push({ secs: day.dep[c], time: midnight + day.dep[c], headsign: raw.headsigns[tr[4]] || "" });
    }
  });
  rows.sort((a, b) => a.secs - b.secs);
  return rows;
}

/**
 * Keep the offline data up to date on the phone, so the map and planner work
 * without internet: the timetable days, stops, route lines and the walking map
 * of the area you're in. Runs at most once a day; files still fresh are skipped.
 */
const PREFETCH_KEY = "acrosstransit.offlinePrefetch";
export async function prefetchOffline(pos) {
  if (!offlineSupported() || !navigator.onLine) return;
  const today = ymdOf(new Date());
  try {
    if (localStorage.getItem(PREFETCH_KEY) === today) return;
  } catch {
    /* fine: just fetch */
  }
  await loadBasics();
  await loadShapes();
  for (const d of report.days || []) {
    if (d.date < today) continue;
    await getFile(`day-${d.date}.json.gz`, MAX_AGE.day).catch(() => {});
  }
  const region = pos ? areaFor(pos.lat, pos.lon) : null;
  if (region) await getFile(region.file, MAX_AGE.walk).catch(() => {});
  dropOldDays(today).catch(() => {});
  try {
    localStorage.setItem(PREFETCH_KEY, today);
  } catch {
    /* fetched again next time */
  }
}
