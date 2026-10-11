import polygonClipping, { type Polygon } from 'polygon-clipping';
import type { LngLat } from '../core/types';

export interface Footprint {
  id: number | string;
  key: string;
  /** Whole footprint in lng/lat (closed rings), merged across tile seams. */
  polygons: number[][][][];
  properties: Record<string, unknown>;
  centroid: LngLat;
  /**
   * Where MapLibre samples terrain for this building's walls: the vertex average of its
   * (largest) polygon, holes included.
   */
  terrainPoint: LngLat;
  /** Identity of the pieces it was built from. */
  signature: string;
}

/**
 * Area-weighted centroid of the outer rings. Measured from the first vertex: raw lng/lat
 * products cancel catastrophically for small parts far from (0, 0), throwing a 1.5 m turret's
 * centroid hundreds of metres off (and past the far cutoff).
 */
function centroidOf(polygons: number[][][][]): LngLat {
  const [ox, oy] = (polygons[0]?.[0]?.[0] ?? [0, 0]) as [number, number];
  let a = 0;
  let x = 0;
  let y = 0;
  for (const rings of polygons) {
    const r = rings[0] ?? [];
    for (let i = 0; i + 1 < r.length; i++) {
      const x0 = r[i]![0]! - ox;
      const y0 = r[i]![1]! - oy;
      const x1 = r[i + 1]![0]! - ox;
      const y1 = r[i + 1]![1]! - oy;
      const k = x0 * y1 - x1 * y0;
      a += k;
      x += (x0 + x1) * k;
      y += (y0 + y1) * k;
    }
  }
  if (Math.abs(a) < 1e-18) return [ox, oy];
  return [ox + x / (3 * a), oy + y / (3 * a)];
}

function ringArea(ring: number[][]): number {
  let a = 0;
  for (let i = 0; i + 1 < ring.length; i++) {
    a += ring[i]![0]! * ring[i + 1]![1]! - ring[i + 1]![0]! * ring[i]![1]!;
  }
  return Math.abs(a) / 2;
}

const largest = (polygons: number[][][][]) =>
  polygons.reduce((best, p) => (ringArea(p[0] ?? []) > ringArea(best[0] ?? []) ? p : best));

function vertexAverage(rings: number[][][]): LngLat {
  let x = 0;
  let y = 0;
  let n = 0;
  for (const ring of rings) {
    const open = ring.length > 1 ? ring.slice(0, -1) : ring;
    for (const [px, py] of open) {
      x += px!;
      y += py!;
      n++;
    }
  }
  return n ? [x / n, y / n] : [0, 0];
}

export type Union = typeof polygonClipping.union;

/** Identity of a building's pieces (order-independent). */
export const signatureOf = (pieces: number[][][][]): string =>
  pieces
    .map((p) => JSON.stringify(p))
    .sort()
    .join('|');

/** A building's tile pieces unioned back into its whole footprint. */
export function mergeFootprint(
  key: string,
  id: number | string,
  pieces: number[][][][],
  properties: Record<string, unknown>,
  signature: string,
  union: Union = polygonClipping.union,
  onError?: (key: string, err: unknown) => void,
): Footprint | undefined {
  const [first, ...rest] = pieces as unknown as Polygon[];
  let polygons: number[][][][];
  try {
    polygons = (rest.length ? union(first!, ...rest) : [first!]) as number[][][][];
  } catch (err) {
    // The clipper can fail on near-coincident pieces: keep the biggest one, not nothing.
    onError?.(key, err);
    polygons = [largest(pieces)];
  }
  if (!polygons.length) return undefined;
  return {
    id,
    key,
    polygons,
    properties,
    centroid: centroidOf(polygons),
    terrainPoint: vertexAverage(largest(polygons)),
    signature,
  };
}
