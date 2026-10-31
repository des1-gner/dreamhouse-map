// Dreamhouse Finder: listings + suburb overlays on a Leaflet map.
// All data comes from web/data/*.geojson (built by scripts/), except the wildlife
// density tiles which load live from the Atlas of Living Australia.

const map = L.map("map", { preferCanvas: true }).setView([-38.07, 145.32], 11);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  className: "basemap",
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

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
    const r = await fetch(`data/${name}.geojson`);
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

  if (p?.wildlife) {
    const w = p.wildlife;
    h += `<h4>Wildlife sightings within ${p.wildlife_radius_km} km</h4><div>🐍 ${w.snakes} · 🕷️ ${w.spiders} · 🦟 ${w.mosquitoes}</div>`;
  }

  const addr = p?.address;
  h += `<div class="links" style="margin-top:8px">`;
  if (p?.url) h += `<a href="${esc(p.url)}" target="_blank" rel="noopener">Listing</a>`;
  h += `<a href="${esc(p?.nbn_check || "https://www.nbnco.com.au/connect-home-or-business/check-your-address")}" target="_blank" rel="noopener">Check NBN</a>`;
  h += `<a href="https://www.google.com/maps?q=${pt[1]},${pt[0]}" target="_blank" rel="noopener">Google Maps</a>`;
  h += `</div></div>`;
  return h;
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
function buildListings() {
  const budgetOnly = document.getElementById("budget-only").checked;
  const feats = (data.listings?.features || []).filter((f) => !budgetOnly || f.properties.in_budget);
  document.getElementById("count-listings").textContent = `(${feats.length})`;
  return L.layerGroup(feats.map((f) => {
    const [lon, lat] = f.geometry.coordinates;
    const icon = L.divIcon({ className: "", html: `<div class="pin ${f.properties.in_budget ? "in" : "out"}"></div>`, iconSize: [18, 18], iconAnchor: [9, 18] });
    return L.marker([lat, lon], { icon }).bindPopup(() => report([lon, lat], f), { maxWidth: 340 });
  }));
}

const BRAND_COLOURS = { Coles: "#e01a22", Woolworths: "#178841", ALDI: "#00205b", Costco: "#005daa", IGA: "#d6001c", FoodWorks: "#7a2", Other: "#888" };
function buildSupermarkets() {
  const majorOnly = document.getElementById("major-only").checked;
  return L.geoJSON(data.supermarkets, {
    filter: (f) => !majorOnly || f.properties.major,
    pointToLayer: (f, ll) => L.circleMarker(ll, { radius: 6, weight: 2, color: "#fff", fillColor: BRAND_COLOURS[f.properties.brand] || "#888", fillOpacity: 1 }),
    onEachFeature: (f, l) => l.bindTooltip(esc(f.properties.name)),
  });
}

