// Vienna LOD2 CityGML as 3D vector tiles (scripts/citygml/build-vienna.sh writes the archive).
// Study page: decodes Maptoolkit-style 3D MVT (xyz deltas, z in dm, bbox header ring per feature),
// triangulates each wall/roof surface on its own plane and draws it with the shared ThreeCore.
import { Map as MlMap, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { PMTiles } from 'pmtiles';
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  ShapeUtils,
  Vector2,
} from 'three';
import {
  localPosition,
  ModuleLayer,
  originAt,
  type LayerModule,
  type LngLat,
  type ModuleContext,
  type Origin,
} from '../src/index';

setWorkerUrl(workerUrl);

const ARCHIVE = `${import.meta.env.BASE_URL}vienna-lod2.pmtiles`;
const EXTENT = 4096;
const COLORS = { roof: new Color('#b4553f'), wall: new Color('#ece6da') };

// --- minimal protobuf reading (MVT tile -> layer -> feature) ---

type Field = { tag: number; value: number } | { tag: number; start: number; end: number };

function readVarint(buf: Uint8Array, at: { pos: number }): number {
  let value = 0;
  let shift = 0;
  for (;;) {
    const b = buf[at.pos++]!;
    value += (b & 0x7f) * 2 ** shift;
    if (b < 0x80) return value;
    shift += 7;
  }
}

function* fields(buf: Uint8Array, start: number, end: number): Generator<Field> {
  const at = { pos: start };
  while (at.pos < end) {
    const key = readVarint(buf, at);
    const tag = key >> 3;
    if ((key & 7) === 0) yield { tag, value: readVarint(buf, at) };
    else {
      const len = readVarint(buf, at);
      yield { tag, start: at.pos, end: at.pos + len };
      at.pos += len;
    }
  }
}

function packed(buf: Uint8Array, start: number, end: number): number[] {
  const at = { pos: start };
  const out: number[] = [];
  while (at.pos < end) out.push(readVarint(buf, at));
  return out;
}

const unzigzag = (n: number) => (n % 2 ? -(n + 1) / 2 : n / 2);

type P3 = [number, number, number];
interface Feature3D {
  kind: 'roof' | 'wall';
  /** Lowest corner of the whole building (tile units, tile units, decimetres). */
  low: P3;
  /** Polygons: exterior ring first, then holes. */
  polygons: P3[][][];
}

/** One `buildings3d` layer: a header ring per feature, ClosePath 2 ends an exterior, 1 a hole. */
function decodeTile(buf: Uint8Array): Feature3D[] {
  const out: Feature3D[] = [];
  for (const layer of fields(buf, 0, buf.length)) {
    if (layer.tag !== 3 || !('start' in layer)) continue;
    const values: string[] = [];
    const raw: { tags: number[]; geom: number[] }[] = [];
    for (const f of fields(buf, layer.start, layer.end)) {
      if (!('start' in f)) continue;
      if (f.tag === 4)
        for (const v of fields(buf, f.start, f.end))
          if (v.tag === 1 && 'start' in v)
            values.push(new TextDecoder().decode(buf.subarray(v.start, v.end)));
      if (f.tag === 2) {
        const feat = { tags: [] as number[], geom: [] as number[] };
        for (const ff of fields(buf, f.start, f.end)) {
          if (ff.tag === 2 && 'start' in ff) feat.tags = packed(buf, ff.start, ff.end);
          if (ff.tag === 4 && 'start' in ff) feat.geom = packed(buf, ff.start, ff.end);
        }
        raw.push(feat);
      }
    }
    for (const { tags, geom } of raw) {
      const kind = values[tags[1] ?? 1] === 'roof' ? 'roof' : 'wall';
      const polygons: P3[][][] = [];
      let x = 0,
        y = 0,
        z = 0,
        i = 0;
      let ring: P3[] = [];
      let header: P3[] | undefined;
      while (i < geom.length) {
        const cmd = geom[i++]!;
        const id = cmd & 7;
        const count = cmd >> 3;
        if (id === 1 || id === 2) {
          if (id === 1) ring = [];
          for (let n = 0; n < count; n++) {
            x += unzigzag(geom[i++]!);
            y += unzigzag(geom[i++]!);
            z += unzigzag(geom[i++]!);
            ring.push([x, y, z]);
          }
        } else if (id === 7) {
          if (!header) header = ring;
          else if (count === 2) polygons.push([ring]);
          else polygons[polygons.length - 1]?.push(ring);
        }
      }
      if (header) out.push({ kind, low: header[0]!, polygons });
    }
  }
  return out;
}

// --- meshing: each surface triangulated on its own plane, flat normals ---

function newell(ring: P3[]): P3 {
  const n: P3 = [0, 0, 0];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!,
      b = ring[(i + 1) % ring.length]!;
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const l = Math.hypot(...n);
  return l ? [n[0] / l, n[1] / l, n[2] / l] : [0, 0, 0];
}

/**
 * Facets meeting at less than this angle share smoothed normals (domes, curved roofs); sharper
 * edges (roof against wall, hips, ridges) stay crisp. `?crease=0` shows the raw facets.
 */
const CREASE_DEG = Number(new URLSearchParams(location.search).get('crease') ?? 30);
const CREASE_COS = Math.cos((CREASE_DEG * Math.PI) / 180);

