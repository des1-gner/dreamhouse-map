// Dreamhouse Finder: listings + suburb overlays on a Leaflet map.
// All data comes from web/data/*.geojson (built by scripts/), except the wildlife
// density tiles which load live from the Atlas of Living Australia.

const map = L.map("map", { preferCanvas: true }).setView([-37.84, 145.05], 10);
// Esri dark grey canvas: works from the extension panel too (OSM's tile servers
// block requests without a referring page). Labels sit on their own layer above overlays.
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas";
L.tileLayer(`${ESRI}/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`, {
  maxZoom: 19, maxNativeZoom: 16,
  attribution: 'Basemap &copy; <a href="https://www.esri.com/">Esri</a>, HERE, Garmin, &copy; OpenStreetMap contributors',
}).addTo(map);
map.createPane("labels").style.zIndex = 450;
map.getPane("labels").style.pointerEvents = "none";
L.tileLayer(`${ESRI}/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 19, maxNativeZoom: 16, pane: "labels" }).addTo(map);

// The browser extension embeds this page and sets these before loading app.js.
const DATA_BASE = window.DREAMHOUSE_DATA_BASE || "data/";
const EXTENSION = !!window.DREAMHOUSE_EXTENSION;

// The extension panel starts hidden (zero size); re-measure whenever it resizes.
new ResizeObserver(() => map.invalidateSize()).observe(map.getContainer());

const data = {};    // name -> FeatureCollection (or null if missing)
const layers = {};  // name -> Leaflet layer
const statusEl = document.getElementById("status");

// ---------- helpers ----------
const fmt = {
  money: (v) => v == null ? "–" : "$" + Math.round(v).toLocaleString("en-AU"),
  pct: (v) => v == null ? "–" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`,
  num: (v) => v == null ? "–" : Math.round(v).toLocaleString("en-AU"),
  km: (m) => m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`,
};
const titleCase = (s) => String(s ?? "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const safeUrl = (u) => { try { return ["https:", "http:"].includes(new URL(u).protocol); } catch { return false; } };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function haversine([lon1, lat1], [lon2, lat2]) {
  const R = 6371000, r = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * r / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function inRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inPolygon(pt, geom) {
  if (!geom) return false;
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.type === "MultiPolygon" ? geom.coordinates : [];
  return polys.some(([outer, ...holes]) => inRing(pt, outer) && !holes.some((h) => inRing(pt, h)));
}
const featuresAt = (name, pt) => (data[name]?.features || []).filter((f) => inPolygon(pt, f.geometry));

function nearest(name, pt, filter = () => true, limit = 1) {
  return (data[name]?.features || [])
    .filter(filter)
    .map((f) => ({ f, d: haversine(pt, f.geometry.coordinates) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, limit);
}

async function load(name) {
  try {
    const r = await fetch(`${DATA_BASE}${name}.geojson`);
    if (!r.ok) throw new Error(r.status);
    data[name] = await r.json();
  } catch {
    data[name] = null;
    statusEl.textContent += `No ${name} data yet (run scripts/fetch_*.py). `;
  }
  return data[name];
}

// ---------- commute ----------
const WALK_M_PER_MIN = 80;   // ~4.8 km/h
const MAX_WALK_M = { train: 2500, tram: 1000, bus: 800 };

function bestCommute(pt) {
  const out = {};
  for (const mode of ["train", "tram", "bus"]) {
    const cands = nearest("transport_stops", pt,
      (f) => f.properties.mode === mode && f.properties.cbd_minutes != null &&
             haversine(pt, f.geometry.coordinates) <= MAX_WALK_M[mode], 50);
    let best = null;
    for (const { f, d } of cands) {
      const walk = Math.round(d * 1.3 / WALK_M_PER_MIN);  // 1.3 = street-network detour factor
      const total = walk + f.properties.cbd_minutes;
      if (!best || total < best.total) best = { stop: f.properties, walk, dist: d, total };
    }
    out[mode] = best;
  }
  return out;
}

// ---------- the "what's here" report ----------
function report(pt, listing) {
  const p = listing?.properties;
  const suburb = featuresAt("suburbs", pt)[0]?.properties;
  const fire = featuresAt("bushfire", pt).map((f) => f.properties);
  const flood = featuresAt("flood", pt).map((f) => f.properties);
  const shops = nearest("supermarkets", pt, (f) => f.properties.major, 3);
  const commute = bestCommute(pt);

  let h = `<div class="report">`;
  if (p) {
    h += `<h3>${esc(p.address)}</h3><div><b>${fmt.money(p.price)}</b> ${p.notes ? `<span class="muted">${esc(p.notes)}</span>` : ""}</div>`;
    h += `<div>${[p.beds && `${p.beds} bed`, p.baths && `${p.baths} bath`, p.cars && `${p.cars} car`, p.land_m2 && `${p.land_m2} m²`].filter(Boolean).join(" · ")}</div>`;
  } else {
    h += `<h3>${pt[1].toFixed(5)}, ${pt[0].toFixed(5)}</h3>`;
  }

  h += `<h4>To the CBD (walk + ride, AM peak)</h4><table>`;
  for (const [mode, c] of Object.entries(commute)) {
    h += c
      ? `<tr><td>${mode[0].toUpperCase() + mode.slice(1)}: ${esc(c.stop.name)} <span class="muted">(${fmt.km(c.dist)} walk)</span><br><span class="muted">${esc(c.stop.cbd_via || "")}</span></td><td><b>${c.total} min</b></td></tr>`
      : `<tr><td>${mode[0].toUpperCase() + mode.slice(1)}</td><td class="muted">none nearby</td></tr>`;
  }
  h += `</table>`;

  h += `<h4>Supermarkets</h4><table>`;
  h += shops.length ? shops.map(({ f, d }) => `<tr><td>${esc(f.properties.name)}</td><td>${fmt.km(d)}</td></tr>`).join("") : `<tr><td class="muted">no data</td></tr>`;
  h += `</table>`;

  h += `<h4>Hazards</h4>`;
  h += data.bushfire ? (fire.length ? `<div class="warn">🔥 ${[...new Set(fire.map((f) => f.kind === "BPA" ? "Bushfire Prone Area" : "Bushfire Management Overlay"))].join(", ")}</div>` : `<div class="ok">Not in a bushfire overlay</div>`) : "";
  h += data.flood ? (flood.length ? `<div class="warn">🌊 ${[...new Set(flood.map((f) => titleCase(f.description)))].map(esc).join(", ")}</div>` : `<div class="ok">Not in a flood overlay</div>`) : "";

  if (suburb) {
    h += `<h4>${esc(suburb.name)}${suburb.lga ? ` <span class="muted">(${esc(suburb.lga)})</span>` : ""}</h4><table>
      <tr><td>Median household income</td><td>${suburb.median_hh_income_weekly ? fmt.money(suburb.median_hh_income_weekly) + "/wk" : "–"}</td></tr>
      <tr><td>Public housing</td><td>${suburb.pct_public_housing == null ? "–" : suburb.pct_public_housing.toFixed(1) + "%"}</td></tr>
      <tr><td>Crime rate / 100k${suburb.crime_year ? ` (${esc(suburb.crime_year)})` : ""}</td><td>${fmt.num(suburb.crime_rate_per_100k)}</td></tr>
      <tr><td>Median house price</td><td>${fmt.money(suburb.median_house_price)}</td></tr>
      <tr><td>Growth 5 yr / 10 yr</td><td>${fmt.pct(suburb.price_growth_5y_pct)} / ${fmt.pct(suburb.price_growth_10y_pct)}</td></tr>
    </table>`;
    if (suburb.price_history) h += sparkline(suburb.price_history);
  }

  const wid = `wl-${++reportSeq}`;
  h += `<h4>Wildlife sightings within ${p?.wildlife_radius_km || WILDLIFE_RADIUS_KM} km (since 2010)</h4><div id="${wid}">`;
  if (p?.wildlife) h += wildlifeLine(p.wildlife);
  else { h += `<span class="muted">loading…</span>`; fillWildlife(wid, pt); }
  h += `</div>`;

  const addr = p?.address;
  h += `<div class="links" style="margin-top:8px">`;
  if (safeUrl(p?.url)) h += `<a href="${esc(p.url)}" target="_blank" rel="noopener">Listing</a>`;
  h += `<a href="${esc(p?.nbn_check || "https://www.nbnco.com.au/connect-home-or-business/check-your-address")}" target="_blank" rel="noopener">Check NBN</a>`;
  h += `<a href="https://www.google.com/maps?q=${pt[1]},${pt[0]}" target="_blank" rel="noopener">Google Maps</a>`;
  h += `</div></div>`;
  return h;
}

