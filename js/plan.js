// Screen: the Plan tab — choose start and destination (search, map tap or
// my location), depart/arrive time, then trip options with transfers.

import { searchStops, planTrip, getNonTltAgencyIds, isTlt, inTallinnArea } from "./peatus.js?v=18";
import { searchPlaces } from "./geocode.js?v=18";
import {
  setPlanEndpoints, setPlanTapHandler, openPopupAt, closeMapPopup,
  fitPoints, showItinerary, clearItinerary, colorsForLegs, getCenter,
} from "./map.js?v=18";
import { lineKey } from "./vehicles.js?v=18";

const MODES = ["BUS", "TROLLEYBUS", "TRAM", "RAIL"];
const $ = (id) => document.getElementById(id);

const ends = { from: null, to: null }; // { name, lat, lon }
let itineraries = [];
let planRun = 0;          // ignore answers from older searches
let onLayoutChange = () => {};

// ---------- Small helpers ----------

function clock(unix) {
  return new Date(unix * 1000).toLocaleTimeString("et-EE", { hour: "2-digit", minute: "2-digit" });
}

function minutes(seconds) {
  return Math.max(1, Math.round(seconds / 60));
}

function metres(m) {
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  if (m < 10000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m / 1000)} km`;
}

function modeName(mode) {
  return { BUS: "Bus", TROLLEYBUS: "Trolleybus", TRAM: "Tram", RAIL: "Train", FERRY: "Ferry" }[mode] || "Ride";
}

function badge(mode, line, color) {
  const span = document.createElement("span");
  span.className = `badge ${MODES.includes(mode) ? mode : "OTHER"} small-badge`;
  span.textContent = line || modeName(mode);
  if (color) span.style.background = color;
  return span;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// ---------- Sheet (bottom panel) ----------

/** withBack: the step-by-step view of one trip (has ←, and the hide button). */
function showSheet(title, withBack) {
  $("plan-sheet").hidden = false;
  $("plan-sheet-title").textContent = title;
  $("plan-back").hidden = !withBack;
  $("plan-collapse").hidden = !withBack;
  if (!withBack) setCollapsed(false, false);
  onLayoutChange();
}

function hideSheet() {
  setCollapsed(false, false);
  if ($("plan-sheet").hidden) return;
  $("plan-sheet").hidden = true;
  onLayoutChange();
}

/** Hide the search box and the steps (keeping the panel's top row and trip strip), or bring them back. */
function setCollapsed(on, notify = true) {
  const view = $("map-view");
  if (view.classList.contains("plan-collapsed") === on) return;
  view.classList.toggle("plan-collapsed", on);
  const btn = $("plan-collapse");
  btn.textContent = on ? "⌃" : "⌄";
  btn.setAttribute("aria-label", on ? "Show search and steps" : "Hide search and steps");
  if (on) closeSuggest();
  if (notify) onLayoutChange();
}

export function isSheetOpen() {
  return !$("plan-sheet").hidden;
}

// ---------- Choosing start and destination ----------

function setEnd(which, place) {
  ends[which] = place;
  $(`plan-${which}`).value = place ? place.name : "";
  setPlanEndpoints(ends.from, ends.to);
  clearItinerary();
  const pts = [ends.from, ends.to].filter(Boolean).map((p) => [p.lat, p.lon]);
  fitPoints(pts);
  runPlan();
}

function getMyLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("This browser can't share your location."));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ name: "My location", lat: p.coords.latitude, lon: p.coords.longitude }),
      (e) => reject(new Error(e.code === 1 ? "Location permission was denied." : "Couldn't get your location.")),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
    );
  });
}

// Map tap → small popup with "Start here" / "Go here".
function onMapTap(latlng, stop) {
  const box = el("div", "plan-pop");
  box.appendChild(el("strong", "", stop ? stop.name : "Point on the map"));
  const row = el("div", "plan-pop-btns");
  const place = { name: stop ? stop.name : "Point on map", lat: latlng.lat, lon: latlng.lng };
  for (const [which, label] of [["from", "Start here"], ["to", "Go here"]]) {
    const b = el("button", "", label);
    b.type = "button";
    b.addEventListener("click", () => {
      closeMapPopup();
      setEnd(which, { ...place });
    });
    row.appendChild(b);
  }
  box.appendChild(row);
  openPopupAt(latlng, box);
}

// ---------- Search suggestions ----------

let activeField = null;   // "from" | "to"
let searchTimer = null;
let searchRun = 0;

function suggest(items) {
  const list = $("plan-suggest");
  list.innerHTML = "";
  for (const it of items) {
    const li = el("li", it.kind ? `sug ${it.kind}` : "sug");
    li.appendChild(el("span", "sug-icon", it.icon));
    const txt = el("span", "sug-text");
    txt.appendChild(el("strong", "", it.name));
    if (it.detail) txt.appendChild(el("span", "muted small", it.detail));
    li.appendChild(txt);
    if (it.pick) {
      // pointerdown fires before the input loses focus, so the list is still there.
      li.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        it.pick();
      });
    }
    list.appendChild(li);
  }
  list.hidden = items.length === 0;
}

function myLocationItem(which) {
  return {
    icon: "◎",
    name: "My location",
    pick: async () => {
      closeSuggest();
      $(`plan-${which}`).value = "Finding your location…";
      try {
        setEnd(which, await getMyLocation());
      } catch (err) {
        $(`plan-${which}`).value = "";
        planMessage(err.message);
      }
    },
  };
}

function closeSuggest() {
  $("plan-suggest").hidden = true;
  for (const f of ["from", "to"]) $(`plan-${f}`).blur();
}

function onFieldInput(which) {
  activeField = which;
  const text = $(`plan-${which}`).value.trim();
  clearTimeout(searchTimer);
  if (text.length < 2) {
    suggest([myLocationItem(which)]);
    return;
  }
  suggest([myLocationItem(which), { icon: "…", name: "Searching…", kind: "muted" }]);
  const run = ++searchRun;
  // Wait until typing pauses, then search stops and places together.
  searchTimer = setTimeout(async () => {
    const near = getCenter();
    const [stops, places] = await Promise.all([
      searchStops(text, near).catch(() => []),
      searchPlaces(text, near).catch(() => []),
    ]);
    if (run !== searchRun || activeField !== which) return;
    const items = [myLocationItem(which)];
    const seen = new Set();
    for (const s of stops) {
      // One entry per stop name per place (both sides of the street are ~0.01° apart at most).
      const key = `${s.name}|${s.lat.toFixed(2)}|${s.lon.toFixed(2)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        icon: "🚏",
        name: s.name,
        detail: `Stop · ${metres(s.distance)}`,
        pick: () => {
          closeSuggest();
          setEnd(which, { name: s.name, lat: s.lat, lon: s.lon });
        },
      });
      if (items.length >= 5) break;
    }
    for (const p of places) {
      items.push({
        icon: "📍",
        name: p.name,
        detail: [p.detail, metres(p.distance)].filter(Boolean).join(" · "),
        pick: () => {
          closeSuggest();
          setEnd(which, { name: p.name, lat: p.lat, lon: p.lon });
        },
      });
    }
    if (items.length === 1) items.push({ icon: "", name: "No matches", kind: "muted" });
    suggest(items);
  }, 500);
}

