#!/usr/bin/env python3
"""
Nightly data build for Across Transit's own planner.

Runs on GitHub's build machine (see .github/workflows/site.yml). It downloads
the official timetables (GTFS) and OpenStreetMap paths, and writes compact,
gzipped files into the website's data/ folder:

  data/report.json        what was built, from which sources, any problems
  data/stops.json.gz      every stop used by the kept lines
  data/day-YYYYMMDD.json.gz  one timetable per day (today + 7 days)
  data/walk-<area>.json.gz  the walking network per area (harju, tartu)
  data/transfers.json.gz  real walking distances between nearby stops
  data/shapes.json.gz     the road line of each route variant (for drawing rides)

Kept lines: Tallinna Linnatransport (Tallinn city), all Harju county lines,
Tartu city and Tartu county lines, and Elron trains (whole network).

Usage:
  python3 tools/build_data.py --out _site/data
  python3 tools/build_data.py --out OUT --gtfs a.zip b.zip --osm map.osm --start 2026-11-12   (tests)
"""

import argparse
import csv
import datetime as dt
import gzip
import heapq
import io
import json
import math
import os
import sys
import time
import urllib.request
import zipfile
from collections import defaultdict

FEEDS = [
    # (name, url, which agencies to keep: None = all, or a lowercase substring)
    ("tallinn", "https://eu-gtfs.remix.com/tallinn.zip", None),
    ("harjumaa", "https://eu-gtfs.remix.com/harjumaa.zip", None),
    ("tartu", "https://eu-gtfs.remix.com/tartu.zip", None),       # Tartu city (name not confirmed)
    ("tartumaa", "https://eu-gtfs.remix.com/tartumaa.zip", None),
    # Elron trains: taken from the all-Estonia file if it's available.
    ("estonia", "https://eu-gtfs.remix.com/estonia_unified_gtfs.zip", "elron"),
]
OSM_URL = "https://download.geofabrik.de/europe/estonia-latest.osm.pbf"

# Walking network areas, each its own file (the phone downloads only what it needs).
# (name, (min lat, min lon, max lat, max lon)) with a small margin.
REGIONS = [
    ("harju", (58.95, 23.30, 59.80, 26.05)),   # Harju county incl. Tallinn
    ("tartu", (58.05, 26.05, 58.80, 27.60)),   # Tartu county incl. Tartu
]

DAYS = 8                 # today + 7 days
TRANSFER_RADIUS_M = 700  # stop-to-stop walks are worked out up to this distance
SNAP_RADIUS_M = 60       # a stop joins the walking network at nodes this close
SNAP_NODES = 4           # ... at most this many of them
SHAPE_TOLERANCE_M = 5    # route lines are simplified to this accuracy
FALLBACK_DETOUR = 1.3    # stops outside the network: straight line + 30%

WALKABLE = {
    "footway", "path", "pedestrian", "steps", "living_street", "residential",
    "service", "unclassified", "tertiary", "tertiary_link", "secondary",
    "secondary_link", "primary", "primary_link", "track", "cycleway",
    "road", "corridor", "platform", "trunk", "trunk_link", "bridleway",
}

report = {"generated": None, "sources": {}, "problems": [], "counts": {}}


def log(*a):
    print(*a, flush=True)


def problem(msg):
    log("PROBLEM:", msg)
    report["problems"].append(msg)


def download(url, tries=3):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "AcrossTransit-build/1.0 (github.com/musa800/AcrossTransit)"})
            with urllib.request.urlopen(req, timeout=300) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(5 * (i + 1))
    raise RuntimeError(f"{url}: {last}")