// Live wildlife counts from the Atlas of Living Australia for spots without precomputed ones.
let reportSeq = 0;
const WILDLIFE_RADIUS_KM = 2;
const wildlifeCache = new Map();
const wildlifeLine = (w) => `🐍 ${w.snakes} · 🕷️ ${w.spiders} · 🦟 ${w.mosquitoes}`;
async function fillWildlife(id, [lon, lat]) {
  const key = `${lon.toFixed(3)},${lat.toFixed(3)}`;
  if (!wildlifeCache.has(key)) {
    wildlifeCache.set(key, Promise.all(Object.entries(WILDLIFE_Q).map(async ([k, q]) => {
      const u = `https://biocache-ws.ala.org.au/ws/occurrences/search?pageSize=0&radius=${WILDLIFE_RADIUS_KM}&lat=${lat}&lon=${lon}&fq=${encodeURIComponent("year:[2010 TO *]")}&q=${encodeURIComponent(q)}`;
      return [k, (await (await fetch(u)).json()).totalRecords ?? "?"];
    })).then(Object.fromEntries));
  }
  try {
    const w = await wildlifeCache.get(key);
    const el = document.getElementById(id);
    if (el) el.innerHTML = wildlifeLine(w);
  } catch {
    wildlifeCache.delete(key);
    const el = document.getElementById(id);
    if (el) el.innerHTML = `<span class="muted">unavailable</span>`;
  }
}

