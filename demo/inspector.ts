// Click a building to see, side by side, what OSM says, what Overture's tiles carry, how we read
// and drew it, and what OSM2World builds from the same tags (by its rules, and as measured in its
// scene), with the likely reasons where they part.
import { Marker, type Map as MlMap, type MapGeoJSONFeature } from 'maplibre-gl';
import type { RoofAt, RoofsLayer } from '../src/index';
import { pointInPolygons, polygonsOf } from '../src/core/geometry';
import { DEFAULT_FIELDS, FLOOR_M, normaliseShape, readRoofProps } from '../src/roofs/schema';
import { measure, O2W_LEVEL_M, o2wHeights, type O2WHeights, type Tags } from './o2wRules';

/** Heights (metres above ground) of every OSM2World surface straight above a point. */
export type O2WProbe = (lng: number, lat: number) => number[];

/** OSM2World's scene, its camera kept in step with the map's. */
export interface O2WScene {
  heights: O2WProbe;
  /** What it shows at a fraction (0–1) across and down its canvas. */
  pick(fx: number, fy: number): { lngLat: [number, number]; height: number } | undefined;
}

export interface InspectorOptions {
  roofs: RoofsLayer;
  /** Building and building part wall layers. */
  wallLayers: string[];
  source: string;
  sourceLayers: string[];
  /** OSM2World's scene, once it has loaded. */
  osm2world: () => O2WScene | undefined;
}

/** Public Overpass instances, tried in turn: any one of them is often overloaded. */
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const OSM_API = 'https://api.openstreetmap.org/api/0.6';
const M_PER_DEG = 111_320;
/** Height differences below this are agreement, metres. */
const TOLERANCE_M = 0.5;

type LngLat = [number, number];

interface OsmElement {
  type: 'way' | 'relation';
  id: number;
  version: number;
  timestamp: string;
  tags: Tags;
  /** Rings (ways) or member lines (relations), lng/lat: even-odd over all of them. */
  lines: LngLat[][];
}

interface OvertureFeature {
  id: string | number | undefined;
  sourceLayer: string;
  properties: Record<string, unknown>;
  polygons: number[][][][];
  /** OSM element it came from ("way/123") and the version Overture read. */
  osm?: { key: string; version: number };
  dataset: string;
}

// ---- Geometry --------------------------------------------------------------------------------

function inLines([x, y]: LngLat, lines: LngLat[][]): boolean {
  let inside = false;
  for (const line of lines)
    for (let i = 1; i < line.length; i++) {
      const [xi, yi] = line[i]!;
      const [xj, yj] = line[i - 1]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  return inside;
}

/** Local metres (east, north) around `o`. */
const toLocal =
  (o: LngLat, k = Math.cos((o[1] * Math.PI) / 180)) =>
  (p: LngLat) =>
    [(p[0] - o[0]) * k * M_PER_DEG, (p[1] - o[1]) * M_PER_DEG] as LngLat;
const toLngLat =
  (o: LngLat, k = Math.cos((o[1] * Math.PI) / 180)) =>
  (p: LngLat) =>
    [o[0] + p[0] / (k * M_PER_DEG), o[1] + p[1] / M_PER_DEG] as LngLat;

/** Largest distance between two vertices, metres (OSM2World's outline diameter). */
function diameterOf(lines: LngLat[][], at: LngLat): number {
  const pts = lines.flat().map(toLocal(at));
  let d = 0;
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++)
      d = Math.max(d, Math.hypot(pts[i]![0] - pts[j]![0], pts[i]![1] - pts[j]![1]));
  return d;
}

const areaOf = (lines: LngLat[][], at: LngLat) =>
  lines.reduce((sum, line) => {
    const p = line.map(toLocal(at));
    let a = 0;
    for (let i = 1; i < p.length; i++) a += p[i - 1]![0] * p[i]![1] - p[i]![0] * p[i - 1]![1];
    return sum + Math.abs(a) / 2;
  }, 0);

/**
 * Where to sample an element: a grid inside it (its top) and points just inside each wall (its
 * eaves), at most `max` of each.
 */