const dot = (a: P3, b: P3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function tileMesh(features: Feature3D[], tx: number, ty: number, origin: Origin): BufferGeometry {
  const pos: number[] = [],
    nor: number[] = [],
    col: number[] = [];
  const n = 2 ** 15;
  // tile units -> local glTF metres (X east, Y up, Z south) around `origin`
  const local = ([x, y, z]: P3, base: number): P3 => [
    ((tx + x / EXTENT) / n - origin.x) / origin.scale,
    (z - base) / 10,
    ((ty + y / EXTENT) / n - origin.y) / origin.scale,
  ];
  for (const f of features) {
    const color = COLORS[f.kind];
    // triangles of this building's roof (or walls), each corner with its tile position
    const tris: { corners: [P3, P3][]; normal: P3 }[] = [];
    const normalsAt = new Map<string, P3[]>();
    for (const poly of f.polygons) {
      const raw = poly.flat();
      const rings = poly.map((r) => r.map((p) => local(p, f.low[2])));
      const normal = newell(rings[0]!);
      if (!normal.some(Boolean)) continue;
      for (const k of new Set(raw.map((q) => q.join()))) {
        const list = normalsAt.get(k);
        if (list) list.push(normal);
        else normalsAt.set(k, [normal]);
      }
      // drop the dominant axis of the normal: a 2D view of the plane that keeps the shape
      const ax = normal.map(Math.abs);
      const [u, v] =
        ax[0]! >= ax[1]! && ax[0]! >= ax[2]! ? [1, 2] : ax[1]! >= ax[2]! ? [0, 2] : [0, 1];
      const flat = rings.map((r) => r.map((p) => new Vector2(p[u], p[v])));
      const all = rings.flat();
      for (const [a, b, c] of ShapeUtils.triangulateShape(flat[0]!, flat.slice(1))) {
        const tri: [P3, P3][] = [a!, b!, c!].map((i) => [all[i]!, raw[i]!]);
        if (dot(newell(tri.map((t) => t[0])), normal) < 0) tri.reverse();
        tris.push({ corners: tri, normal });
      }
    }
    for (const { corners, normal } of tris)
      for (const [p, [x, y, z]] of corners) {
        // average the facet normals at this corner that are within the crease angle of ours
        const near = normalsAt.get(`${x},${y},${z}`) ?? [];
        const sum: P3 = [0, 0, 0];
        for (const m of near)
          if (dot(m, normal) >= CREASE_COS) for (let i = 0; i < 3; i++) sum[i]! += m[i]!;
        const l = Math.hypot(...sum);
        pos.push(...p);
        nor.push(...(l ? sum.map((v) => v / l) : normal));
        col.push(color.r, color.g, color.b);
      }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  g.computeBoundingSphere();
  return g;
}

// --- the module ---

class CityModel3D implements LayerModule {
  private readonly group = new Group();
  private readonly material = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.85,
    side: DoubleSide,
  });
  private anchor: LngLat = [0, 0];
  private ctx?: ModuleContext;

  constructor(
    private readonly archive: PMTiles,
    private readonly onStats: (s: string) => void,
  ) {}

  onAdd(ctx: ModuleContext): void {
    this.ctx = ctx;
    ctx.scene.add(this.group);
    void this.load();
  }

  private async load(): Promise<void> {
    const h = await this.archive.getHeader();
    this.anchor = [(h.minLon + h.maxLon) / 2, (h.minLat + h.maxLat) / 2];
    const origin = originAt(this.anchor);
    const z = h.maxZoom,
      n = 2 ** z;
    const tx = (lng: number) => Math.floor(((lng + 180) / 360) * n);
    const ty = (lat: number) => {
      const r = (lat * Math.PI) / 180;
      return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
    };
    let surfaces = 0,
      triangles = 0,
      buildings = 0;
    const t0 = performance.now();
    for (let x = tx(h.minLon + 1e-9); x <= tx(h.maxLon - 1e-9); x++)
      for (let y = ty(h.maxLat - 1e-9); y <= ty(h.minLat + 1e-9); y++) {
        const res = await this.archive.getZxy(z, x, y);
        if (!res) continue;
        const features = decodeTile(new Uint8Array(res.data));
        const geometry = tileMesh(features, x, y, origin);
        buildings += features.filter((f) => f.kind === 'roof').length;
        surfaces += features.reduce((s, f) => s + f.polygons.length, 0);
        triangles += geometry.getAttribute('position').count / 3;
        const mesh = new Mesh(geometry, this.material);
        mesh.name = `${z}/${x}/${y}`;
        this.group.add(mesh);
      }
    this.onStats(
      `${buildings} buildings · ${surfaces.toLocaleString()} surfaces · ` +
        `${triangles.toLocaleString()} triangles · ${Math.round(performance.now() - t0)} ms`,
    );
    this.ctx?.requestRepaint();
  }

  update(): void {}

  place(origin: Origin): void {
    this.group.position.set(...localPosition(origin, this.anchor, 0));
    this.group.updateMatrixWorld(true);
  }

  onRemove(): void {
    this.ctx?.scene.remove(this.group);
    for (const m of this.group.children) (m as Mesh).geometry.dispose();
    this.material.dispose();
  }
}

// --- page ---

const info = document.getElementById('info')!;
const map = new MlMap({
  container: 'map',
  center: [16.3705, 48.2087],
  zoom: 16.6,
  pitch: 60,
  bearing: -30,
  maxPitch: 85,
  style: {
    version: 8,
    sources: {
      basemap: {
        type: 'raster',
        tiles: ['https://mapsneu.wien.gv.at/basemap/bmapgrau/normal/google3857/{z}/{y}/{x}.png'],
        tileSize: 256,
        maxzoom: 19,
        attribution: 'Basemap: basemap.at · Buildings: Stadt Wien – data.wien.gv.at (CC BY 4.0)',
      },
    },
    layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }],
  },
});
(window as unknown as { map: MlMap }).map = map;

map.on('load', () => {
  const module = new CityModel3D(new PMTiles(ARCHIVE), (s) => {
    info.textContent = `Vienna LOD2 (sheet 105082) — ${s}`;
  });
  map.addLayer(new ModuleLayer('citygml', module));
});
