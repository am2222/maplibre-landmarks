// Build an Overture-schema building tileset straight from OpenStreetMap (via Overpass) for a
// bounding box. Unlike Overture, it keeps every raw roof:shape value (side_hipped, butterfly,
// crosspitched, ...) and roof:angle.
// Usage: node scripts/buildings/osm-to-pmtiles.mjs <west> <south> <east> <north> <out.pmtiles>
// Needs: tippecanoe >= 2.17. Set OVERPASS_URL to use another Overpass server. Data © OSM (ODbL).
/* global process, console, fetch, setTimeout, URLSearchParams */
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SERVERS = process.env.OVERPASS_URL
  ? [process.env.OVERPASS_URL]
  : [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
      'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    ];
/** Rounds over every server before giving up (public servers are often briefly overloaded). */
const ROUNDS = 3;
/** Metres per level when only building:levels is tagged (as in Simple 3D Buildings). */
const LEVEL_M = 3;

const args = process.argv.slice(2);
if (args.length < 5) {
  console.error('usage: osm-to-pmtiles.mjs <west> <south> <east> <north> <out.pmtiles>');
  process.exit(1);
}
const [W, S, E, N] = args.slice(0, 4).map(Number);
const out = args[4];

const bbox = `(${S},${W},${N},${E})`;
const query = `[out:json][timeout:180];
(way["building"]${bbox};way["building:part"]${bbox};
 relation["building"]["type"="multipolygon"]${bbox};
 relation["building:part"]["type"="multipolygon"]${bbox};);
out geom;`;

async function overpass() {
  for (let round = 1; round <= ROUNDS; round++) {
    for (const url of SERVERS) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'User-Agent': 'maplibre-landmarks/osm-to-pmtiles' },
          body: new URLSearchParams({ data: query }),
        });
        const text = await res.text();
        if (res.ok && text.startsWith('{')) return JSON.parse(text);
        console.warn(`${url}: HTTP ${res.status}`);
      } catch (err) {
        console.warn(`${url}: ${err.message}`);
      }
    }
    if (round < ROUNDS) await new Promise((r) => setTimeout(r, 10_000 * round));
  }
  throw new Error('every Overpass server failed; set OVERPASS_URL or try a smaller box');
}

/** "12", "12 m", "12.5m" → metres; "40'" / "40 ft" → metres; anything else → undefined. */
function metres(v) {
  if (v === undefined) return undefined;
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(m|ft|')?\s*$/i.exec(String(v).replace(',', '.'));
  if (!m) return undefined;
  const n = Number(m[1]);
  return m[2] && m[2] !== 'm' && m[2] !== 'M' ? n * 0.3048 : n;
}
const number = (v) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : undefined);

const ring = (geometry) => geometry.map((p) => [p.lon, p.lat]);
const closed = (r) => r.length >= 4 && r[0][0] === r.at(-1)[0] && r[0][1] === r.at(-1)[1];

/** Join way segments end to end into closed rings. */
function joinRings(segments) {
  const rings = [];
  const open = segments.filter((s) => s.length >= 2).map((s) => [...s]);
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];
  while (open.length) {
    let cur = open.shift();
    let grown = true;
    while (!closed(cur) && grown) {
      grown = false;
      for (let i = 0; i < open.length; i++) {
        const s = open[i];
        if (same(cur.at(-1), s[0])) cur = [...cur, ...s.slice(1)];
        else if (same(cur.at(-1), s.at(-1))) cur = [...cur, ...[...s].reverse().slice(1)];
        else continue;
        open.splice(i, 1);
        grown = true;
        break;
      }
    }
    if (closed(cur)) rings.push(cur);
  }
  return rings;
}