function samplesOf(lines: LngLat[][], at: LngLat, max = 24): { inner: LngLat[]; edge: LngLat[] } {
  const local = lines.map((l) => l.map(toLocal(at)));
  const back = toLngLat(at);
  const inside = (p: LngLat) => inLines(p, local);
  const xs = local.flat().map((p) => p[0]);
  const ys = local.flat().map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const step = Math.max(1, Math.sqrt(((x1 - x0) * (y1 - y0)) / (max * 1.5)));
  const inner: LngLat[] = [];
  for (let x = x0 + step / 2; x < x1; x += step)
    for (let y = y0 + step / 2; y < y1; y += step) if (inside([x, y])) inner.push([x, y]);
  const edge: LngLat[] = [];
  for (const line of local)
    for (let i = 1; i < line.length; i++) {
      const [a, b] = [line[i - 1]!, line[i]!];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 2) continue;
      const mid: LngLat = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const n: LngLat = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
      for (const s of [0.7, -0.7]) {
        const p: LngLat = [mid[0] + n[0] * s, mid[1] + n[1] * s];
        if (inside(p)) {
          edge.push(p);
          break;
        }
      }
    }
  const thin = <T>(list: T[]) =>
    list.length <= max ? list : list.filter((_, i) => i % Math.ceil(list.length / max) === 0);
  return { inner: thin(inner).map(back), edge: thin(edge).map(back) };
}

// ---- Data ------------------------------------------------------------------------------------

async function osmAround([lng, lat]: LngLat): Promise<OsmElement[]> {
  // Ways are found by their segments: wide enough that the walls of the building around the point
  // cross it.
  const dLat = 60 / M_PER_DEG;
  const dLng = dLat / Math.cos((lat * Math.PI) / 180);
  const bbox = [lat - dLat, lng - dLng, lat + dLat, lng + dLng].map((v) => v.toFixed(6)).join(',');
  const query = `[out:json][timeout:25];(way["building"](${bbox});way["building:part"](${bbox});relation["building"]["type"="multipolygon"](${bbox});relation["building:part"]["type"="multipolygon"](${bbox}););out meta geom;`;
  const errors: string[] = [];
  let json: OverpassJson | undefined;
  for (const url of OVERPASS)
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      json = (await res.json()) as OverpassJson;
      break;
    } catch (err) {
      errors.push(`${new URL(url).host}: ${String(err)}`);
    }
  if (!json) throw new Error(errors.join('; '));
  return elementsOf(json, [lng, lat]);
}

interface OverpassJson {
  elements: {
    type: 'way' | 'relation';
    id: number;
    version: number;
    timestamp: string;
    tags?: Tags;
    geometry?: { lat: number; lon: number }[];
    members?: { type: string; role: string; geometry?: { lat: number; lon: number }[] }[];
  }[];
}

function elementsOf(json: OverpassJson, [lng, lat]: LngLat): OsmElement[] {
  const line = (g: { lat: number; lon: number }[]) => g.map((p): LngLat => [p.lon, p.lat]);
  return json.elements
    .map((e) => ({
      type: e.type,
      id: e.id,
      version: e.version,
      timestamp: e.timestamp,
      tags: e.tags ?? {},
      lines:
        e.type === 'way'
          ? [line(e.geometry ?? [])]
          : (e.members ?? [])
              .filter(
                (m) =>
                  m.type === 'way' &&
                  m.geometry &&
                  (m.role === 'outer' || m.role === 'inner' || m.role === ''),
              )
              .map((m) => line(m.geometry!)),
    }))
    .filter((e) => inLines([lng, lat], e.lines));
}

/**
 * Without Overpass: the elements Overture's buildings came from, read from the OSM API (cannot
 * see OSM buildings that Overture lacks).
 */
async function osmByKeys(keys: string[], at: LngLat): Promise<OsmElement[]> {
  const found = await Promise.all(
    keys.map(async (key) => {
      const res = await fetch(`${OSM_API}/${key}/full.json`);
      if (!res.ok) return [];
      const { elements } = (await res.json()) as {
        elements: {
          type: string;
          id: number;
          version: number;
          timestamp: string;
          tags?: Tags;
          lat?: number;
          lon?: number;
          nodes?: number[];
          members?: { type: string; ref: number; role: string }[];
        }[];
      };
      const nodes = new Map(
        elements.filter((e) => e.type === 'node').map((e) => [e.id, { lat: e.lat!, lon: e.lon! }]),
      );
      const geometryOf = (id: number) =>
        elements.find((e) => e.type === 'way' && e.id === id)?.nodes?.map((n) => nodes.get(n)!);
      const [type, id] = key.split('/') as ['way' | 'relation', string];
      const e = elements.find((x) => x.type === type && x.id === Number(id))!;
      return elementsOf(
        {
          elements: [
            {
              ...e,
              type,
              geometry: type === 'way' ? geometryOf(e.id) : undefined,
              members: e.members?.map((m) => ({ ...m, geometry: geometryOf(m.ref) })),
            },
          ],
        },
        at,
      );
    }),
  );
  return found.flat();
}

