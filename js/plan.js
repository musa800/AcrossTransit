// Screen: the Plan tab — choose start and destination (search, map tap or
// my location), depart/arrive time, then trip options with transfers.

import { searchStops, planTrip } from "./peatus.js?v=10";
import { searchPlaces } from "./geocode.js?v=10";
import {
  setPlanEndpoints, setPlanTapHandler, openPopupAt, closeMapPopup,
  fitPoints, showItinerary, clearItinerary, colorsForLegs,
} from "./map.js?v=10";
import { lineKey } from "./vehicles.js?v=10";

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
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`;
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

function showSheet(title, withBack) {
  $("plan-sheet").hidden = false;
  $("plan-sheet-title").textContent = title;
  $("plan-back").hidden = !withBack;
  onLayoutChange();
}

function hideSheet() {
  if ($("plan-sheet").hidden) return;
  $("plan-sheet").hidden = true;
  onLayoutChange();
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
    const [stops, places] = await Promise.all([
      searchStops(text).catch(() => []),
      searchPlaces(text).catch(() => []),
    ]);
    if (run !== searchRun || activeField !== which) return;
    const items = [myLocationItem(which)];
    const seen = new Set();
    for (const s of stops) {
      if (seen.has(s.name)) continue; // one entry per stop name (both sides of the street)
      seen.add(s.name);
      items.push({
        icon: "🚏",
        name: s.name,
        detail: "Stop",
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
        detail: p.detail,
        pick: () => {
          closeSuggest();
          setEnd(which, { name: p.name, lat: p.lat, lon: p.lon });
        },
      });
    }
    if (items.length === 1) items.push({ icon: "", name: "No matches in Tallinn", kind: "muted" });
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

async function runPlan() {
  if (!ends.from || !ends.to) {
    hideSheet();
    return;
  }
  const run = ++planRun;
  planMessage("Searching for trips…");
  const { when, arriveBy } = planTime();
  try {
    const result = await planTrip(ends.from, ends.to, when, arriveBy);
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
  if (!itineraries.length) {
    box.appendChild(el("li", "muted", "No trips found for that time. Try another time or nearby place."));
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
}

function showDetails(i) {
  const it = itineraries[i];
  showItinerary(it.legs);
  showSheet(`${clock(it.start)} → ${clock(it.end)} · ${minutes(it.duration)} min`, true);
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
      t.appendChild(el("span", "muted small", `${l.stops} ${l.stops === 1 ? "stop" : "stops"} · ${minutes(l.duration)} min`));
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

  $("plan-back").addEventListener("click", showList);
  $("plan-close").addEventListener("click", () => {
    clearItinerary();
    hideSheet();
  });
}
