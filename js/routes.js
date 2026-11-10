// Screen: the Routes tab — operators with their routes (Tallinna Linnatransport
// first and open, others load when expanded), search, and a route's details
// (directions and stops) with "Show on map".

import { getAgencies, getAgencyRoutes, searchRoutes, getRouteDirections, isTlt } from "./peatus.js?v=23";

const MODES = ["BUS", "TROLLEYBUS", "TRAM", "RAIL"];
const TYPE_ORDER = ["TRAM", "TROLLEYBUS", "BUS", "RAIL", "FERRY"];
const TYPE_NAMES = { TRAM: "Trams", TROLLEYBUS: "Trolleybuses", BUS: "Buses", RAIL: "Trains", FERRY: "Ferries" };

const $ = (id) => document.getElementById(id);

let agencies = null;            // [{ id, name }]
const agencyRoutes = new Map(); // agency id -> routes (once loaded)
let loading = null;
let searchTimer = null;
let searchRun = 0;
let detailRun = 0;
let hooks = { onShowOnMap: () => {}, onOpenStop: () => {} };

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function badge(r) {
  const b = el("span", `badge ${MODES.includes(r.mode) ? r.mode : "OTHER"} small-badge`, r.line || "–");
  return b;
}

function byLine(a, b) {
  return a.line.localeCompare(b.line, "et", { numeric: true }) || a.name.localeCompare(b.name, "et");
}

function message(container, text) {
  container.innerHTML = "";
  container.appendChild(el("p", "muted", text));
}

// ---------- Route rows ----------

function routeRow(r, showOperator = false) {
  const li = el("li", "route-row");
  li.appendChild(badge(r));
  const t = el("div", "route-text");
  t.appendChild(el("span", "", r.name || `Line ${r.line}`));
  if (showOperator && r.operator) t.appendChild(el("span", "muted small", r.operator));
  li.appendChild(t);
  li.addEventListener("click", () => openDetail(r));
  return li;
}

