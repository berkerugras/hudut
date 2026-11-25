// Turns Natural Earth country shapes (world-atlas) into the game's ownership grid.
// Result is cached in data/ so the server starts fast after the first run.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { feature } from 'topojson-client';
import { GRID_W, GRID_H, CELL_DEG, OCEAN, ICE } from '../shared/constants.js';

const require = createRequire(import.meta.url);
const isoLib = require('i18n-iso-countries');
isoLib.registerLocale(require('i18n-iso-countries/langs/tr.json'));

const here = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(here, '..', 'data');
const BASE_FILE = path.join(DATA_DIR, 'base-grid.bin');
const COUNTRY_FILE = path.join(DATA_DIR, 'countries.json');
const CACHE_VERSION = 5;

// Names world-atlas gives without an ISO code, or that read better in Turkish.
const NAME_FIX = {
  Kosovo: 'Kosova',
  'N. Cyprus': 'Kuzey Kıbrıs',
  Somaliland: 'Somaliland',
  'W. Sahara': 'Batı Sahra',
};

function turkishName(f) {
  const en = f.properties && f.properties.name ? f.properties.name : 'Bilinmeyen';
  if (NAME_FIX[en]) return NAME_FIX[en];
  if (f.id) {
    const a2 = isoLib.numericToAlpha2(String(f.id).padStart(3, '0'));
    const tr = a2 && isoLib.getName(a2, 'tr');
    if (tr) return tr;
  }
  return en;
}

function hsl(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
  return '#' + to(f(0)) + to(f(8)) + to(f(4));
}

function ringsOf(geom) {
  if (!geom) return [];
  if (geom.type === 'Polygon') return geom.coordinates;
  if (geom.type === 'MultiPolygon') return geom.coordinates.flat();
  return [];
}

// Rings that cross the date line jump from +180 to -180. Make longitudes continuous so the scanline
// fill does not paint the whole row between the two jumps. Rings around a pole (Antarctica) cannot
// be unwrapped and stay as they are.
function unwrapRing(ring) {
  const out = [ring[0]];
  let shift = 0;
  for (let i = 1; i < ring.length; i++) {
    const d = ring[i][0] + shift - out[i - 1][0];
    if (d > 180) shift -= 360;
    else if (d < -180) shift += 360;
    out.push([ring[i][0] + shift, ring[i][1]]);
  }
  return Math.abs(out[out.length - 1][0] - out[0][0]) < 180 ? out : ring;
}

// Even-odd scanline fill at cell centers.
function rasterize(grid, rawRings, id) {
  let minLat = 90, maxLat = -90;
  const edges = [];
  const rings = rawRings.map(unwrapRing);
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x1, y1] = ring[j];
      const [x2, y2] = ring[i];
      if (y1 === y2) continue;
      edges.push(x1, y1, x2, y2);
      minLat = Math.min(minLat, y1, y2);
      maxLat = Math.max(maxLat, y1, y2);
    }
  }
  if (!edges.length) return 0;
  const rowTop = Math.max(0, Math.floor((90 - maxLat) / CELL_DEG));
  const rowBot = Math.min(GRID_H - 1, Math.floor((90 - minLat) / CELL_DEG));
  let count = 0;
  const xs = [];
  for (let cy = rowTop; cy <= rowBot; cy++) {
    const lat = 90 - (cy + 0.5) * CELL_DEG;
    xs.length = 0;
    for (let e = 0; e < edges.length; e += 4) {
      const x1 = edges[e], y1 = edges[e + 1], x2 = edges[e + 2], y2 = edges[e + 3];
      if ((y1 > lat) !== (y2 > lat)) xs.push(x1 + ((lat - y1) * (x2 - x1)) / (y2 - y1));
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.ceil((xs[k] + 180) / CELL_DEG - 0.5);
      const c1 = Math.min(c0 + GRID_W - 1, Math.floor((xs[k + 1] + 180) / CELL_DEG - 0.5));
      for (let cx = c0; cx <= c1; cx++) {
        grid[cy * GRID_W + (((cx % GRID_W) + GRID_W) % GRID_W)] = id;
        count++;
      }
    }
  }
  return count;
}

