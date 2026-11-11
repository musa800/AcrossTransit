# Tallinn Transit

A personal transit app for Tallinn, built step by step.

## Data sources
- **Peatus.ee OpenTripPlanner GraphQL API** — stops, departures (with live estimates), line schedules, route shapes, trip planning.
  `https://api.peatus.ee/routing/v1/routers/estonia/index/graphql` (open, no key)
- **OpenStreetMap Nominatim** — address and place search for the planner (≤ 1 request/second)
- **Tallinn live vehicle GPS** — `https://transport.tallinn.ee/gps.txt` (CSV, ~10 s updates)

## Steps
1. ✅ Stop search and next departures
2. ✅ Map with live vehicles
3. ✅ Select a stop/line → route trajectory + its vehicles
4. ✅ Line schedule at a stop (whole day)
5. ✅ Route planner with transfers (Plan tab)

## Data for the app's own planner
Built every night by `.github/workflows/site.yml` (runs `tools/build_data.py` on GitHub's machine)
and published with the site under `data/` — not stored in the repository:
- `day-YYYYMMDD.json.gz` timetables (Tallinn city, Harju county, Tartu city + county, Elron) for today + 7 days
- `stops.json.gz`, `walk-harju.json.gz` + `walk-tartu.json.gz` (walking networks from OpenStreetMap), `transfers.json.gz` (stop-to-stop walks)
- `report.json` (what was built, any problems)

Pushes to main only publish code and keep the current data. Settings → Pages → Source must be "GitHub Actions".

## Live site
https://musa800.github.io/AcrossTransit/

## Code layout
- `js/peatus.js`, `js/vehicles.js`, `js/net.js` — data only (reusable, e.g. in Across Town)
- `js/map.js`, `js/app.js` — screens

## Updating
When changing any JS or CSS file, bump the `?v=` number everywhere
(index.html and the `import` lines in js/) **and** `VERSION` in sw.js,
so browsers and the installed app load the new code.