function inside([x, y], r) {
  let hit = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i];
    const [xj, yj] = r[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Polygons (outer + holes) of a way or multipolygon relation, or [] when they don't close. */
function polygonsOf(el) {
  if (el.type === 'way') {
    const r = ring(el.geometry ?? []);
    return closed(r) ? [[r]] : [];
  }
  const members = (el.members ?? []).filter((m) => m.type === 'way' && m.geometry);
  const outers = joinRings(members.filter((m) => m.role !== 'inner').map((m) => ring(m.geometry)));
  const inners = joinRings(members.filter((m) => m.role === 'inner').map((m) => ring(m.geometry)));
  const polygons = outers.map((o) => [o]);
  for (const h of inners) polygons.find(([o]) => inside(h[0], o))?.push(h);
  return polygons;
}

/** Area-weighted centroid of a ring (falls back to its first vertex). */
function centroid(r) {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i + 1 < r.length; i++) {
    const f = r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
    a += f;
    cx += (r[i][0] + r[i + 1][0]) * f;
    cy += (r[i][1] + r[i + 1][1]) * f;
  }
  return a ? [cx / (3 * a), cy / (3 * a)] : r[0];
}

/** OSM tags → the Overture-style attributes RoofsLayer reads. */
function attributes(t) {
  const roofHeight = metres(t['roof:height']) ?? (number(t['roof:levels']) ?? 0) * LEVEL_M;
  const levels = number(t['building:levels']);
  const height =
    metres(t.height) ?? (levels !== undefined ? levels * LEVEL_M + roofHeight : undefined);
  const minHeight = metres(t.min_height) ?? (number(t['building:min_level']) ?? 0) * LEVEL_M;
  const a = {
    height,
    min_height: minHeight || undefined,
    roof_shape: t['roof:shape']?.trim().toLowerCase(),
    roof_height: roofHeight || undefined,
    roof_angle: number(t['roof:angle']),
    roof_direction: t['roof:direction'],
    roof_orientation: t['roof:orientation'],
    roof_color: t['roof:colour'],
    roof_material: t['roof:material'],
    facade_color: t['building:colour'],
    facade_material: t['building:material'],
  };
  return Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined && v !== ''));
}

const { elements } = await overpass();
const outlines = [];
const parts = [];
const seen = new Set();
for (const el of elements) {
  const key = `${el.type}/${el.id}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const t = el.tags ?? {};
  const isPart = t['building:part'] !== undefined && t['building:part'] !== 'no';
  if (!isPart && (t.building === undefined || t.building === 'no')) continue;
  const polygons = polygonsOf(el);
  if (!polygons.length) continue;
  // Way and relation ids share one numeric space: ways even, relations odd.
  const id = el.id * 2 + (el.type === 'relation' ? 1 : 0);
  (isPart ? parts : outlines).push({ id, polygons, props: attributes(t) });
}

// An outline with parts inside it is drawn by those parts (Overture's has_parts).
const partPoints = parts.map((p) => centroid(p.polygons[0][0]));
for (const o of outlines) {
  o.props.has_parts = partPoints.some((pt) => o.polygons.some(([outer]) => inside(pt, outer)));
}

const features = [...outlines, ...parts].map(({ id, polygons, props }) =>
  JSON.stringify({
    type: 'Feature',
    properties: { fid: id, ...props },
    geometry:
      polygons.length === 1
        ? { type: 'Polygon', coordinates: polygons[0] }
        : { type: 'MultiPolygon', coordinates: polygons },
  }),
);

const tmp = await mkdtemp(join(tmpdir(), 'osm-buildings-'));
try {
  const seq = join(tmp, 'buildings.geojsonseq');
  await writeFile(seq, features.join('\n') + '\n');
  const run = spawnSync(
    'tippecanoe',
    [
      '--quiet',
      ...['-o', out, '--force', '-l', 'building', '-Z13', '-z15'],
      '--use-attribute-for-id=fid',
      '--no-feature-limit',
      '--no-tile-size-limit',
      '--no-line-simplification',
      '--no-tiny-polygon-reduction',
      seq,
    ],
    { stdio: 'inherit' },
  );
  if (run.error) throw run.error;
  if (run.status !== 0) process.exit(run.status ?? 1);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
const shapes = {};
for (const f of [...outlines, ...parts]) {
  const s = f.props.roof_shape;
  if (s) shapes[s] = (shapes[s] ?? 0) + 1;
}
console.log(`wrote ${out}: ${outlines.length} buildings, ${parts.length} parts`, shapes);