function osmSource(
  p: Record<string, unknown>,
): { key: string; version: number; dataset: string } | undefined {
  try {
    const sources = (typeof p.sources === 'string' ? JSON.parse(p.sources) : p.sources) as {
      record_id?: string;
      dataset?: string;
      property?: string;
    }[];
    const geometry = sources.find((s) => !s.property) ?? sources[0];
    const m = /^([wr])(\d+)@(\d+)$/.exec(geometry?.record_id ?? '');
    if (!m) return geometry ? { key: '', version: 0, dataset: geometry.dataset ?? '?' } : undefined;
    return {
      key: `${m[1] === 'w' ? 'way' : 'relation'}/${m[2]}`,
      version: Number(m[3]),
      dataset: geometry!.dataset ?? 'OpenStreetMap',
    };
  } catch {
    return undefined;
  }
}

function overtureAt(map: MlMap, o: InspectorOptions, at: LngLat): OvertureFeature[] {
  const seen = new Set<string>();
  const found: OvertureFeature[] = [];
  for (const sourceLayer of o.sourceLayers)
    for (const f of map.querySourceFeatures(o.source, { sourceLayer })) {
      const key = `${sourceLayer}|${f.id ?? f.properties.id}`;
      if (seen.has(key)) continue;
      // Tiles cut buildings at their edges: the piece holding the point is the one to test.
      const polygons = polygonsOf(f.geometry as never);
      if (!pointInPolygons(at, polygons)) continue;
      seen.add(key);
      const src = osmSource(f.properties);
      found.push({
        id: f.id,
        sourceLayer,
        properties: f.properties,
        polygons,
        osm: src?.key ? { key: src.key, version: src.version } : undefined,
        dataset: src?.dataset ?? '?',
      });
    }
  return found;
}

// ---- Our heights -----------------------------------------------------------------------------

interface Ours {
  height: number;
  wallTop: number;
  minHeight: number;
  roofHeight: number;
  shape: string;
  rule: string;
  drawn?: RoofAt;
}

/** What we draw for an Overture feature: the roof built, else flat walls (`buildingHeight`). */
function oursFor(f: OvertureFeature, roofs: RoofAt[]): Ours {
  const p = f.properties;
  const drawn = roofs.find((r) => r.id === f.id && r.sourceLayer === f.sourceLayer);
  if (drawn)
    return {
      height: drawn.top,
      wallTop: drawn.wallTop,
      minHeight: drawn.props.minHeight,
      roofHeight: drawn.roofHeight,
      shape: drawn.props.shape,
      rule: drawn.props.roofAbove
        ? `${p.num_floors} floors × ${FLOOR_M} m, roof on top`
        : p.height !== undefined
          ? 'height'
          : `${p.num_floors} floors × ${FLOOR_M} m + roof_height`,
      drawn,
    };
  const num = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v));
  const floors = num(p.num_floors) ?? 0;
  const height =
    num(p.height) ?? (floors > 0 ? floors * FLOOR_M + Math.max(0, num(p.roof_height) ?? 0) : 10);
  const minHeight = num(p.min_height) ?? (num(p.min_floor) ?? 0) * FLOOR_M;
  const props = readRoofProps(p, DEFAULT_FIELDS, '#d9d4ce');
  return {
    height,
    wallTop: height,
    minHeight,
    roofHeight: 0,
    shape: props ? `${props.shape} (not drawn)` : 'flat',
    rule:
      p.height !== undefined
        ? 'height'
        : floors > 0
          ? `${floors} floors × ${FLOOR_M} m`
          : 'no height: 10 m fallback',
  };
}

// ---- Comparison ------------------------------------------------------------------------------