function sparkline(history) {
  const pts = Object.entries(history).filter(([, v]) => v).sort(([a], [b]) => a - b);
  if (pts.length < 2) return "";
  const W = 260, H = 50, ys = pts.map(([, v]) => v), lo = Math.min(...ys), hi = Math.max(...ys);
  const xy = pts.map(([, v], i) => `${(i / (pts.length - 1)) * W},${H - 4 - ((v - lo) / (hi - lo || 1)) * (H - 8)}`);
  return `<svg width="${W}" height="${H + 12}" style="margin-top:4px"><polyline fill="none" stroke="#0969da" stroke-width="2" points="${xy.join(" ")}"/>
    <text x="0" y="${H + 10}" font-size="10" fill="#57606a">${pts[0][0]}: ${fmt.money(ys[0])}</text>
    <text x="${W}" y="${H + 10}" font-size="10" fill="#57606a" text-anchor="end">${pts.at(-1)[0]}: ${fmt.money(ys.at(-1))}</text></svg>`;
}

// ---------- layers ----------
// Listings are plain red dots on their own pane above every icon.
map.createPane("listingsPane").style.zIndex = 650;
const listingRenderer = L.canvas({ pane: "listingsPane" });

function buildListings() {
  const budgetOnly = document.getElementById("budget-only").checked;
  const feats = (data.listings?.features || []).filter((f) => !budgetOnly || f.properties.in_budget);
  document.getElementById("count-listings").textContent = feats.length ? `(${feats.length})` : "";
  return L.layerGroup(feats.map((f) => {
    const [lon, lat] = f.geometry.coordinates;
    return L.circleMarker([lat, lon], {
      renderer: listingRenderer, radius: 6.5, weight: 2, color: "#fff",
      fillColor: f.properties.in_budget ? "#ff3b30" : "#8b949e", fillOpacity: 1,
    }).bindPopup(() => report([lon, lat], f), { maxWidth: 340 })
      .bindTooltip(`${esc(f.properties.address || "")}${f.properties.notes ? `<br>${esc(f.properties.notes)}` : ""}`);
  }));
}

