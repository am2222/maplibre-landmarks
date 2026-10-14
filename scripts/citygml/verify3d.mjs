// Verify 3D MVT tiles: read the PMTiles with the repo's `pmtiles`, parse with @mapbox/vector-tile,
// decode geometry with a port of Maptoolkit's Fill3DBucket.loadGeometry, triangulate like its addFeature,
// and compare decoded vertices with the source NDJSON.
// usage: node scripts/citygml/verify3d.mjs <archive.pmtiles> <surfaces.ndjson> [maptoolkit-tile.pbf]
// @mapbox/vector-tile, pbf and earcut come in with maplibre-gl.
import fs from 'node:fs';
import { VectorTile } from '@mapbox/vector-tile';
import earcut from 'earcut';
import { PbfReader as Pbf } from 'pbf';
import { PMTiles } from 'pmtiles';

const [archivePath, ndjsonPath, refTilePath] = process.argv.slice(2);

// --- port of mtk.js Fill3DBucket.loadGeometry (extent scaling dropped: ours is already 4096) ---
function loadGeometry(feature) {
  const pbf = feature._pbf;
  pbf.pos = feature._geometry;
  const end = pbf.readVarint() + pbf.pos;
  let cmd = 1,
    length = 0,
    x = 0,
    y = 0,
    z = 0,
    poly = [],
    ring = null;
  const polys = [];
  while (pbf.pos < end) {
    if (length <= 0) {
      const c = pbf.readVarint();
      cmd = c & 7;
      length = c >> 3;
    }
    length--;
    if (cmd === 1 || cmd === 2) {
      if (cmd === 1) ring = [];
      x += pbf.readSVarint();
      y += pbf.readSVarint();
      z += pbf.readSVarint();
      ring.push({ x, y, z });
    } else if (cmd === 7) {
      if (length) {
        poly.push(ring);
        polys.push(poly);
        poly = [];
        length--;
      } else polys[polys.length - 1].push(ring);
    } else throw new Error(`unknown command ${cmd}`);
  }
  return polys;
}

function newellNormal(r) {
  const n = [0, 0, 0];
  for (let i = 0; i < r.length; i++) {
    const a = r[i],
      b = r[(i + 1) % r.length];
    n[0] += (a.y - b.y) * (a.z + b.z);
    n[1] += (a.z - b.z) * (a.x + b.x);
    n[2] += (a.x - b.x) * (a.y + b.y);
  }
  const l = Math.hypot(...n);
  return n.map((v) => v / l);
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function to2D(p, n) {
  const r = [p.x, p.y, p.z],
    u = [1.1, 1.1, 1.1];
  const d = dot(u, n);
  for (let i = 0; i < 3; i++) u[i] -= n[i] * d;
  const l = Math.hypot(...u);
  for (let i = 0; i < 3; i++) u[i] /= l;
  const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  return [dot(r, u), dot(r, v)];
}

// --- triangulate like mtk addFeature; report counts and failures ---
function triangulate(polys) {
  let triangles = 0,
    failed = 0,
    nanNormals = 0;
  for (const poly of polys) {
    const flat = [],
      holes = [];
    for (let i = 0; i < poly.length; i++) {
      if (i) holes.push(flat.length / 2);
      const normal = newellNormal(poly[i]);
      if (normal.some(Number.isNaN)) nanNormals++;
      for (const p of poly[i]) flat.push(...to2D(p, normal));
    }
    const tri = flat.length === 6 ? [0, 1, 2] : earcut(flat, holes, 2);
    if (tri.length === 0) failed++;
    triangles += tri.length / 3;
  }
  return { triangles, failed, nanNormals };
}

function inspect(name, buf) {
  const tile = new VectorTile(new Pbf(buf));
  const layer = tile.layers.buildings3d;
  const out = {
    features: layer.length,
    polygons: 0,
    vertices: 0,
    triangles: 0,
    failed: 0,
    nanNormals: 0,
    types: {},
    decoded: [],
  };
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    out.types[f.type] = (out.types[f.type] || 0) + 1;
    const polys = loadGeometry(f);
    const header = polys.shift()[0];
    if (header.length !== 2)
      throw new Error(`${name}: feature ${i} header has ${header.length} points`);
    out.polygons += polys.length;
    out.vertices += polys.flat(2).length;
    const t = triangulate(polys);
    out.triangles += t.triangles;
    out.failed += t.failed;
    out.nanNormals += t.nanNormals;
    out.decoded.push({ id: f.id, props: f.properties, header, polys });
  }
  return out;
}