function centroidCell(rings) {
  // Center of the largest ring's bounding box: good enough for tiny islands.
  let best = null, bestArea = -1;
  for (const r of rings) {
    let x0 = 180, x1 = -180, y0 = 90, y1 = -90;
    for (const [x, y] of r) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const a = (x1 - x0) * (y1 - y0);
    if (a > bestArea) { bestArea = a; best = [(x0 + x1) / 2, (y0 + y1) / 2]; }
  }
  if (!best) return -1;
  const cx = Math.min(GRID_W - 1, Math.max(0, Math.floor((best[0] + 180) / CELL_DEG)));
  const cy = Math.min(GRID_H - 1, Math.max(0, Math.floor((90 - best[1]) / CELL_DEG)));
  return cy * GRID_W + cx;
}

function build() {
  const topo = require('world-atlas/countries-50m.json');
  const fc = feature(topo, topo.objects.countries);
  const grid = new Uint8Array(GRID_W * GRID_H); // OCEAN = 0
  const features = fc.features.filter((f) => f.geometry);
  // Rasterize large countries first so small ones drawn later keep their cells.
  features.sort((a, b) => ringsOf(b.geometry).flat().length - ringsOf(a.geometry).flat().length);

  const countries = [];
  let next = 1;
  for (const f of features) {
    const rings = ringsOf(f.geometry);
    if (f.properties && f.properties.name === 'Antarctica') { rasterize(grid, rings, ICE); continue; }
    if (next >= ICE) break;
    const id = next;
    let cells = rasterize(grid, rings, id);
    if (cells === 0) {
      const c = centroidCell(rings);
      if (c >= 0 && grid[c] === OCEAN) { grid[c] = id; cells = 1; }
    }
    if (cells === 0) continue; // micro-states inside other countries: too small for this grid
    countries.push({ id, name: turkishName(f), nameEn: f.properties.name || '', iso: f.id ? String(f.id) : '' });
    next++;
  }
  // Later countries may have overwritten earlier cells: recount and drop countries left empty.
  const counts = new Array(256).fill(0);
  for (let i = 0; i < grid.length; i++) counts[grid[i]]++;
  const alive = countries.filter((c) => counts[c.id] > 0);
  // Overseas territories share their parent's ISO code (e.g. Ashmore Is. -> Australia): keep names unique.
  const byName = new Map();
  for (const c of alive) {
    const prev = byName.get(c.name);
    if (!prev) { byName.set(c.name, c); continue; }
    const small = counts[prev.id] < counts[c.id] ? prev : c;
    small.name = small.nameEn || small.name + ' ' + small.id;
    byName.set(c.name === small.name ? prev.name : c.name, small === c ? prev : c);
  }
  alive.forEach((c, i) => {
    const hue = (i * 137.508) % 360;
    c.color = hsl(hue, 42 + (i % 3) * 8, 56 + (i % 4) * 4);
    c.baseCells = counts[c.id];
  });
  return { grid, countries: alive };
}

export function loadBaseMap() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const meta = JSON.parse(fs.readFileSync(COUNTRY_FILE, 'utf8'));
    if (meta.version === CACHE_VERSION) {
      const buf = fs.readFileSync(BASE_FILE);
      if (buf.length === GRID_W * GRID_H) return { grid: new Uint8Array(buf), countries: meta.countries };
    }
  } catch { /* no cache yet */ }
  const t0 = Date.now();
  const res = build();
  fs.writeFileSync(BASE_FILE, res.grid);
  fs.writeFileSync(COUNTRY_FILE, JSON.stringify({ version: CACHE_VERSION, countries: res.countries }));
  console.log(`[harita] ${res.countries.length} ülke ızgaraya çevrildi (${Date.now() - t0} ms)`);
  return res;
}