// Icon layers draw only the features in view, and only from a minimum zoom,
// so thousands of bus stops don't slow the map down.
const MAX_ICONS = 1500;
const iconCache = new Map();
function icon(emoji, ring, small = false) {
  const k = emoji + (ring || "") + small;
  if (!iconCache.has(k)) {
    iconCache.set(k, L.divIcon({
      className: "", iconSize: small ? [18, 18] : [24, 24], iconAnchor: small ? [9, 9] : [12, 12],
      html: `<div class="mk${small ? " sm" : ""}"${ring ? ` style="border-color:${ring}"` : ""}>${emoji}</div>`,
    }));
  }
  return iconCache.get(k);
}

function viewportLayer({ features, minZoom, marker }) {
  const group = L.layerGroup();
  const draw = () => {
    group.clearLayers();
    group.hiddenByZoom = map.getZoom() < minZoom;
    if (!group.hiddenByZoom) {
      const b = map.getBounds().pad(0.2);
      let n = 0;
      for (const f of features()) {
        const [lon, lat] = f.geometry.coordinates;
        if (!b.contains([lat, lon])) continue;
        group.addLayer(marker(f, [lat, lon]));
        if (++n >= MAX_ICONS) break;
      }
    }
    updateKey();
  };
  group.on("add", () => { map.on("moveend", draw); draw(); });
  group.on("remove", () => map.off("moveend", draw));
  return group;
}

const BRAND_COLOURS = { Coles: "#e01a22", Woolworths: "#1fa64a", ALDI: "#2f6fe0", Costco: "#2f6fe0", IGA: "#ff6b6b", FoodWorks: "#8bc34a", Other: "#8b949e" };
function buildSupermarkets() {
  const majorOnly = document.getElementById("major-only").checked;
  const feats = (data.supermarkets?.features || []).filter((f) => !majorOnly || f.properties.major);
  return viewportLayer({
    features: () => feats, minZoom: 11,
    marker: (f, ll) => L.marker(ll, { icon: icon("🛒", BRAND_COLOURS[f.properties.brand]) })
      .bindTooltip(`<b>${esc(f.properties.name)}</b><br>${esc(f.properties.brand)}`),
  });
}

const MODES = {
  train: { emoji: "🚆", minZoom: 10, label: "Train station" },
  tram: { emoji: "🚊", minZoom: 14, label: "Tram stop" },
  bus: { emoji: "🚌", minZoom: 15, label: "Bus stop" },
};
function buildStops(mode) {
  const feats = (data.transport_stops?.features || []).filter((f) => f.properties.mode === mode);
  return viewportLayer({
    features: () => feats, minZoom: MODES[mode].minZoom,
    marker: (f, ll) => {
      const p = f.properties;
      const small = mode !== "train" || map.getZoom() < 12;
      return L.marker(ll, { icon: icon(MODES[mode].emoji, null, small) }).bindTooltip(
        `<b>${esc(p.name)}</b><br>${p.cbd_minutes != null ? `${p.cbd_minutes} min to CBD` : "no CBD estimate"}` +
        `${p.cbd_via ? `<br><span class="muted">${esc(p.cbd_via)}</span>` : ""}` +
        `${p.routes?.length ? `<br>Routes: ${esc(p.routes.slice(0, 8).join(", "))}` : ""}`);
    },
  });
}

function buildPolys(name, styleFn) {
  return L.geoJSON(data[name], { style: styleFn, interactive: false });
}