/** OSM tag ↔ Overture attribute, as Overture maps them. */
const PAIRS: [string, string][] = [
  ['height', 'height'],
  ['min_height', 'min_height'],
  ['building:levels', 'num_floors'],
  ['building:min_level', 'min_floor'],
  ['roof:levels', ''],
  ['roof:shape', 'roof_shape'],
  ['roof:height', 'roof_height'],
  ['roof:angle', 'roof_angle'],
  ['roof:direction', 'roof_direction'],
  ['roof:orientation', 'roof_orientation'],
  ['roof:colour', 'roof_color'],
  ['roof:material', 'roof_material'],
  ['building:colour', 'facade_color'],
  ['building:material', 'facade_material'],
];

const same = (osm: string | undefined, ov: unknown): boolean => {
  if (osm === undefined) return ov === undefined || ov === null;
  if (ov === undefined || ov === null) return false;
  const [a, b] = [measure(osm), typeof ov === 'number' ? ov : measure(String(ov))];
  if (a !== undefined && b !== undefined) return Math.abs(a - b) < 0.05;
  const norm = (v: string) => v.trim().toLowerCase().replaceAll('-', '_').replace(/^#/, '');
  return norm(osm) === norm(String(ov));
};

interface Finding {
  level: 'bad' | 'warn' | 'info';
  text: string;
}

function findings(
  el: OsmElement,
  ov: OvertureFeature | undefined,
  ours: Ours | undefined,
  o2w: O2WHeights,
  parts: OsmElement[],
): Finding[] {
  const t = el.tags;
  const out: Finding[] = [];
  const add = (level: Finding['level'], text: string) => out.push({ level, text });
  if (!ov) add('bad', 'Not in the Overture tiles at this point: OSM2World draws it, we cannot.');
  else if (ov.osm && ov.osm.version < el.version)
    add(
      'warn',
      `OSM edited since Overture's snapshot (v${ov.osm.version} → v${el.version}, ${el.timestamp.slice(0, 10)}).`,
    );
  if (ov)
    for (const [tag, attr] of PAIRS)
      if (attr && !same(t[tag], ov.properties[attr]))
        add(
          'warn',
          `Overture's ${attr} = ${fmt(ov.properties[attr])}, OSM ${tag} = ${fmt(t[tag])}.`,
        );
  if (parts.length && !t['building:part'])
    add(
      'info',
      `Has ${parts.length} building:part(s) here: OSM2World draws the parts, not this outline.`,
    );
  const shape = t['roof:shape'];
  const pitched = shape !== undefined && shape !== 'flat';
  if (pitched && !normaliseShape(shape))
    add('bad', `roof:shape=${shape} is not one we draw: flat here.`);
  if (t['roof:levels'] !== undefined && t['roof:height'] === undefined && pitched)
    add(
      'warn',
      `roof:levels=${t['roof:levels']}: Overture drops it; OSM2World makes the roof ${o2w.roofHeight.toFixed(1)} m (${o2w.roofRule}).`,
    );
  if (t.height === undefined && t['building:levels'] !== undefined)
    add('warn', `No height: storeys of ${FLOOR_M} m here, ${O2W_LEVEL_M} m in OSM2World.`);
  if (t.height === undefined && t['building:levels'] === undefined)
    add(
      'warn',
      `No height nor levels: we use 10 m walls, OSM2World ${o2w.levels} levels × ${O2W_LEVEL_M} m + roof.`,
    );
  if (
    pitched &&
    t['roof:height'] === undefined &&
    t['roof:levels'] === undefined &&
    t['roof:angle'] === undefined
  )
    add('info', `Untagged roof height: we use a 30° pitch (capped), OSM2World ${o2w.roofRule}.`);
  if (t['roof:angle'] !== undefined && t['roof:height'] === undefined && shape !== 'skillion')
    add('warn', 'OSM2World ignores roof:angle except on skillion roofs; we pitch the roof by it.');
  if (ours) {
    const d = (a: number, b: number) => Math.abs(a - b) > TOLERANCE_M;
    if (d(ours.height, o2w.height) || d(ours.wallTop, o2w.wallTop))
      add(
        'bad',
        `Heights differ: ours top ${ours.height.toFixed(1)} / walls ${ours.wallTop.toFixed(1)} m, OSM2World ${o2w.height.toFixed(1)} / ${o2w.wallTop.toFixed(1)} m.`,
      );
  }
  return out;
}

// ---- Panel -----------------------------------------------------------------------------------

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = (v: unknown) => (v === undefined || v === null || v === '' ? '—' : esc(String(v)));
const m = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `${v.toFixed(1)} m`;
const cell = (a: number | undefined, b: number | undefined) =>
  a !== undefined && b !== undefined && Math.abs(a - b) > TOLERANCE_M ? ' class="diff"' : '';

interface Measured {
  top: number;
  eaves: number;
  here: number;
  rays: number;
}

async function measure2w(probe: O2WProbe, el: OsmElement, at: LngLat): Promise<Measured> {
  const { inner, edge } = samplesOf(el.lines, at);
  const tops = async (points: LngLat[]) => {
    const out: number[] = [];
    for (const [i, p] of points.entries()) {
      out.push(Math.max(0, ...probe(...p)));
      // Keep the page responsive: the tiles are large meshes.
      if (i % 4 === 3) await new Promise((r) => setTimeout(r));
    }
    return out;
  };
  const top = await tops([at, ...inner]);
  const eaves = await tops(edge);
  return {
    here: top[0]!,
    top: Math.max(...top, ...eaves),
    eaves: eaves.length ? Math.min(...eaves) : NaN,
    rays: top.length + eaves.length,
  };
}

function card(
  el: OsmElement,
  ov: OvertureFeature | undefined,
  ours: Ours | undefined,
  o2w: O2WHeights,
  found: Finding[],
  measured: Measured | undefined,
  at: LngLat,
): string {
  const kind = el.tags['building:part']
    ? `building:part=${el.tags['building:part']}`
    : `building=${el.tags.building}`;
  const url = `https://www.openstreetmap.org/${el.type}/${el.id}`;
  const rows = PAIRS.map(
    ([tag, attr]) =>
      `<tr${ov && attr && !same(el.tags[tag], ov.properties[attr]) ? ' class="diff"' : ''}><th>${tag}</th><td>${fmt(el.tags[tag])}</td><td>${attr ? fmt(ov?.properties[attr]) : '<i>n/a</i>'}</td></tr>`,
  )
    .filter(
      (r) => !r.includes('<td>—</td><td>—</td>') && !r.includes('<td>—</td><td><i>n/a</i></td>'),
    )
    .join('');
  const ourTop = ours?.drawn ? (ours.drawn.surface ?? undefined) : ours?.height;
  return `
  <section class="card">
    <h3><a href="${url}" target="_blank" rel="noopener">${el.type} ${el.id}</a> <small>${esc(kind)} · v${el.version}${el.tags.name ? ` · ${esc(el.tags.name)}` : ''}</small></h3>
    <p class="sub">${
      ov
        ? `Overture ${esc(ov.sourceLayer)} <code>${esc(String(ov.properties.id ?? ov.id))}</code>${ov.osm ? ` (from v${ov.osm.version})` : ''}${ov.properties.has_parts ? ' · has_parts' : ''}`
        : '<b>missing from Overture tiles</b>'
    } · ${Math.round(areaOf(el.lines, at))} m²</p>
    ${found.length ? `<ul class="findings">${found.map((f) => `<li class="${f.level}">${f.text}</li>`).join('')}</ul>` : '<p class="ok">No differences found.</p>'}
    <table class="heights">
      <tr><th></th><th>ours</th><th>OSM2World rules</th>${measured ? '<th>OSM2World scene</th>' : ''}</tr>
      <tr><th>top</th><td>${m(ours?.height)}</td><td${cell(ours?.height, o2w.height)}>${m(o2w.height)}</td>${measured ? `<td${cell(measured.top, o2w.height)}>${m(measured.top)}</td>` : ''}</tr>
      <tr><th>walls / eaves</th><td>${m(ours?.wallTop)}</td><td${cell(ours?.wallTop, o2w.wallTop)}>${m(o2w.wallTop)}</td>${measured ? `<td${cell(measured.eaves, o2w.wallTop)}>${m(measured.eaves)}</td>` : ''}</tr>
      <tr><th>roof</th><td>${m(ours?.roofHeight)}</td><td${cell(ours?.roofHeight, o2w.roofHeight)}>${m(o2w.roofHeight)}</td>${measured ? '<td></td>' : ''}</tr>
      <tr><th>base</th><td>${m(ours?.minHeight)}</td><td${cell(ours?.minHeight, o2w.minHeight)}>${m(o2w.minHeight)}</td>${measured ? '<td></td>' : ''}</tr>
      <tr><th>at the point</th><td>${m(ourTop)}</td><td></td>${measured ? `<td${cell(ourTop, measured.here)}>${m(measured.here)}</td>` : ''}</tr>
      <tr class="why"><th>shape</th><td>${esc(ours?.shape ?? '—')}</td><td>${esc(o2w.roofShape)}</td>${measured ? `<td>${measured.rays} rays</td>` : ''}</tr>
      <tr class="why"><th>from</th><td>${esc(ours?.rule ?? '—')}</td><td>${esc(o2w.heightRule)}; roof: ${esc(o2w.roofRule)}</td>${measured ? '<td></td>' : ''}</tr>
    </table>
    <details><summary>Tags: OSM ↔ Overture</summary><table class="tags"><tr><th></th><th>OSM</th><th>Overture</th></tr>${rows}</table>
    <pre>${esc(
      Object.entries(el.tags)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n'),
    )}</pre></details>
  </section>`;
}

/** A point inside the clicked building: under the cursor when there (top-down), else its middle. */
function pointIn(f: MapGeoJSONFeature, ground: LngLat): LngLat {
  const polygons = polygonsOf(f.geometry as never);
  if (pointInPolygons(ground, polygons)) return ground;
  const outer = polygons[0]?.[0] ?? [];
  const c = outer.reduce(
    (s, p) => [s[0]! + p[0]! / outer.length, s[1]! + p[1]! / outer.length],
    [0, 0],
  ) as LngLat;
  if (pointInPolygons(c, polygons)) return c;
  // A concave outline: the middle of the first span across its centroid's latitude.
  const xs: number[] = [];
  for (const ring of polygons.flat())
    for (let i = 1; i < ring.length; i++) {
      const [a, b] = [ring[i - 1]!, ring[i]!];
      if (a[1]! > c[1] !== b[1]! > c[1])
        xs.push(a[0]! + ((c[1] - a[1]!) * (b[0]! - a[0]!)) / (b[1]! - a[1]!));
    }
  xs.sort((a, b) => a - b);
  return xs.length >= 2 ? [(xs[0]! + xs[1]!) / 2, c[1]] : c;
}

export function startInspector(map: MlMap, o: InspectorOptions): void {
  const button = document.createElement('button');
  button.className = 'inspect-toggle';
  button.textContent = 'Inspect';
  button.title = 'Click a building to compare it with OSM and OSM2World';
  const panel = document.createElement('aside');
  panel.className = 'inspector';
  panel.hidden = true;
  map.getContainer().append(button, panel);
  const marker = new Marker({ color: '#d33' });
  let on = false;
  let run = 0;

  const close = () => {
    panel.hidden = true;
    marker.remove();
  };
  button.onclick = () => {
    on = !on;
    button.classList.toggle('on', on);
    map.getCanvas().style.cursor = on ? 'crosshair' : '';
    if (!on) close();
  };
  document.addEventListener('keydown', (e) => e.key === 'Escape' && close());

  map.on('click', async (e) => {
    if (!on) return;
    const hit = map.queryRenderedFeatures(e.point, {
      layers: o.wallLayers.filter((l) => map.getLayer(l)),
    })[0];
    let at: LngLat = [e.lngLat.lng, e.lngLat.lat];
    let pickNote = '';
    if (hit) at = pointIn(hit, at);
    else {
      // None of ours under the cursor: what does OSM2World show at the same pixel? In a pitched
      // view that is a building in front of the ground point, not the ground point itself.
      const canvas = map.getCanvas();
      const seen = o
        .osm2world()
        ?.pick(e.point.x / canvas.clientWidth, e.point.y / canvas.clientHeight);
      if (seen && seen.height > 0.5) {
        at = seen.lngLat;
        pickNote = `<p class="bad">None of our buildings is under the cursor, but OSM2World shows a surface ${seen.height.toFixed(1)} m high there: inspecting that spot.</p>`;
      }
    }
    const mine = ++run;
    marker.setLngLat(at).addTo(map);
    panel.hidden = false;
    const head = `<header><b>${at[1].toFixed(6)}, ${at[0].toFixed(6)}</b><button class="close" title="Close (Esc)">×</button></header>`;
    const show = (html: string) => {
      if (mine !== run) return;
      panel.innerHTML = head + pickNote + html;
      panel.querySelector<HTMLButtonElement>('.close')!.onclick = close;
    };
    show('<p class="sub">Loading OSM data…</p>');

    const overture = overtureAt(map, o, at);
    const roofs = o.roofs.roofsAt(at);
    let osm: OsmElement[];
    let note = '';
    try {
      osm = await osmAround(at);
    } catch (err) {
      const keys = [...new Set(overture.flatMap((f) => (f.osm ? [f.osm.key] : [])))];
      osm = await osmByKeys(keys, at).catch(() => []);
      note = `<p class="warn">Overpass is unavailable (${esc(String(err))}): only the OSM elements Overture names are shown; OSM buildings missing from Overture cannot be found.</p>`;
      if (!osm.length) return show(note);
    }
    // Smallest first: the part under the point, then the buildings holding it.
    osm.sort((a, b) => areaOf(a.lines, at) - areaOf(b.lines, at));
    const parts = osm.filter((e) => e.tags['building:part']);
    const buildings = osm.filter((e) => !e.tags['building:part']);
    const byKey = new Map(overture.filter((f) => f.osm).map((f) => [f.osm!.key, f]));

    const cards = osm.map((el) => {
      const ov = byKey.get(`${el.type}/${el.id}`);
      const parent = el.tags['building:part'] ? buildings[0]?.tags : undefined;
      const o2w = o2wHeights(el.tags, parent, diameterOf(el.lines, at));
      const ours = ov ? oursFor(ov, roofs) : undefined;
      return {
        el,
        ov,
        ours,
        o2w,
        found: findings(el, ov, ours, o2w, el.tags['building:part'] ? [] : parts),
      };
    });
    const known = new Set(osm.map((e) => `${e.type}/${e.id}`));
    const extra = overture.filter((f) => !f.osm || !known.has(f.osm.key));
    const extraHtml = extra.length
      ? `<section class="card"><h3>Overture only</h3><ul class="findings">${extra
          .map(
            (f) =>
              `<li class="warn">${esc(f.sourceLayer)} <code>${esc(String(f.properties.id ?? f.id))}</code> from ${esc(f.dataset)}${f.osm ? ` (${f.osm.key}, no longer a building here in OSM?)` : ''}: height ${fmt(f.properties.height)}, roof ${fmt(f.properties.roof_shape)}</li>`,
          )
          .join('')}</ul></section>`
      : '';
    const render = (measured?: Measured, status = '') =>
      show(
        (osm.length ? '' : '<p class="sub">No OSM building here.</p>') +
          note +
          status +
          cards
            .map((c, i) =>
              card(c.el, c.ov, c.ours, c.o2w, c.found, i === 0 ? measured : undefined, at),
            )
            .join('') +
          extraHtml,
      );
    const probe = o.osm2world()?.heights;
    render(
      undefined,
      probe && cards.length
        ? '<p class="sub">Measuring OSM2World’s scene…</p>'
        : probe
          ? ''
          : '<p class="sub">OSM2World’s scene is not loaded.</p>',
    );
    if (!probe) return;
    if (!cards.length) {
      // Nothing in OSM here: still show whether OSM2World draws something (an older tile?).
      const hits = probe(...at)
        .filter((y) => y > 0.05)
        .sort((a, b) => b - a);
      return render(
        undefined,
        hits.length
          ? `<p class="bad">OSM2World draws surfaces here at ${hits.map((y) => y.toFixed(1)).join(', ')} m, but no OSM building holds this point${note ? ' (of those Overture names)' : ''}: its tile may predate an OSM edit, or it is not a building (bridge, roof=*, man_made…).</p>`
          : '<p class="sub">OSM2World draws nothing above the ground here either.</p>',
      );
    }
    // OSM2World's tiles load around its camera: the scene shows what it draws once they are in.
    const measured = await measure2w(probe, cards[0]!.el, at);
    if (measured.top === 0)
      return render(
        undefined,
        '<p class="sub">OSM2World has nothing drawn here yet (tiles still loading?). Click again.</p>',
      );
    const c = cards[0]!;
    if (Math.abs(measured.top - c.o2w.height) > 1)
      c.found.push({
        level: 'warn',
        text: `OSM2World's scene peaks at ${measured.top.toFixed(1)} m, its rules give ${c.o2w.height.toFixed(1)} m: its tile may predate the current tags, or a rule is not modelled here.`,
      });
    render(measured);
  });
}