const MODE_STYLE = { train: { radius: 7, fillColor: "#0072ce" }, tram: { radius: 4, fillColor: "#78be20" }, bus: { radius: 3, fillColor: "#ff8200" } };
function buildStops(mode) {
  return L.geoJSON(data.transport_stops, {
    filter: (f) => f.properties.mode === mode,
    pointToLayer: (f, ll) => L.circleMarker(ll, { ...MODE_STYLE[mode], color: "#fff", weight: 1, fillOpacity: 0.95 }),
    onEachFeature: (f, l) => {
      const p = f.properties;
      l.bindTooltip(`<b>${esc(p.name)}</b><br>${p.cbd_minutes != null ? `${p.cbd_minutes} min to CBD` : "no CBD estimate"}${p.cbd_via ? `<br><span style="color:#666">${esc(p.cbd_via)}</span>` : ""}${p.routes?.length ? `<br>Routes: ${esc(p.routes.slice(0, 8).join(", "))}` : ""}`);
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
    layers: "ALA:occurrences", format: "image/png", transparent: true, opacity: 0.55, styles: "",
    q, fq: "year:[2010 TO *]", ENV: "colormode:grid;name:circle;size:4;opacity:0.8",
    attribution: '<a href="https://www.ala.org.au/">Atlas of Living Australia</a>',
  });
}

const builders = {
  listings: buildListings,
  supermarkets: buildSupermarkets,
  train: () => buildStops("train"),
  tram: () => buildStops("tram"),
  bus: () => buildStops("bus"),
  bushfire: () => buildPolys("bushfire", (f) => ({ color: "#d1242f", weight: 1, fillColor: f.properties.kind === "BMO" ? "#d1242f" : "#fb8f44", fillOpacity: 0.25 })),
  flood: () => buildPolys("flood", () => ({ color: "#0969da", weight: 1, fillColor: "#54aeff", fillOpacity: 0.3 })),
  snakes: () => buildWildlife("snakes"),
  spiders: () => buildWildlife("spiders"),
  mosquitoes: () => buildWildlife("mosquitoes"),
};
const DATA_FOR = { listings: "listings", supermarkets: "supermarkets", train: "transport_stops", tram: "transport_stops", bus: "transport_stops", bushfire: "bushfire", flood: "flood" };

function refresh(name) {
  if (layers[name]) map.removeLayer(layers[name]);
  delete layers[name];
  const box = document.querySelector(`[data-layer="${name}"]`);
  if (!box.checked) return;
  if (DATA_FOR[name] && !data[DATA_FOR[name]]) { box.disabled = true; box.checked = false; return; }
  layers[name] = builders[name]().addTo(map);
  if (layers.listings && name !== "listings") layers.listings.eachLayer((m) => m.setZIndexOffset?.(1000));
}

// ---------- choropleth ----------
const RAMPS = {
  good_high: ["#f7fcf5", "#c7e9c0", "#74c476", "#31a354", "#006d2c"],
  bad_high: ["#fff5eb", "#fdd0a2", "#fd8d3c", "#e6550d", "#a63603"],
};
const CHORO = {
  median_hh_income_weekly: { ramp: "good_high", f: (v) => fmt.money(v) },
  pct_public_housing: { ramp: "bad_high", f: (v) => v.toFixed(1) + "%" },
  crime_rate_per_100k: { ramp: "bad_high", f: fmt.num },
  median_house_price: { ramp: "bad_high", f: (v) => "$" + Math.round(v / 1000) + "k" },
  price_growth_5y_pct: { ramp: "good_high", f: fmt.pct },
  price_growth_10y_pct: { ramp: "good_high", f: fmt.pct },
};

function quantiles(vals, n) {
  const s = [...vals].sort((a, b) => a - b);
  return Array.from({ length: n - 1 }, (_, i) => s[Math.floor(((i + 1) / n) * (s.length - 1))]);
}

function buildChoropleth() {
  if (layers.choro) map.removeLayer(layers.choro);
  const key = document.getElementById("choropleth").value, legend = document.getElementById("legend");
  legend.innerHTML = "";
  if (!key) return;
  if (!data.suburbs) { legend.textContent = "Suburb data not built yet."; return; }
  const vals = data.suburbs.features.map((f) => f.properties[key]).filter((v) => v != null);
  if (!vals.length) { legend.textContent = "No values for this metric."; return; }
  const ramp = RAMPS[CHORO[key].ramp], breaks = quantiles(vals, ramp.length);
  const colour = (v) => v == null ? "#ddd" : ramp[breaks.filter((b) => v > b).length];
  layers.choro = L.geoJSON(data.suburbs, {
    style: (f) => ({ color: "#555", weight: 0.6, fillColor: colour(f.properties[key]), fillOpacity: 0.6 }),
    onEachFeature: (f, l) => l.bindTooltip(`${esc(f.properties.name)}: ${f.properties[key] == null ? "–" : CHORO[key].f(f.properties[key])}`, { sticky: true }),
  }).addTo(map);
  layers.choro.bringToBack();
  layers.choro.on("click", (e) => { L.popup({ maxWidth: 340 }).setLatLng(e.latlng).setContent(report([e.latlng.lng, e.latlng.lat])).openOn(map); });
  const ticks = [Math.min(...vals), ...breaks, Math.max(...vals)];
  legend.innerHTML = `<div class="bar">${ramp.map((c) => `<span style="background:${c}"></span>`).join("")}</div>
    <div class="ticks"><span>${CHORO[key].f(ticks[0])}</span><span>${CHORO[key].f(ticks[Math.floor(ticks.length / 2)])}</span><span>${CHORO[key].f(ticks.at(-1))}</span></div>`;
}

// ---------- wiring ----------
map.on("click", (e) => {
  L.popup({ maxWidth: 340 }).setLatLng(e.latlng).setContent(report([e.latlng.lng, e.latlng.lat])).openOn(map);
});

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

(async () => {
  await Promise.all(["listings", "suburbs", "supermarkets", "transport_stops", "bushfire", "flood"].map(load));
  Object.keys(builders).forEach(refresh);
  const pts = (data.listings?.features || []).map((f) => [f.geometry.coordinates[1], f.geometry.coordinates[0]]);
  if (pts.length > 1) map.fitBounds(pts, { padding: [40, 40] });
})();