const ALA_WMS = "https://biocache-ws.ala.org.au/ws/ogc/wms/reflect";
const WILDLIFE_Q = {  // grid colour ramps from yellow (few records) to red (many)
  snakes: "taxa:Serpentes",
  spiders: "(genus:Latrodectus OR genus:Lampona OR family:Atracidae)",
  mosquitoes: "family:Culicidae",
};
function buildWildlife(key) {
  const q = WILDLIFE_Q[key];
  return L.tileLayer.wms(ALA_WMS, {
    layers: "ALA:occurrences", format: "image/png", transparent: true, opacity: 0.6, styles: "",
    q, fq: "year:[2010 TO *]", ENV: "colormode:grid;name:circle;size:4;opacity:0.8",
    attribution: '<a href="https://www.ala.org.au/">Atlas of Living Australia</a>',
  });
}

const HAZARD = {
  BPA: { fill: "#ff9f43", label: "Bushfire Prone Area" },
  BMO: { fill: "#ff4d4f", label: "Bushfire Management Overlay" },
  flood: { fill: "#3fa9ff", label: "Flood overlay (LSIO / FO / SBO / UFZ)" },
};
const builders = {
  listings: buildListings,
  supermarkets: buildSupermarkets,
  train: () => buildStops("train"),
  tram: () => buildStops("tram"),
  bus: () => buildStops("bus"),
  bushfire: () => buildPolys("bushfire", (f) => {
    const c = HAZARD[f.properties.kind === "BMO" ? "BMO" : "BPA"].fill;
    return { color: c, weight: 1, fillColor: c, fillOpacity: 0.25 };
  }),
  flood: () => buildPolys("flood", () => ({ color: HAZARD.flood.fill, weight: 1, fillColor: HAZARD.flood.fill, fillOpacity: 0.3 })),
  snakes: () => buildWildlife("snakes"),
  spiders: () => buildWildlife("spiders"),
  mosquitoes: () => buildWildlife("mosquitoes"),
};
const DATA_FOR = { listings: "listings", supermarkets: "supermarkets", train: "transport_stops", tram: "transport_stops", bus: "transport_stops", bushfire: "bushfire", flood: "flood" };

function refresh(name) {
  if (layers[name]) map.removeLayer(layers[name]);
  delete layers[name];
  const box = document.querySelector(`[data-layer="${name}"]`);
  if (box.checked && DATA_FOR[name] && !data[DATA_FOR[name]]) { box.disabled = true; box.checked = false; }
  if (box.checked) layers[name] = builders[name]().addTo(map);
  updateKey();
}

// ---------- choropleth ----------
// Perceptually uniform ramps that read on a dark map: viridis when high is good,
// inferno when high is a cost (price, crime, public housing).
const RAMPS = {
  good_high: ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"],
  bad_high: ["#320a5e", "#781c6d", "#bc3754", "#ed6925", "#fbb61a"],
};
const CHORO = {
  median_hh_income_weekly: { ramp: "good_high", f: (v) => fmt.money(v) + "/wk", label: "Median household income" },
  pct_public_housing: { ramp: "bad_high", f: (v) => v.toFixed(1) + "%", label: "Public housing" },
  crime_rate_per_100k: { ramp: "bad_high", f: fmt.num, label: "Crime per 100k people" },
  median_house_price: { ramp: "bad_high", f: (v) => "$" + Math.round(v / 1000) + "k", label: "Median house price" },
  price_growth_5y_pct: { ramp: "good_high", f: fmt.pct, label: "House price growth, 5 yr" },
  price_growth_10y_pct: { ramp: "good_high", f: fmt.pct, label: "House price growth, 10 yr" },
};
let choroLegend = "";

function quantiles(vals, n) {
  const s = [...vals].sort((a, b) => a - b);
  return Array.from({ length: n - 1 }, (_, i) => s[Math.floor(((i + 1) / n) * (s.length - 1))]);
}