// 1. sanity: the port reads Maptoolkit's own tile
if (refTilePath) {
  const ref = inspect('vienna-ref', fs.readFileSync(refTilePath));
  const summary = { ...ref, decoded: undefined };
  console.log('Maptoolkit reference tile:', summary);
}

// 2. our archive through the repo's pmtiles reader
class FileSource {
  constructor(path) {
    this.path = path;
    this.fd = fs.openSync(path, 'r');
  }
  getKey() {
    return this.path;
  }
  async getBytes(offset, length) {
    const buf = new Uint8Array(length);
    fs.readSync(this.fd, buf, 0, length, offset);
    return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + length) };
  }
}
const archive = new PMTiles(new FileSource(archivePath));
const header = await archive.getHeader();
const meta = await archive.getMetadata();
console.log(
  'PMTiles header:',
  {
    tileType: header.tileType,
    compression: header.tileCompression,
    minZoom: header.minZoom,
    maxZoom: header.maxZoom,
    entries: header.numAddressedTiles,
  },
  'layers:',
  meta.vector_layers.map((l) => l.id),
);

// source vertices per building/kind, in tile units, for the round-trip check
const WORLD = 40075016.68557849,
  HALF = WORLD / 2,
  TILE_M = WORLD / 2 ** 15;
const source = new Map();
for (const line of fs.readFileSync(ndjsonPath, 'utf8').split('\n')) {
  if (!line) continue;
  const r = JSON.parse(line);
  const key = `${r.tx}/${r.ty}`;
  if (!source.has(key)) source.set(key, []);
  const x0 = r.tx * TILE_M - HALF,
    y0 = HALF - r.ty * TILE_M;
  for (const poly of r.g)
    for (const ring of poly)
      for (const [x, y, z] of ring)
        source.get(key).push({
          b: r.b,
          k: r.k,
          x: ((x - x0) / TILE_M) * 4096,
          y: ((y0 - y) / TILE_M) * 4096,
          z: z * 10,
        });
}

let maxErr = [0, 0, 0];
for (const key of source.keys()) {
  const [x, y] = key.split('/').map(Number);
  const res = await archive.getZxy(15, x, y);
  const t = inspect(key, new Uint8Array(res.data));
  const { decoded } = t;
  const summary = { ...t, decoded: undefined };
  // every decoded vertex must sit within half a unit of some source vertex of the same building and kind
  const byBk = new Map();
  for (const p of source.get(key)) {
    const k = `${p.b}|${p.k}`;
    if (!byBk.has(k)) byBk.set(k, []);
    byBk.get(k).push(p);
  }
  let checked = 0;
  for (const f of decoded) {
    const cands = byBk.get(`${f.id}|${f.props.type}`);
    if (!cands) throw new Error(`${key}: feature ${f.id}/${f.props.type} not in source`);
    for (const p of f.polys.flat(2)) {
      let best = null,
        bestD = Infinity;
      for (const c of cands) {
        const d = (c.x - p.x) ** 2 + (c.y - p.y) ** 2 + (c.z - p.z) ** 2;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      maxErr = maxErr.map((m, i) =>
        Math.max(m, Math.abs([best.x - p.x, best.y - p.y, best.z - p.z][i])),
      );
      checked++;
    }
  }
  console.log(`15/${key}:`, summary, `round-trip checked ${checked} vertices`);
}
console.log(
  'max |error| vs source (tile units x, tile units y, dm z):',
  maxErr.map((v) => v.toFixed(3)),
);
console.log(
  '= metres (real, at 48.2°N):',
  [
    ((maxErr[0] * TILE_M) / 4096) * Math.cos((48.2 * Math.PI) / 180),
    ((maxErr[1] * TILE_M) / 4096) * Math.cos((48.2 * Math.PI) / 180),
    maxErr[2] / 10,
  ].map((v) => v.toFixed(3)),
);
