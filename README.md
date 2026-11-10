# Tallinn Transit

A personal transit app for Tallinn, built step by step.

## Data sources
- **Peatus.ee OpenTripPlanner GraphQL API** — stops, departures (with live estimates), line schedules, route shapes, trip planning.
  `https://api.peatus.ee/routing/v1/routers/estonia/index/graphql` (open, no key)
- **Tallinn live vehicle GPS** — `https://transport.tallinn.ee/gps.txt` (CSV, ~10 s updates)

## Steps
1. ✅ Stop search and next departures
2. ✅ Map with live vehicles
3. Select a line → route trajectory + its vehicles
4. Line schedule tables
5. Route planner with transfers

## Live site
https://musa800.github.io/AcrossTransit/

## Code layout
- `js/peatus.js`, `js/vehicles.js`, `js/net.js` — data only (reusable, e.g. in Across Town)
- `js/map.js`, `js/app.js` — screens