function buildChoropleth() {
  if (layers.choro) map.removeLayer(layers.choro);
  delete layers.choro;
  choroLegend = "";
  const key = document.getElementById("choropleth").value;
  const vals = key && data.suburbs ? data.suburbs.features.map((f) => f.properties[key]).filter((v) => v != null) : [];
  if (key && vals.length) {
    const ramp = RAMPS[CHORO[key].ramp], breaks = quantiles(vals, ramp.length);
    const colour = (v) => v == null ? "#2d333b" : ramp[breaks.filter((b) => v > b).length];
    layers.choro = L.geoJSON(data.suburbs, {
      style: (f) => ({ color: "rgba(255,255,255,.28)", weight: 0.6, fillColor: colour(f.properties[key]), fillOpacity: 0.42 }),
      onEachFeature: (f, l) => l.bindTooltip(`${esc(f.properties.name)}: ${f.properties[key] == null ? "no data" : CHORO[key].f(f.properties[key])}`, { sticky: true }),
    }).addTo(map);
    layers.choro.bringToBack();
    layers.choro.on("click", (e) => { L.popup({ maxWidth: 340 }).setLatLng(e.latlng).setContent(report([e.latlng.lng, e.latlng.lat])).openOn(map); });
    const lo = Math.min(...vals), hi = Math.max(...vals);
    choroLegend = `<div class="key-title">${CHORO[key].label}</div>
      <div class="bar">${ramp.map((c) => `<span style="background:${c}"></span>`).join("")}</div>
      <div class="ticks"><span>${CHORO[key].f(lo)}</span><span>${CHORO[key].f(breaks[Math.floor(breaks.length / 2)])}</span><span>${CHORO[key].f(hi)}</span></div>
      <div class="key-note">Each colour is a fifth of suburbs. Grey = no data.</div>`;
  }
  updateKey();
}

// ---------- map key ----------
const keyControl = L.control({ position: "bottomleft" });
keyControl.onAdd = () => {
  const div = L.DomUtil.create("div", "map-key");
  L.DomEvent.disableClickPropagation(div);
  L.DomEvent.disableScrollPropagation(div);
  return div;
};
keyControl.addTo(map);

function updateKey() {
  const el = keyControl.getContainer();
  if (!el) return;
  const on = (n) => !!layers[n];
  const zoomNote = (n) => layers[n]?.hiddenByZoom ? ` <span class="muted">(zoom in)</span>` : "";
  const rows = [];
  if (on("listings")) rows.push(`<span class="k-dot"></span>Listing`);
  for (const m of ["train", "tram", "bus"]) if (on(m)) rows.push(`<span class="k-ico">${MODES[m].emoji}</span>${MODES[m].label}${zoomNote(m)}`);
  if (on("supermarkets")) {
    rows.push(`<span class="k-ico">🛒</span>Supermarket${zoomNote("supermarkets")}<div class="k-brands">${
      ["Coles", "Woolworths", "ALDI", "IGA"].map((b) => `<span><i style="border-color:${BRAND_COLOURS[b]}"></i>${b}</span>`).join("")}</div>`);
  }
  if (on("bushfire")) for (const k of ["BPA", "BMO"]) rows.push(`<span class="k-sw" style="background:${HAZARD[k].fill}"></span>${HAZARD[k].label}`);
  if (on("flood")) rows.push(`<span class="k-sw" style="background:${HAZARD.flood.fill}"></span>${HAZARD.flood.label}`);
  const wild = ["snakes", "spiders", "mosquitoes"].filter(on);
  if (wild.length) rows.push(`<span class="k-sw k-grid"></span>Sightings: few → many`);
  el.innerHTML = rows.length || choroLegend
    ? `<div class="key-head">Map key</div>${rows.map((r) => `<div class="k-row">${r}</div>`).join("")}${choroLegend ? `<div class="k-choro">${choroLegend}</div>` : ""}`
    : "";
  el.style.display = el.innerHTML ? "" : "none";
}

