import { ShapeUtils, Vector2 } from 'three';
import { mercatorUnitsPerMetre, mercatorX, mercatorY } from '../core/mercator';
import type { LngLat } from '../core/types';

export const SHORE_WIDTH_M = 6;
export const MIN_AREA_M2 = 4;
const SAMPLES = 64;
/**
 * Slope under which an edge counts as axis-aligned (a candidate tile cut): MapLibre rounds the
 * clipped points of overzoomed tiles to the tile grid, so one end of a cut can be a unit off.
 */
const AXIS_SLOPE = 0.002;
/** How far outside a candidate cut to look for more water, metres. */
const OUTWARD_M = 0.5;

/** One water polygon piece. All x, y are mercator (float64). */
export interface WaterPiece {
  /** Triangulated polygon: x, y pairs and triangles. */
  body: { xy: number[]; index: number[] };
  /** Ribbons inside real shorelines: x, y pairs, shore 1 at the edge and 0 inward, triangles. */
  shore: { xy: number[]; shore: number[]; index: number[] };
  /** Up to 64 triangle centres (x, y pairs): where to sample the ground under flat water. */
  samples: number[];
  /** [minX, minY, maxX, maxY] of the outer ring. */
  bbox: [number, number, number, number];
  triangles: number;
}

/** Is there other water at this point (another piece across a tile cut, or another water body)? */
export type WaterAt = (lngLat: LngLat) => boolean;

export const longitudeOf = (x: number): number => x * 360 - 180;
export const latitudeOf = (y: number): number =>
  (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;

/** Ring in mercator x, y pairs, without the closing point or repeated points. */
function cleanRing(ring: number[][]): number[] {
  const out: number[] = [];
  for (const p of ring) {
    const x = mercatorX(p[0]!);
    const y = mercatorY(p[1]!);
    const n = out.length;
    if (n && out[n - 2] === x && out[n - 1] === y) continue;
    out.push(x, y);
  }
  const n = out.length;
  if (n >= 4 && out[0] === out[n - 2] && out[1] === out[n - 1]) out.length = n - 2;
  return out;
}

/** Shoelace signed area of x, y pairs. */
function signedArea(r: number[]): number {
  let a = 0;
  for (let i = 0, n = r.length; i < n; i += 2) {
    const j = (i + 2) % n;
    a += r[i]! * r[j + 1]! - r[j]! * r[i + 1]!;
  }
  return a / 2;
}

/** Body, shore ribbons and ground samples of one polygon (lng/lat rings, outer first), or null if too small. */
export function buildPiece(polygon: number[][][], waterAt: WaterAt): WaterPiece | null {
  const outer = cleanRing(polygon[0] ?? []);
  if (outer.length < 6) return null;
  const rings = [outer, ...polygon.slice(1).map(cleanRing)].filter(
    (r) => r.length >= 6 && signedArea(r) !== 0,
  );
  if (rings[0] !== outer) return null;
  const m = 1 / mercatorUnitsPerMetre(latitudeOf(outer[1]!)); // metres per mercator unit
  const areas = rings.map(signedArea);
  const area = (Math.abs(areas[0]!) - areas.slice(1).reduce((s, a) => s + Math.abs(a), 0)) * m * m;
  if (!(area >= MIN_AREA_M2)) return null;

  // Triangulate in local metres around the first vertex (float precision).
  const [x0, y0] = [outer[0]!, outer[1]!];
  const toVectors = (r: number[]) => {
    const v: Vector2[] = [];
    for (let i = 0; i < r.length; i += 2)
      v.push(new Vector2((r[i]! - x0) * m, (r[i + 1]! - y0) * m));
    return v;
  };
  const faces = ShapeUtils.triangulateShape(toVectors(outer), rings.slice(1).map(toVectors));
  if (!faces.length) return null;
  const body = { xy: rings.flat(), index: faces.flat() };

  // Ribbons on the water side of each shoreline edge.
  // Narrow water (ditches, canals): at most 40% of its typical width (2·area / perimeter), so
  // ribbons from both banks never cross the far bank.
  let perimeter = 0;
  for (const r of rings)
    for (let i = 0, n = r.length; i < n; i += 2) {
      const j = (i + 2) % n;
      perimeter += Math.hypot(r[j]! - r[i]!, r[j + 1]! - r[i + 1]!) * m;
    }
  const width = Math.min(SHORE_WIDTH_M, 0.2 * Math.sqrt(area), (0.4 * 2 * area) / perimeter) / m;
  const shore = { xy: [] as number[], shore: [] as number[], index: [] as number[] };
  rings.forEach((r, k) => {
    // Water lies left of each edge on a positively wound outer ring; holes flip it.
    const side = Math.sign(areas[k]!) * (k === 0 ? 1 : -1);
    for (let i = 0, n = r.length; i < n; i += 2) {
      const j = (i + 2) % n;
      const [ax, ay, bx, by] = [r[i]!, r[i + 1]!, r[j]!, r[j + 1]!];
      const [dx, dy] = [bx - ax, by - ay];
      const len = Math.hypot(dx, dy);
      if (len === 0) continue;
      const [nx, ny] = [(-dy / len) * side, (dx / len) * side]; // unit, toward the water
      if (
        Math.min(Math.abs(dx), Math.abs(dy)) <=
        AXIS_SLOPE * Math.max(Math.abs(dx), Math.abs(dy))
      ) {
        const out = OUTWARD_M / m;
        const [px, py] = [(ax + bx) / 2 - nx * out, (ay + by) / 2 - ny * out];
        if (waterAt([longitudeOf(px), latitudeOf(py)])) continue;
      }
      const b = shore.xy.length / 2;
      shore.xy.push(
        ax,
        ay,
        bx,
        by,
        ax + nx * width,
        ay + ny * width,
        bx + nx * width,
        by + ny * width,
      );
      shore.shore.push(1, 1, 0, 0);
      shore.index.push(b, b + 1, b + 3, b, b + 3, b + 2);
    }
  });

  // Inside the water, not on the shore: the DEM dips below the water surface along shores.
  const xy = body.xy;
  const tris = body.index.length / 3;
  const stride = Math.max(1, Math.ceil(tris / SAMPLES));
  const samples: number[] = [];
  for (let t = 0; t < tris; t += stride) {
    const [a, b, c] = [
      body.index[t * 3]! * 2,
      body.index[t * 3 + 1]! * 2,
      body.index[t * 3 + 2]! * 2,
    ];
    samples.push((xy[a]! + xy[b]! + xy[c]!) / 3, (xy[a + 1]! + xy[b + 1]! + xy[c + 1]!) / 3);
  }

  const bbox: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < outer.length; i += 2) {
    bbox[0] = Math.min(bbox[0], outer[i]!);
    bbox[1] = Math.min(bbox[1], outer[i + 1]!);
    bbox[2] = Math.max(bbox[2], outer[i]!);
    bbox[3] = Math.max(bbox[3], outer[i + 1]!);
  }
  return {
    body,
    shore,
    samples,
    bbox,
    triangles: (body.index.length + shore.index.length) / 3,
  };
}