// ---------- Time ----------

function planTime() {
  const modeSel = $("plan-time-mode").value;
  if (modeSel === "now") return { when: new Date(), arriveBy: false };
  const v = $("plan-time").value; // "YYYY-MM-DDTHH:MM"
  const when = v ? new Date(v) : new Date();
  return { when, arriveBy: modeSel === "arrive" };
}

function defaultTimeValue() {
  const d = new Date(Date.now() + 15 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------- Planning and results ----------

function planMessage(text) {
  showSheet("Trips", false);
  const box = $("plan-content");
  box.innerHTML = "";
  box.appendChild(el("li", "muted", text));
}

// "Tallinn city transport only": off by default, remembered on this device.
const CITY_ONLY_KEY = "acrosstransit.cityOnly";

function loadCityOnly() {
  try {
    return localStorage.getItem(CITY_ONLY_KEY) === "1";
  } catch {
    return false;
  }
}

function saveCityOnly(on) {
  try {
    localStorage.setItem(CITY_ONLY_KEY, on ? "1" : "0");
  } catch {
    /* storage unavailable: the choice just isn't remembered */
  }
}

function cityOnly() {
  return $("plan-city-only").checked;
}

function setCityOnly(on) {
  $("plan-city-only").checked = on;
  saveCityOnly(on);
  runPlan();
}

/** A hint row with a button to turn the city-only filter off. */
function cityOnlyHint(text) {
  const li = el("li", "hint");
  li.appendChild(el("span", "", text));
  const b = el("button", "", "Turn off and search again");
  b.type = "button";
  b.addEventListener("click", () => setCityOnly(false));
  li.appendChild(b);
  return li;
}

function leavesTallinn() {
  return !inTallinnArea(ends.from) || !inTallinnArea(ends.to);
}

// Whether the server accepts the "banned operators" option (found out on first use).
let bannedSupported = true;
let citySearchedUntil = 0; // how far the last city-only search looked (Unix seconds)

const CITY_WANTED = 3;          // stop searching once this many city-only trips are found
const CITY_MAX_ROUNDS = 6;      // at most this many searches per plan
const CITY_WINDOW_S = 3 * 3600; // look at most 3 hours past (or before) the chosen time

function tltOnly(it) {
  return it.legs.every((l) => !l.transit || isTlt(l.operator));
}

/** One search round: ask the server to leave other operators out if it can; otherwise ask for more trips. */
async function cityRound(when, arriveBy) {
  if (bannedSupported) {
    try {
      const others = await getNonTltAgencyIds();
      return await planTrip(ends.from, ends.to, when, arriveBy, { bannedAgencies: others.join(",") });
    } catch (err) {
      if (!/UnknownArgument|FieldUndefined|WrongType|banned/i.test(err.message)) throw err;
      bannedSupported = false;
    }
  }
  return planTrip(ends.from, ends.to, when, arriveBy, { count: 12 });
}

/**
 * Trips using only Tallinna Linnatransport. City-only trips can be less
 * frequent than mixed ones, so if the first search finds few, keep searching
 * later departures (or earlier arrivals for "Arrive by"), up to 3 hours away.
 * Returns { trips, searchedUntil } (Unix seconds).
 */
async function planCityOnly(when, arriveBy) {
  const found = new Map(); // dedupe by start/end/lines
  const startS = Math.floor(when.getTime() / 1000);
  let cursor = new Date(when);
  let searchedUntil = startS;

  for (let round = 0; round < CITY_MAX_ROUNDS; round++) {
    const trips = await cityRound(cursor, arriveBy);
    if (!trips.length) break;
    for (const it of trips.filter(tltOnly)) {
      const key = `${it.start}|${it.end}|${it.legs.map((l) => l.line).join(",")}`;
      found.set(key, it);
    }
    // Move the search time past the trips we've seen.
    if (arriveBy) {
      const earliestEnd = Math.min(...trips.map((t) => t.end));
      searchedUntil = earliestEnd;
      cursor = new Date((earliestEnd - 60) * 1000);
      if (startS - earliestEnd > CITY_WINDOW_S) break;
    } else {
      const latestStart = Math.max(...trips.map((t) => t.start));
      searchedUntil = latestStart;
      cursor = new Date((latestStart + 60) * 1000);
      if (latestStart - startS > CITY_WINDOW_S) break;
    }
    if (found.size >= CITY_WANTED) break;
  }

  const list = [...found.values()].sort((a, b) => (arriveBy ? b.end - a.end : a.start - b.start));
  return { trips: list.slice(0, 5), searchedUntil };
}

async function runPlan() {
  if (!ends.from || !ends.to) {
    hideSheet();
    return;
  }
  const run = ++planRun;
  planMessage("Searching for trips…");
  const { when, arriveBy } = planTime();
  try {
    let result;
    if (cityOnly()) {
      planMessage("Searching for Tallinn city transport trips…");
      const r = await planCityOnly(when, arriveBy);
      result = r.trips;
      citySearchedUntil = r.searchedUntil;
    } else {
      result = await planTrip(ends.from, ends.to, when, arriveBy);
    }
    if (run !== planRun) return;
    itineraries = result;
    showList();
  } catch (err) {
    if (run !== planRun) return;
    planMessage("Couldn't plan the trip: " + err.message);
  }
}

/** A one-line picture of a trip: 🚶4 › [5] › 🚶2 › [3] */
function legStrip(it) {
  const strip = el("div", "leg-strip");
  const colors = colorsForLegs(it.legs);
  it.legs.forEach((l, i) => {
    if (i > 0) strip.appendChild(el("span", "leg-sep", "›"));
    if (l.transit) strip.appendChild(badge(l.mode, l.line, colors.get(lineKey(l.mode, l.line))));
    else strip.appendChild(el("span", "leg-walk", `🚶${minutes(l.duration)}`));
  });
  return strip;
}

function showList() {
  clearItinerary();
  showSheet("Trips", false);
  const box = $("plan-content");
  box.innerHTML = "";
  box.scrollTop = 0;
  if (cityOnly() && leavesTallinn()) {
    box.appendChild(cityOnlyHint("This trip starts or ends outside Tallinn, but only Tallinn city transport is allowed."));
  }
  if (!itineraries.length) {
    if (cityOnly() && !leavesTallinn()) {
      box.appendChild(cityOnlyHint(
        `No Tallinn city transport trips found up to ${clock(citySearchedUntil)}.`));
    } else if (!cityOnly()) {
      box.appendChild(el("li", "muted", "No trips found for that time. Try another time or a nearby place."));
    }
    return;
  }
  itineraries.forEach((it, i) => {
    const li = el("li", "itin");
    const top = el("div", "itin-top");
    top.appendChild(el("strong", "", `${clock(it.start)} → ${clock(it.end)}`));
    top.appendChild(el("span", "itin-dur", `${minutes(it.duration)} min`));
    li.appendChild(top);
    li.appendChild(legStrip(it));
    const rides = it.legs.filter((l) => l.transit).length;
    const transfers = Math.max(0, rides - 1);
    const info = rides === 0
      ? `Walk only · ${metres(it.walkDistance)}`
      : `${transfers === 0 ? "No transfers" : transfers === 1 ? "1 transfer" : `${transfers} transfers`} · ${metres(it.walkDistance)} walk`;
    li.appendChild(el("div", "muted small", info));
    li.addEventListener("click", () => showDetails(i));
    box.appendChild(li);
  });
  // City-only results first; then the option to see trips with other operators too.
  if (cityOnly() && !leavesTallinn()) {
    box.appendChild(cityOnlyHint("Only Tallinn city transport is shown. Other operators may have faster or more frequent trips."));
  }
}

function showDetails(i) {
  const it = itineraries[i];
  showItinerary(it.legs);
  showSheet(`${clock(it.start)} → ${clock(it.end)} · ${minutes(it.duration)} min`, true);
  const strip = $("plan-strip");
  strip.innerHTML = "";
  strip.appendChild(legStrip(it));
  const colors = colorsForLegs(it.legs);
  const box = $("plan-content");
  box.innerHTML = "";
  box.scrollTop = 0;

  it.legs.forEach((l, idx) => {
    const li = el("li", "step");
    const isLast = idx === it.legs.length - 1;
    if (!l.transit) {
      // Walking between two rides is a transfer.
      const between = idx > 0 && !isLast;
      const where = isLast ? ends.to.name : l.to.name;
      li.appendChild(el("span", "step-icon", "🚶"));
      const t = el("div", "step-text");
      t.appendChild(el("strong", "", `${between ? "Transfer: walk" : "Walk"} ${metres(l.distance)} to ${where}`));
      t.appendChild(el("span", "muted small", `${minutes(l.duration)} min · ${clock(l.start)}–${clock(l.end)}`));
      li.appendChild(t);
    } else {
      // A ride directly after another ride is a transfer at the same stop.
      if (idx > 0 && it.legs[idx - 1].transit) {
        const tr = el("li", "step transfer");
        tr.appendChild(el("span", "step-icon", "⇄"));
        tr.appendChild(el("strong", "", `Transfer at ${l.from.name}`));
        box.appendChild(tr);
      }
      li.appendChild(badge(l.mode, l.line, colors.get(lineKey(l.mode, l.line))));
      const t = el("div", "step-text");
      t.appendChild(el("strong", "", `${modeName(l.mode)} ${l.line}${l.headsign ? ` → ${l.headsign}` : ""}`));
      t.appendChild(el("span", "", `${clock(l.start)} ${l.from.name}`));
      t.appendChild(el("span", "", `${clock(l.end)} ${l.to.name} (get off)`));
      t.appendChild(el("span", "muted small",
        [`${l.stops} ${l.stops === 1 ? "stop" : "stops"}`, `${minutes(l.duration)} min`, l.operator].filter(Boolean).join(" · ")));
      li.appendChild(t);
    }
    box.appendChild(li);
  });
  const end = el("li", "step");
  end.appendChild(el("span", "step-icon", "🏁"));
  end.appendChild(el("strong", "", `Arrive ${clock(it.end)} at ${ends.to.name}`));
  box.appendChild(end);
}

// ---------- Wiring ----------

export function initPlanner(layoutCallback) {
  onLayoutChange = layoutCallback;
  setPlanTapHandler(onMapTap);

  for (const which of ["from", "to"]) {
    const input = $(`plan-${which}`);
    input.addEventListener("focus", () => {
      activeField = which;
      input.select(); // typing replaces the current name
      suggest([myLocationItem(which)]);
    });
    input.addEventListener("input", () => {
      if (!input.value.trim() && ends[which]) {
        ends[which] = null;
        setPlanEndpoints(ends.from, ends.to);
        clearItinerary();
        hideSheet();
      }
      onFieldInput(which);
    });
    input.addEventListener("blur", () => {
      setTimeout(() => {
        if (document.activeElement?.id?.startsWith("plan-") && document.activeElement.tagName === "INPUT") return;
        $("plan-suggest").hidden = true;
        // Put back the chosen name if the text was edited but nothing picked.
        input.value = ends[which]?.name || "";
      }, 150);
    });
  }

  $("plan-swap").addEventListener("click", () => {
    [ends.from, ends.to] = [ends.to, ends.from];
    $("plan-from").value = ends.from?.name || "";
    $("plan-to").value = ends.to?.name || "";
    setPlanEndpoints(ends.from, ends.to);
    clearItinerary();
    runPlan();
  });

  $("plan-time-mode").addEventListener("change", () => {
    const isNow = $("plan-time-mode").value === "now";
    $("plan-time").hidden = isNow;
    if (!isNow && !$("plan-time").value) $("plan-time").value = defaultTimeValue();
    runPlan();
  });
  $("plan-time").addEventListener("change", runPlan);

  $("plan-city-only").checked = loadCityOnly();
  $("plan-city-only").addEventListener("change", () => setCityOnly(cityOnly()));

  $("plan-back").addEventListener("click", showList);
  $("plan-collapse").addEventListener("click", () =>
    setCollapsed(!$("map-view").classList.contains("plan-collapsed")));
  $("plan-close").addEventListener("click", () => {
    clearItinerary();
    hideSheet();
  });
}