// ---------- wiring ----------
map.on("click", (e) => {
  const ll = e.latlng.wrap();
  L.popup({ maxWidth: 340 }).setLatLng(ll).setContent(report([ll.lng, ll.lat])).openOn(map);
});

// "Load REA listings here": ask the extension (site-bridge.js) to load this search
// on realestate.com.au in a background tab of your browser.
const reaBtn = document.getElementById("rea-load"), reaHint = document.getElementById("rea-hint");
let haveExtension = false;
function reaSearchUrl() {
  const b = map.getBounds(), v = (id) => Math.max(0, Math.round(+document.getElementById(id).value || 0));
  const [min, max, land] = [v("rea-min"), v("rea-max"), v("rea-land")];
  const path = ["property-house", land ? `size-${land}` : "", min || max ? `between-${min}-${max || "any"}` : ""].filter(Boolean).join("-");
  const bbox = [b.getNorth(), b.getWest(), b.getSouth(), b.getEast()].map((x) => x.toFixed(6)).join(",");
  return `${REA}/buy/${path}/map-1?misc=ex-no-display-price&boundingBox=${encodeURIComponent(bbox)}&activeSort=price-asc&sourcePage=map`;
}
const REA_MIN_GAP_MS = 5000;  // at most one REA page load every 5 s
let reaLastLoad = 0, reaLastUrl = "", reaTimer = null;
function requestRea(force = false) {
  if (!haveExtension) return;
  const url = reaSearchUrl();
  if (!force && url === reaLastUrl) return;
  const wait = reaLastLoad + REA_MIN_GAP_MS - Date.now();
  clearTimeout(reaTimer);
  if (wait > 0) { reaTimer = setTimeout(() => requestRea(force), wait); return; }
  reaLastLoad = Date.now();
  reaLastUrl = url;
  siteDriven = true;
  reaHint.textContent = "Loading from realestate.com.au…";
  window.postMessage({ type: "dreamhouse:load", url }, location.origin);
}
if (reaBtn) {
  reaBtn.disabled = true;
  reaBtn.addEventListener("click", () => requestRea(true));
  const auto = document.getElementById("rea-auto");
  map.on("moveend", () => {
    if (auto.checked) { clearTimeout(reaTimer); reaTimer = setTimeout(() => requestRea(), 1200); }
  });
  ["rea-min", "rea-max", "rea-land"].forEach((id) => document.getElementById(id).addEventListener("change", () => auto.checked && requestRea()));
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    if (e.data?.type === "dreamhouse:extension") {
      haveExtension = true;
      reaBtn.disabled = false;
      reaHint.textContent = "Loads this map area on realestate.com.au in a background tab of your browser.";
    } else if (e.data?.type === "dreamhouse:load-status") {
      reaHint.textContent = e.data.text;
    } else if (e.data?.type === "dreamhouse:diag" && e.data.diag) {
      const d = e.data.diag;
      reaHint.textContent = d.visible > 0
        ? `Loaded ${d.visible} listings from realestate.com.au.`
        : d.listingsFound > 0
          ? "realestate.com.au returned listings, but none inside this map area."
          : `realestate.com.au loaded ("${d.title}") but no listings were found. ` +
            (d.hasArgonaut || d.jsonResponses ? "Its data format may have changed." : "It may be showing a check page; open the background tab and complete it.");
    }
  });
}

document.getElementById("search").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = document.getElementById("search-input").value.trim();
  if (!q) return;
  const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=au&q=${encodeURIComponent(q)}`);
  const [hit] = await r.json();
  if (!hit) { statusEl.textContent = `Couldn't find "${q}".`; return; }
  const pt = [+hit.lon, +hit.lat];
  map.setView([pt[1], pt[0]], 15);
  L.popup({ maxWidth: 340 }).setLatLng([pt[1], pt[0]]).setContent(report(pt, { properties: { address: hit.display_name, nbn_check: `https://www.nbnco.com.au/connect-home-or-business/check-your-address?address=${encodeURIComponent(q)}` } })).openOn(map);
});