function renderRouteList(container, routes, groupByType) {
  container.innerHTML = "";
  if (!routes.length) {
    container.appendChild(el("p", "muted small", "No routes."));
    return;
  }
  if (!groupByType) {
    const ul = el("ul", "route-list");
    for (const r of [...routes].sort(byLine)) ul.appendChild(routeRow(r));
    container.appendChild(ul);
    return;
  }
  const groups = new Map();
  for (const r of routes) {
    if (!groups.has(r.mode)) groups.set(r.mode, []);
    groups.get(r.mode).push(r);
  }
  const order = [...groups.keys()].sort((a, b) => {
    const ia = TYPE_ORDER.indexOf(a), ib = TYPE_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  for (const m of order) {
    container.appendChild(el("h3", "route-type", TYPE_NAMES[m] || m));
    const ul = el("ul", "route-list");
    for (const r of groups.get(m).sort(byLine)) ul.appendChild(routeRow(r));
    container.appendChild(ul);
  }
}

// ---------- Operators (collapsible) ----------

function agencyBlock(a, open) {
  const box = el("details", "agency");
  const sum = el("summary", "agency-head");
  sum.appendChild(el("span", "agency-name", a.name));
  const count = el("span", "muted small agency-count", agencyRoutes.has(a.id) ? `${agencyRoutes.get(a.id).length}` : "");
  sum.appendChild(count);
  box.appendChild(sum);
  const body = el("div", "agency-body");
  box.appendChild(body);
  const tlt = isTlt(a.name);

  async function fill() {
    if (agencyRoutes.has(a.id)) {
      renderRouteList(body, agencyRoutes.get(a.id), tlt);
      count.textContent = `${agencyRoutes.get(a.id).length}`;
      return;
    }
    message(body, "Loading routes…");
    try {
      const routes = await getAgencyRoutes(a.id);
      agencyRoutes.set(a.id, routes);
      renderRouteList(body, routes, tlt);
      count.textContent = `${routes.length}`;
    } catch (err) {
      message(body, "Couldn't load routes: " + err.message);
    }
  }

  // Routes are only loaded when a company is opened.
  box.addEventListener("toggle", () => {
    if (box.open) fill();
  });
  if (open) box.open = true; // fires "toggle" → loads
  return box;
}

function renderAgencies() {
  const list = $("routes-list");
  list.innerHTML = "";
  const tlt = agencies.filter((a) => isTlt(a.name));
  const others = agencies.filter((a) => !isTlt(a.name));
  for (const a of tlt) list.appendChild(agencyBlock(a, true));
  for (const a of others) list.appendChild(agencyBlock(a, false));
}

/** Call when the Routes tab is shown. Loads the operator list the first time. */
export function enterRoutes() {
  if (agencies || loading) return;
  message($("routes-list"), "Loading companies…");
  loading = getAgencies()
    .then((list) => {
      agencies = list;
      if (!$("routes-search").value.trim()) renderAgencies();
    })
    .catch((err) => message($("routes-list"), "Couldn't load companies: " + err.message))
    .finally(() => (loading = null));
}

// ---------- Search ----------

function onSearch() {
  const text = $("routes-search").value.trim();
  clearTimeout(searchTimer);
  const run = ++searchRun;
  if (!text) {
    if (agencies) renderAgencies();
    else enterRoutes();
    return;
  }
  searchTimer = setTimeout(async () => {
    const list = $("routes-list");
    message(list, "Searching…");
    let routes = [];
    try {
      routes = await searchRoutes(text);
    } catch (err) {
      if (run === searchRun) message(list, "Search failed: " + err.message);
      return;
    }
    if (run !== searchRun) return;
    list.innerHTML = "";
    // Matching companies (e.g. "Elron"), collapsed.
    const q = text.toLowerCase();
    const companies = (agencies || []).filter((a) => a.name.toLowerCase().includes(q));
    for (const a of companies) list.appendChild(agencyBlock(a, false));
    // Matching routes: exact line numbers first, then the rest.
    routes.sort((a, b) => {
      const ea = a.line.toLowerCase() === q ? 0 : 1;
      const eb = b.line.toLowerCase() === q ? 0 : 1;
      return ea - eb || (isTlt(b.operator) - isTlt(a.operator)) || byLine(a, b);
    });
    if (routes.length) {
      const ul = el("ul", "route-list");
      for (const r of routes.slice(0, 60)) ul.appendChild(routeRow(r, true));
      list.appendChild(ul);
    }
    if (!routes.length && !companies.length) message(list, "No routes or companies match.");
  }, 400);
}

// ---------- Route details ----------

async function openDetail(r) {
  const run = ++detailRun;
  $("routes-main").hidden = true;
  $("route-detail").hidden = false;
  const b = $("route-detail-badge");
  b.replaceWith(Object.assign(badge(r), { id: "route-detail-badge" }));
  $("route-detail-title").textContent = r.name || `Line ${r.line}`;
  $("route-detail-operator").textContent = r.operator || "";
  $("route-dirs").innerHTML = "";
  message($("route-stops"), "Loading…");
  $("route-show-map").hidden = true;

  let dirs;
  try {
    dirs = await getRouteDirections(r.id);
  } catch (err) {
    if (run === detailRun) message($("route-stops"), "Couldn't load the route: " + err.message);
    return;
  }
  if (run !== detailRun) return;
  if (!dirs.length) {
    message($("route-stops"), "No timetable data for this route.");
    return;
  }

  let current = dirs[0];
  const dirBox = $("route-dirs");
  function showDir(d) {
    current = d;
    for (const btn of dirBox.children) btn.classList.toggle("active", btn._dir === d);
    const ul = $("route-stops");
    ul.innerHTML = "";
    d.stops.forEach((s, i) => {
      const li = el("li", "route-stop");
      li.appendChild(el("span", "route-stop-n", String(i + 1)));
      li.appendChild(el("span", "", s.name));
      li.addEventListener("click", () => hooks.onOpenStop(s));
      ul.appendChild(li);
    });
  }
  for (const d of dirs) {
    const btn = el("button", "day-btn", `→ ${d.headsign}`);
    btn.type = "button";
    btn._dir = d;
    btn.addEventListener("click", () => showDir(d));
    dirBox.appendChild(btn);
  }
  showDir(current);
  const show = $("route-show-map");
  show.hidden = false;
  show.onclick = () => hooks.onShowOnMap(r, current);
}

function closeDetail() {
  detailRun++;
  $("route-detail").hidden = true;
  $("routes-main").hidden = false;
}

export function initRoutes(h) {
  hooks = h;
  $("routes-search").addEventListener("input", onSearch);
  $("route-back").addEventListener("click", closeDetail);
}