def metres(lat1, lon1, lat2, lon2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def write_gz(path, obj):
    raw = json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    with gzip.open(path, "wb", compresslevel=9) as f:
        f.write(raw)
    return os.path.getsize(path)


# ---------------------------------------------------------------- GTFS


def read_csv(z, name):
    try:
        with z.open(name) as f:
            text = io.TextIOWrapper(f, encoding="utf-8-sig")
            return list(csv.DictReader(text))
    except KeyError:
        return []


def gtfs_time(s):
    if not s:
        return None
    h, m, sec = s.strip().split(":")
    return int(h) * 3600 + int(m) * 60 + int(sec)


class Timetable:
    """Everything kept from all feeds, with feed-prefixed ids (stops are shared by national id)."""

    def __init__(self):
        self.stops = {}        # stop_id -> dict(name, code, desc, lat, lon)
        self.agencies = {}     # key -> name
        self.routes = {}       # key -> (short, long, mode, agency key, color)
        self.trips = {}        # key -> (route key, service key, headsign, shape key or "")
        self.shapes = {}       # shape key -> [(lat, lon), ...] in order
        self.stop_times = defaultdict(list)  # trip key -> [(seq, stop_id, arr, dep)]
        self.calendar = {}     # service key -> (weekday flags, start, end)
        self.dates = defaultdict(dict)  # service key -> {yyyymmdd: 1 added / 2 removed}

    def add_feed(self, name, data, keep):
        z = zipfile.ZipFile(io.BytesIO(data))
        agencies = read_csv(z, "agency.txt")
        keep_agencies = set()
        for a in agencies:
            aid = a.get("agency_id", "") or "_"
            if keep is None or keep in a.get("agency_name", "").lower():
                keep_agencies.add(aid)
                self.agencies[f"{name}:{aid}"] = a.get("agency_name", "")
        if not keep_agencies:
            problem(f"{name}: no matching agencies")
            return
        routes = {}
        for r in read_csv(z, "routes.txt"):
            aid = r.get("agency_id", "") or (agencies[0].get("agency_id", "") if len(agencies) == 1 else "_") or "_"
            if aid not in keep_agencies:
                continue
            rtype = int(r.get("route_type") or 3)
            mode = {0: "TRAM", 1: "SUBWAY", 2: "RAIL", 3: "BUS", 4: "FERRY", 11: "TROLLEYBUS", 800: "TROLLEYBUS"}.get(rtype, "BUS")
            if 100 <= rtype < 200:
                mode = "RAIL"
            elif 700 <= rtype < 800:
                mode = "BUS"
            elif 900 <= rtype < 1000:
                mode = "TRAM"
            key = f"{name}:{r['route_id']}"
            routes[r["route_id"]] = key
            self.routes[key] = (
                r.get("route_short_name", "") or "",
                r.get("route_long_name", "") or "",
                mode,
                f"{name}:{aid}",
                r.get("route_color", "") or "",
            )
        trips = {}
        for t in read_csv(z, "trips.txt"):
            rk = routes.get(t["route_id"])
            if not rk:
                continue
            key = f"{name}:{t['trip_id']}"
            trips[t["trip_id"]] = key
            shape = t.get("shape_id", "") or ""
            self.trips[key] = (rk, f"{name}:{t['service_id']}", t.get("trip_headsign", "") or "", f"{name}:{shape}" if shape else "")
        used_stops = set()
        n = 0
        with z.open("stop_times.txt") as f:
            for st in csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig")):
                tk = trips.get(st["trip_id"])
                if not tk:
                    continue
                arr = gtfs_time(st.get("arrival_time"))
                dep = gtfs_time(st.get("departure_time"))
                if arr is None and dep is None:
                    continue  # untimed stop: skip (rare)
                arr = dep if arr is None else arr
                dep = arr if dep is None else dep
                self.stop_times[tk].append((int(st["stop_sequence"]), st["stop_id"], arr, dep))
                used_stops.add(st["stop_id"])
                n += 1
        for s in read_csv(z, "stops.txt"):
            if s["stop_id"] in used_stops and s["stop_id"] not in self.stops:
                self.stops[s["stop_id"]] = {
                    "name": s.get("stop_name", ""),
                    "code": s.get("stop_code", "") or "",
                    "desc": s.get("stop_desc", "") or "",
                    "lat": float(s["stop_lat"]),
                    "lon": float(s["stop_lon"]),
                }
        used_shapes = {v[3] for k, v in self.trips.items() if k.startswith(name + ":") and v[3]}
        pts = defaultdict(list)
        try:
            with z.open("shapes.txt") as f:
                for row in csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig")):
                    key = f"{name}:{row['shape_id']}"
                    if key in used_shapes:
                        pts[key].append((int(row["shape_pt_sequence"]), float(row["shape_pt_lat"]), float(row["shape_pt_lon"])))
        except KeyError:
            pass  # no shapes in this feed: rides are drawn stop to stop
        for key, lst in pts.items():
            lst.sort()
            self.shapes[key] = [(la, lo) for _, la, lo in lst]
        report["sources"][name]["shapes"] = len(pts)
        services = {v[1] for v in self.trips.values() if v[1].startswith(name + ":")}
        for c in read_csv(z, "calendar.txt"):
            key = f"{name}:{c['service_id']}"
            if key not in services:
                continue
            days = [c[d] == "1" for d in ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")]
            self.calendar[key] = (days, c["start_date"], c["end_date"])
        for c in read_csv(z, "calendar_dates.txt"):
            key = f"{name}:{c['service_id']}"
            if key in services:
                self.dates[key][c["date"]] = int(c["exception_type"])
        report["sources"][name]["agencies"] = sorted(self.agencies[f"{name}:{a}"] for a in keep_agencies)
        report["sources"][name]["routes"] = len(routes)
        report["sources"][name]["trips"] = len(trips)
        report["sources"][name]["stop_times"] = n

    def runs_on(self, service, ymd, weekday):
        exc = self.dates.get(service, {}).get(ymd)
        if exc == 1:
            return True
        if exc == 2:
            return False
        cal = self.calendar.get(service)
        return bool(cal and cal[1] <= ymd <= cal[2] and cal[0][weekday])


# ---------------------------------------------------------------- route shapes


def simplify(points, tol_m):
    """Douglas-Peucker on a short local projection (metres)."""
    if len(points) < 3:
        return list(points)
    lat0 = points[0][0]
    kx = 111320 * math.cos(math.radians(lat0))
    ky = 110574
    xy = [((lo - points[0][1]) * kx, (la - lat0) * ky) for la, lo in points]
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = xy[a]
        bx, by = xy[b]
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        best, bi = -1.0, -1
        for i in range(a + 1, b):
            px, py = xy[i]
            if L2 == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
                d = math.hypot(px - (ax + t * dx), py - (ay + t * dy))
            if d > best:
                best, bi = d, i
        if best > tol_m:
            keep[bi] = True
            stack.append((a, bi))
            stack.append((bi, b))
    return [p for p, k in zip(points, keep) if k]


def encode_polyline(points):
    """Google encoded polyline (1e-5 degrees), as decoded by the app."""
    out = []
    plat = plon = 0
    for la, lo in points:
        a, b = round(la * 1e5), round(lo * 1e5)
        for v in (a - plat, b - plon):
            v = ~(v << 1) if v < 0 else v << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1F)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        plat, plon = a, b
    return "".join(out)


def stop_positions(line, stop_pts):
    """
    Where each stop sits along a line, in order: [segment index, fraction * 1000]
    per stop. Searches forward from the previous stop, so loops and routes that
    pass a street twice are handled. None if the line doesn't fit the stops.
    """
    lat0 = line[0][0]
    kx = 111320 * math.cos(math.radians(lat0))
    ky = 110574
    xy = [(lo * kx, la * ky) for la, lo in line]
    out = []
    seg0 = 0
    for la, lo in stop_pts:
        px, py = lo * kx, la * ky
        best = None
        for i in range(seg0, len(xy) - 1):
            ax, ay = xy[i]
            bx, by = xy[i + 1]
            dx, dy = bx - ax, by - ay
            L2 = dx * dx + dy * dy
            t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
            d = math.hypot(px - (ax + t * dx), py - (ay + t * dy))
            if best is None or d < best[0] - 0.01:
                best = (d, i, t)
            elif best[0] < 40 and d > best[0] + 400:
                break  # found it close by; don't jump to a later pass of the same street
        if best is None or best[0] > 150:
            return None
        out.append([best[1], round(best[2] * 1000)])
        seg0 = best[1]
    return out


def build_shapes(tt, out_dir):
    """Simplify and write all used shapes; returns (shape key -> index, simplified lines)."""
    keys = sorted({v[3] for v in tt.trips.values() if v[3] and v[3] in tt.shapes})
    index, lines, encoded = {}, [], []
    for k in keys:
        line = simplify(tt.shapes[k], SHAPE_TOLERANCE_M)
        if len(line) < 2:
            continue
        index[k] = len(lines)
        lines.append(line)
        encoded.append(encode_polyline(line))
    size = write_gz(os.path.join(out_dir, "shapes.json.gz"), {"shapes": encoded})
    report["files"]["shapes.json.gz"] = size
    report["counts"]["shapes"] = len(lines)
    log(f"shapes.json.gz: {len(lines)} route lines, {size // 1024} KB")
    return index, lines


def build_days(tt, stop_index, start, out_dir, shape_index=None, shape_lines=None):
    """One file per day. Trips past midnight from the day before are included, shifted by -24 h."""
    route_keys = sorted(tt.routes)
    route_index = {k: i for i, k in enumerate(route_keys)}
    agency_keys = sorted(tt.agencies)
    agency_index = {k: i for i, k in enumerate(agency_keys)}
    routes_out = [
        [tt.routes[k][0], tt.routes[k][1], tt.routes[k][2], agency_index[tt.routes[k][3]], tt.routes[k][4]]
        for k in route_keys
    ]
    agencies_out = [tt.agencies[k] for k in agency_keys]
    ordered = {}
    for tk, sts in tt.stop_times.items():
        sts.sort()
        ordered[tk] = sts

    files = []
    pos_cache = {}
    tt_stops = [tt.stops[sid] for sid in sorted(tt.stops)]  # same order as stop_index
    for d in range(DAYS):
        day = start + dt.timedelta(days=d)
        prev = day - dt.timedelta(days=1)
        patterns, pattern_index = [], {}
        pshape, pstops = [], []  # per pattern: shape index (-1 = none), stop positions along it
        profiles, profile_index = [], {}
        heads, head_index = [], {}
        trips_out = []

        def add(tk, shift):
            sts = ordered.get(tk)
            if not sts or len(sts) < 2:
                return
            rk, _, head, shape = tt.trips[tk]
            seq = tuple(stop_index[s[1]] for s in sts)
            p = pattern_index.get(seq)
            if p is None:
                p = pattern_index[seq] = len(patterns)
                patterns.append(list(seq))
                si, pos = -1, None
                if shape_index is not None and shape in shape_index:
                    si = shape_index[shape]
                    key = (si, seq)
                    pos = pos_cache.get(key, "x")
                    if pos == "x":
                        pos = pos_cache[key] = stop_positions(shape_lines[si], [(tt_stops[i]["lat"], tt_stops[i]["lon"]) for i in seq])
                    if pos is None:
                        si = -1
                pshape.append(si)
                pstops.append(pos or [])
            # Timing profile: dwell at stop 0, then (run, dwell) for each next stop.
            prof = [sts[0][3] - sts[0][2]]
            for i in range(1, len(sts)):
                prof.append(sts[i][2] - sts[i - 1][3])
                prof.append(sts[i][3] - sts[i][2])
            prof = tuple(prof)
            q = profile_index.get(prof)
            if q is None:
                q = profile_index[prof] = len(profiles)
                profiles.append(list(prof))
            h = head_index.get(head)
            if h is None:
                h = head_index[head] = len(heads)
                heads.append(head)
            trips_out.append([route_index[rk], p, q, sts[0][2] + shift, h])

        ymd, pymd = day.strftime("%Y%m%d"), prev.strftime("%Y%m%d")
        for tk, (rk, service, head, _shape) in tt.trips.items():
            if tt.runs_on(service, ymd, day.weekday()):
                add(tk, 0)
            if tt.runs_on(service, pymd, prev.weekday()):
                sts = ordered.get(tk)
                if sts and sts[-1][3] >= 86400:
                    add(tk, -86400)
        trips_out.sort(key=lambda t: t[3])
        name = f"day-{ymd}.json.gz"
        size = write_gz(
            os.path.join(out_dir, name),
            {
                "date": ymd,
                "agencies": agencies_out,
                "routes": routes_out,
                "headsigns": heads,
                "patterns": patterns,
                # per pattern: route line in shapes.json.gz (-1 = none), and each stop's
                # position on it as [segment, fraction * 1000]
                "pshape": pshape,
                "pstops": pstops,
                "profiles": profiles,
                # [route, pattern, profile, first arrival (s after midnight), headsign]
                "trips": trips_out,
            },
        )
        files.append({"file": name, "date": ymd, "trips": len(trips_out), "bytes": size})
        log(f"{name}: {len(trips_out)} trips, {size // 1024} KB")
    return files


# ---------------------------------------------------------------- walking network


def in_box(box, lat, lon):
    return box[0] <= lat <= box[2] and box[1] <= lon <= box[3]


def read_ways(osm_path):
    """Walkable ways per region, from one pass over the OpenStreetMap file."""
    import osmium  # installed in the workflow

    class Ways(osmium.SimpleHandler):
        def __init__(self):
            super().__init__()
            self.ways = {name: [] for name, _ in REGIONS}

        def way(self, w):
            tags = w.tags
            hw = tags.get("highway")
            parking = tags.get("amenity") == "parking" or hw == "service" and tags.get("service") == "parking_aisle"
            if hw not in WALKABLE and not parking and not (tags.get("public_transport") == "platform"):
                return
            if tags.get("foot") in ("no", "private") or tags.get("access") in ("no", "private") and tags.get("foot") not in ("yes", "designated", "permissive"):
                return
            if hw in ("trunk", "trunk_link") and tags.get("foot") not in ("yes", "designated") and tags.get("sidewalk") in (None, "no", "none"):
                return
            pts = []
            for n in w.nodes:
                if not n.location.valid():
                    return
                pts.append((n.ref, n.location.lat, n.location.lon))
            for name, box in REGIONS:
                if not any(in_box(box, p[1], p[2]) for p in pts):
                    continue
                self.ways[name].append(pts)
                # Parking lots: also walk straight across, between opposite corners.
                if parking and len(pts) >= 4 and pts[0][0] == pts[-1][0]:
                    ring = pts[:-1]
                    half = len(ring) // 2
                    for i in range(half):
                        self.ways[name].append([ring[i], ring[i + half]])

    h = Ways()
    h.apply_file(osm_path, locations=True, idx="flex_mem")
    return h.ways


def build_region(name, ways, stops, stop_ids, members, transfers, out_dir):
    """Walking network of one area, and stop-to-stop walks for the stops in it (members)."""
    log(f"[{name}] walkable ways: {len(ways)}")
    use = defaultdict(int)
    for pts in ways:
        for i, p in enumerate(pts):
            use[p[0]] += 2 if i in (0, len(pts) - 1) else 1
    node_id, coords = {}, []

    def nid(p):
        i = node_id.get(p[0])
        if i is None:
            i = node_id[p[0]] = len(coords)
            coords.append((p[1], p[2]))
        return i

    edges = {}  # (a, b) -> (length m, geometry [(lat, lon)...] between a and b)
    for pts in ways:
        start = 0
        for i in range(1, len(pts)):
            if i == len(pts) - 1 or use[pts[i][0]] > 1:
                seg = pts[start:i + 1]
                length = sum(metres(seg[k][1], seg[k][2], seg[k + 1][1], seg[k + 1][2]) for k in range(len(seg) - 1))
                a, b = nid(seg[0]), nid(seg[-1])
                if a != b:
                    key = (min(a, b), max(a, b))
                    mid = [(q[1], q[2]) for q in seg[1:-1]]
                    if a > b:
                        mid.reverse()
                    if key not in edges or edges[key][0] > length:
                        edges[key] = (length, mid)
                start = i
    log(f"[{name}] walking network: {len(coords)} nodes, {len(edges)} links")

    adj = [[] for _ in coords]
    for (a, b), (length, _) in edges.items():
        adj[a].append((b, length))
        adj[b].append((a, length))

    cell = 0.002
    grid = defaultdict(list)
    for i, (la, lo) in enumerate(coords):
        grid[(int(la / cell), int(lo / cell))].append(i)

    def near_nodes(la, lo, radius):
        r = int(radius / 111000 / cell) + 1
        ci, cj = int(la / cell), int(lo / cell)
        out = []
        for di in range(-r, r + 1):
            for dj in range(-2 * r, 2 * r + 1):
                for i in grid.get((ci + di, cj + dj), ()):
                    dd = metres(la, lo, *coords[i])
                    if dd <= radius:
                        out.append((dd, i))
        out.sort()
        return out[:SNAP_NODES]

    snaps = {}
    node_stops = defaultdict(list)  # node -> [(stop index, distance)]
    for si in members:
        s = stops[stop_ids[si]]
        sn = near_nodes(s["lat"], s["lon"], SNAP_RADIUS_M)
        snaps[si] = sn
        for dd, n in sn:
            node_stops[n].append((si, dd))
    unsnapped = []
    for si in members:
        if not snaps[si]:
            unsnapped.append(si)
            continue
        best = {}
        dist = {}
        heap = []
        for dd, n in snaps[si]:
            if dd < dist.get(n, 1e18):
                dist[n] = dd
                heapq.heappush(heap, (dd, n))
        while heap:
            d, n = heapq.heappop(heap)
            if d > dist.get(n, 1e18) or d > TRANSFER_RADIUS_M:
                continue
            for sj, dd in node_stops.get(n, ()):
                total = d + dd
                if sj != si and total <= TRANSFER_RADIUS_M and total < best.get(sj, 1e18):
                    best[sj] = total
            for m, length in adj[n]:
                nd = d + length
                if nd < dist.get(m, 1e18) and nd <= TRANSFER_RADIUS_M:
                    dist[m] = nd
                    heapq.heappush(heap, (nd, m))
        transfers[si] = sorted([sj, round(m)] for sj, m in best.items())

    # Compact walking network: coordinates as 1e-5 degree integers, delta-encoded.
    flat_lat, flat_lon = [], []
    pl = plo = 0
    for la, lo in coords:
        a, b = round(la * 1e5), round(lo * 1e5)
        flat_lat.append(a - pl)
        flat_lon.append(b - plo)
        pl, plo = a, b
    e_from, e_to, e_len, e_geom = [], [], [], []
    for (a, b), (length, mid) in edges.items():
        e_from.append(a)
        e_to.append(b)
        e_len.append(round(length * 10))  # decimetres
        g = []
        pa, pb = round(coords[a][0] * 1e5), round(coords[a][1] * 1e5)
        for la, lo in mid[:: max(1, len(mid) // 8 + 1)] if len(mid) > 16 else mid:
            x, y = round(la * 1e5), round(lo * 1e5)
            g += [x - pa, y - pb]
            pa, pb = x, y
        e_geom.append(g)
    box = dict(REGIONS)[name]
    fname = f"walk-{name}.json.gz"
    size = write_gz(
        os.path.join(out_dir, fname),
        {"area": name, "bbox": box, "lat": flat_lat, "lon": flat_lon,
         "from": e_from, "to": e_to, "len_dm": e_len, "geom": e_geom},
    )
    report["files"][fname] = size
    report["counts"][f"walk_{name}"] = {"nodes": len(coords), "links": len(edges), "stops": len(members), "stops_unsnapped": len(unsnapped)}
    log(f"[{name}] {fname} {size // 1024} KB")
    return unsnapped


def build_walk(osm_path, stops, out_dir):
    stop_ids = list(stops)
    ways = read_ways(osm_path)
    transfers = [[] for _ in stop_ids]
    leftover = []
    assigned = set()
    for name, box in REGIONS:
        members = [si for si, sid in enumerate(stop_ids)
                   if si not in assigned and in_box(box, stops[sid]["lat"], stops[sid]["lon"])]
        assigned.update(members)
        leftover += build_region(name, ways[name], stops, stop_ids, members, transfers, out_dir)
    leftover += [si for si in range(len(stop_ids)) if si not in assigned]

    # Stops with no walking network (outside the areas): straight line + 30%.
    by_lat = sorted(range(len(stop_ids)), key=lambda i: stops[stop_ids[i]]["lat"])
    for si in leftover:
        a = stops[stop_ids[si]]
        for sj in by_lat:
            b = stops[stop_ids[sj]]
            if sj == si or abs(a["lat"] - b["lat"]) > 0.01:
                continue
            m = metres(a["lat"], a["lon"], b["lat"], b["lon"]) * FALLBACK_DETOUR
            if m <= TRANSFER_RADIUS_M:
                transfers[si].append([sj, round(m)])
                transfers[sj].append([si, round(m)])
    for lst in transfers:
        lst.sort()
    # Remove duplicates added in both directions.
    transfers = [[x for k, x in enumerate(lst) if k == 0 or x[0] != lst[k - 1][0]] for lst in transfers]
    report["counts"]["stops_off_network"] = len(leftover)
    size_tr = write_gz(os.path.join(out_dir, "transfers.json.gz"), {"stops": len(stop_ids), "walks_m": transfers})
    report["files"]["transfers.json.gz"] = size_tr
    report["regions"] = [{"name": n, "bbox": b, "file": f"walk-{n}.json.gz"} for n, b in REGIONS]
    log(f"transfers.json.gz {size_tr // 1024} KB")


# ---------------------------------------------------------------- main


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--gtfs", nargs="*", help="local GTFS zips instead of downloading (tests)")
    ap.add_argument("--osm", help="local OSM file instead of downloading (tests)")
    ap.add_argument("--start", help="first day YYYY-MM-DD (default: today in Tallinn)")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    report["generated"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    report["files"] = {}

    if args.start:
        start = dt.date.fromisoformat(args.start)
    else:
        # Tallinn is UTC+2/+3; the build runs at night, so UTC+2 is close enough for "today".
        start = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=2)).date()

    tt = Timetable()
    feeds = [(os.path.basename(p).split(".")[0], None, None) for p in args.gtfs] if args.gtfs else FEEDS
    for i, (name, url, keep) in enumerate(feeds):
        report["sources"][name] = {"url": url or args.gtfs[i]}
        try:
            data = open(args.gtfs[i], "rb").read() if args.gtfs else download(url)
            report["sources"][name]["bytes"] = len(data)
            tt.add_feed(name, data, keep)
        except Exception as e:  # noqa: BLE001
            problem(f"{name}: {e}")
            report["sources"][name]["error"] = str(e)
    if not tt.trips:
        problem("no timetable data at all")
        write_report(args.out)
        sys.exit(1)

    stop_ids = sorted(tt.stops)
    stop_index = {s: i for i, s in enumerate(stop_ids)}
    report["files"]["stops.json.gz"] = write_gz(
        os.path.join(args.out, "stops.json.gz"),
        # [national stop id, name, code, description, lat, lon]
        [[s, tt.stops[s]["name"], tt.stops[s]["code"], tt.stops[s]["desc"], round(tt.stops[s]["lat"], 6), round(tt.stops[s]["lon"], 6)] for s in stop_ids],
    )
    report["counts"]["stops"] = len(stop_ids)
    report["counts"]["routes"] = len(tt.routes)
    try:
        shape_index, shape_lines = build_shapes(tt, args.out)
    except Exception as e:  # noqa: BLE001
        problem(f"shapes: {e}")
        shape_index, shape_lines = None, None
    report["days"] = build_days(tt, stop_index, start, args.out, shape_index, shape_lines)

    try:
        osm = args.osm
        if not osm:
            osm = os.path.join(args.out, "..", "estonia.osm.pbf")
            log("downloading OpenStreetMap…")
            with open(osm, "wb") as f:
                f.write(download(OSM_URL))
        build_walk(osm, {s: tt.stops[s] for s in stop_ids}, args.out)
        if not args.osm:
            os.remove(osm)
    except Exception as e:  # noqa: BLE001
        problem(f"walking network: {e}")

    write_report(args.out)
    log("done")


def write_report(out):
    with open(os.path.join(out, "report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
