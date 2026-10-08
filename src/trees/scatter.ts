import { EARTH_RADIUS_M, mercatorUnitsPerMetre, mercatorX, mercatorY } from '../core/mercator';
import { pointInRing, type Ring } from '../core/geometry';
import { hashString, seededRand } from './hash';

export type { Ring };
/** One polygon: outer ring first, then holes. Coordinates are [lng, lat]. */
export type PolygonCoords = Ring[];

export interface ScatterPoint {
  key: string;
  lngLat: [number, number];
}

export const MAX_SCATTER_CELLS = 250_000;
const METRES_PER_DEG = (2 * Math.PI * EARTH_RADIUS_M) / 360;

export function pointInPolygon(p: number[], [outer, ...holes]: PolygonCoords): boolean {
  return !!outer && pointInRing(p, outer) && !holes.some((h) => pointInRing(p, h));
}

function ringAreaM2(ring: Ring, lat0: number): number {
  const kx = METRES_PER_DEG * Math.cos((lat0 * Math.PI) / 180);
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a +=
      ring[j]![0]! * kx * (ring[i]![1]! * METRES_PER_DEG) -
      ring[i]![0]! * kx * (ring[j]![1]! * METRES_PER_DEG);
  }
  return Math.abs(a / 2);
}

export function polygonAreaM2([outer, ...holes]: PolygonCoords): number {
  if (!outer?.length) return 0;
  const lat0 = outer.reduce((s, p) => s + p[1]!, 0) / outer.length;
  return Math.max(0, ringAreaM2(outer, lat0) - holes.reduce((s, h) => s + ringAreaM2(h, lat0), 0));
}

export function bboxOf(pieces: PolygonCoords[]): [number, number, number, number] {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const poly of pieces) {
    for (const [x, y] of poly[0] ?? []) {
      w = Math.min(w, x!);
      e = Math.max(e, x!);
      s = Math.min(s, y!);
      n = Math.max(n, y!);
    }
  }
  return [w, s, e, n];
}

const lngFromMercX = (x: number) => x * 360 - 180;
const latFromMercY = (y: number) =>
  (360 / Math.PI) * Math.atan(Math.exp(((180 - y * 360) * Math.PI) / 180)) - 90;

/**
 * Seeded points on a global jittered grid (cell = 1/√density metres), kept where they fall inside
 * any piece. Keys are `kind:i:j`, so tile clipping and overlapping tile buffers never change or
 * duplicate the result.
 */
export function scatterPolygon(
  kind: string,
  pieces: PolygonCoords[],
  density: number,
): ScatterPoint[] {
  if (!(density > 0) || !pieces.length) return [];
  const [w, s, e, n] = bboxOf(pieces);
  if (!Number.isFinite(w)) return [];
  // Same grid for every piece of a polygon: scale at the latitude rounded to a whole degree.
  const cell = (1 / Math.sqrt(density)) * mercatorUnitsPerMetre(Math.round((s + n) / 2));
  const x0 = Math.floor(mercatorX(w) / cell);
  const x1 = Math.floor(mercatorX(e) / cell);
  const y0 = Math.floor(mercatorY(n) / cell);
  const y1 = Math.floor(mercatorY(s) / cell);
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_SCATTER_CELLS) return [];
  const salt = hashString(kind);
  const out: ScatterPoint[] = [];
  for (let i = x0; i <= x1; i++) {
    for (let j = y0; j <= y1; j++) {
      const rand = seededRand(Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ salt);
      const p: [number, number] = [
        lngFromMercX((i + 0.1 + 0.8 * rand()) * cell),
        latFromMercY((j + 0.1 + 0.8 * rand()) * cell),
      ];
      if (pieces.some((poly) => pointInPolygon(p, poly)))
        out.push({ key: `${kind}:${i}:${j}`, lngLat: p });
    }
  }
  return out;
}

/** Fill rule: scatter only when mapped trees inside stay below `skipRatio` of the target count. */
export function shouldScatter(
  pieces: PolygonCoords[],
  density: number,
  mappedInside: number,
  skipRatio: number,
): boolean {
  const target = pieces.reduce((sum, p) => sum + polygonAreaM2(p), 0) * density;
  return mappedInside < skipRatio * target;
}
