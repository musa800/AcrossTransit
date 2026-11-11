// One fixed colour per line, used everywhere in the app (badges, map lines,
// live buses, planned trips). Each kind of line has its own colour family,
// and each line number always gets the same shade within that family:
//
//   Tallinn city buses  blues        Tartu city buses  teals
//   trams               reds         trolleybuses      greens
//   county buses        oranges      trains            purples
//
// No screen code here, so this file can be reused in other apps.

const FAMILIES = {
  tallinn: { hue: 214, sat: 70, light: [34, 43] },
  tartu:   { hue: 172, sat: 75, light: [23, 30] },
  tram:    { hue: 356, sat: 70, light: [40, 48] },
  trolley: { hue: 134, sat: 55, light: [26, 33] },
  county:  { hue: 24,  sat: 75, light: [32, 38] },
  train:   { hue: 276, sat: 50, light: [38, 46] },
  other:   { hue: 215, sat: 10, light: [38, 44] },
};
const HUE_STEPS = [0, -12, 12, -6, 6]; // shades within a family

const TARTU = { minLat: 58.3, maxLat: 58.43, minLon: 26.6, maxLon: 26.85 };
const SHORT_LINE = /^\d{1,2}[a-zA-Z]?$/; // city lines: 1–99, maybe a letter

// Operators seen running Tartu city lines (learned from lines at Tartu stops),
// so their lines get the Tartu colours also where no stop is known.
const TARTU_KEY = "acrosstransit.tartuOperators";
let tartuOps = null;

function tartuOperators() {
  if (!tartuOps) {
    try {
      tartuOps = new Set(JSON.parse(localStorage.getItem(TARTU_KEY) || "[]"));
    } catch {
      tartuOps = new Set();
    }
  }
  return tartuOps;
}

function learnTartu(operator) {
  const set = tartuOperators();
  if (!operator || set.has(operator)) return;
  set.add(operator);
  try {
    localStorage.setItem(TARTU_KEY, JSON.stringify([...set]));
  } catch {
    /* not remembered */
  }
}

function inTartu(p) {
  return p && p.lat >= TARTU.minLat && p.lat <= TARTU.maxLat && p.lon >= TARTU.minLon && p.lon <= TARTU.maxLon;
}

/**
 * The kind of line: "tallinn", "tartu", "tram", "trolley", "county", "train" or "other".
 * where: optional { lat, lon } of a stop on the line (tells Tartu city buses apart).
 */
export function lineCategory(mode, line, operator = "", where = null) {
  if (mode === "TRAM") return "tram";
  if (mode === "TROLLEYBUS") return "trolley";
  if (mode === "RAIL" || mode === "SUBWAY") return "train";
  if (mode !== "BUS") return "other";
  if (/tallinna linnatransport/i.test(operator)) return "tallinn";
  if (SHORT_LINE.test(String(line).trim())) {
    if (inTartu(where)) {
      learnTartu(operator);
      return "tartu";
    }
    if (!where && operator && tartuOperators().has(operator)) return "tartu";
  }
  return "county";
}

/** A number for a line name, so neighbouring numbers get different shades. */
function lineNumber(line) {
  const s = String(line).trim();
  const digits = parseInt(s.replace(/\D+/g, ""), 10) || 0;
  let extra = 0;
  for (const ch of s.replace(/\d+/g, "")) extra += ch.charCodeAt(0);
  return digits + extra * 7;
}

const cache = new Map();

/** The line's colour (CSS colour string). */
export function lineColor(mode, line, operator = "", where = null) {
  const cat = lineCategory(mode, line, operator, where);
  const key = `${cat}|${line}`;
  let c = cache.get(key);
  if (!c) {
    const f = FAMILIES[cat];
    const n = lineNumber(line);
    const hue = (f.hue + HUE_STEPS[n % HUE_STEPS.length] + 360) % 360;
    const light = f.light[Math.floor(n / HUE_STEPS.length) % f.light.length];
    c = `hsl(${hue} ${f.sat}% ${light}%)`;
    cache.set(key, c);
  }
  return c;
}

/** The colour of a planned trip's ride. */
export function legColor(leg) {
  return lineColor(leg.mode, leg.line, leg.operator || "", leg.from || null);
}