document.querySelectorAll("[data-layer]").forEach((box) => box.addEventListener("change", () => refresh(box.dataset.layer)));
document.getElementById("budget-only").addEventListener("change", () => refresh("listings"));
document.getElementById("major-only").addEventListener("change", () => refresh("supermarkets"));
document.getElementById("choropleth").addEventListener("change", buildChoropleth);

// One-line summary per listing, shown as a badge on the realestate.com.au result cards.
function summarise(f) {
  const pt = f.geometry.coordinates, c = bestCommute(pt);
  const best = Object.entries(c).filter(([, v]) => v).sort(([, a], [, b]) => a.total - b.total)[0];
  const suburb = featuresAt("suburbs", pt)[0]?.properties;
  return {
    id: f.properties.id,
    cbd: best ? `${best[1].total} min by ${best[0]}` : null,
    growth10: suburb?.price_growth_10y_pct ?? null,
    income: suburb?.median_hh_income_weekly ?? null,
    publicHousing: suburb?.pct_public_housing ?? null,
    bushfire: featuresAt("bushfire", pt).length > 0,
    flood: featuresAt("flood", pt).length > 0,
  };
}

function fitListings() {
  const pts = (data.listings?.features || []).map((f) => [f.geometry.coordinates[1], f.geometry.coordinates[0]]);
  if (pts.length > 1) map.fitBounds(pts, { padding: [40, 40], maxZoom: 15 });
}

// Listings from your realestate.com.au tab, sent by the browser extension: either
// into the side panel on REA (EXTENSION) or into this site via site-bridge.js.
const REA = "https://www.realestate.com.au";
let lastBox = null, siteDriven = false;  // siteDriven: this map asked for the listings, so don't move it
function receiveListings(msg) {
  data.listings = { type: "FeatureCollection", features: (msg.features || []).filter((f) => Array.isArray(f?.geometry?.coordinates)) };
  refresh("listings");
  const box = msg.box && JSON.stringify(msg.box);
  if (box && box !== lastBox && !siteDriven) {
    lastBox = box;
    map.fitBounds([[msg.box.south, msg.box.west], [msg.box.north, msg.box.east]]);
  } else if (!box && !lastBox) fitListings();
  statusEl.textContent = `${data.listings.features.length} listings from your realestate.com.au tab.`;
}
if (!EXTENSION) {
  window.addEventListener("message", (e) => {
    if (e.source === window && e.origin === location.origin && e.data?.type === "dreamhouse:listings") receiveListings(e.data);
  });
}
if (EXTENSION) {
  window.addEventListener("message", (e) => {
    if (e.source !== window.parent || e.origin !== REA) return;
    if (e.data?.type !== "dreamhouse:listings") return;
    receiveListings(e.data);
    window.parent.postMessage({ type: "dreamhouse:summaries", items: data.listings.features.map(summarise) }, REA);
  });
  window.addEventListener("message", (e) => {
    if (e.source !== window.parent || e.origin !== REA || e.data?.type !== "dreamhouse:focus") return;
    const f = data.listings?.features.find((x) => x.properties.id === e.data.id);
    if (!f) return;
    const [lon, lat] = f.geometry.coordinates;
    map.setView([lat, lon], 16);
    L.popup({ maxWidth: 340 }).setLatLng([lat, lon]).setContent(report([lon, lat], f)).openOn(map);
  });
}

(async () => {
  const names = ["suburbs", "supermarkets", "transport_stops", "bushfire", "flood"];
  if (!EXTENSION) names.push("listings");
  else data.listings = { type: "FeatureCollection", features: [] };
  await Promise.all(names.map(load));
  Object.keys(builders).forEach(refresh);
  fitListings();
  if (EXTENSION) window.parent.postMessage({ type: "dreamhouse:ready" }, REA);
  else window.postMessage({ type: "dreamhouse:ready" }, location.origin);  // lets site-bridge.js resend
})();
