import polygonClipping, { type Polygon } from 'polygon-clipping';
import { polygonsOf } from '../core/geometry';
import type { LngLat } from '../core/types';

export interface SourceFeatureLike {
  id?: number | string | null;
  geometry: { type: string; coordinates: unknown };
  properties?: Record<string, unknown> | null;
}

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

/** Area-weighted centroid of the outer rings. */
function centroidOf(polygons: number[][][][]): LngLat {
  let a = 0;
  let x = 0;
  let y = 0;
  for (const rings of polygons) {
    const r = rings[0] ?? [];
    for (let i = 0; i + 1 < r.length; i++) {
      const [x0, y0] = r[i] as [number, number];
      const [x1, y1] = r[i + 1] as [number, number];
      const k = x0 * y1 - x1 * y0;
      a += k;
      x += (x0 + x1) * k;
      y += (y0 + y1) * k;
    }
  }
  if (Math.abs(a) < 1e-18) {
    const r = polygons[0]?.[0] ?? [[0, 0]];
    return r[0] as LngLat;
  }
  return [x / (3 * a), y / (3 * a)];
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

type Union = typeof polygonClipping.union;

/** Groups vector-tile pieces by feature id and unions them back into whole footprints. */
export class FootprintIndex {
  private cache = new Map<string, Footprint>();

  constructor(
    private readonly union: Union = polygonClipping.union,
    private readonly onError?: (key: string, err: unknown) => void,
  ) {}
  /** Pieces skipped in the last update for lacking an id. */
  missingIds = 0;

  update(
    features: SourceFeatureLike[],
    keep: (properties: Record<string, unknown>) => boolean,
  ): Map<string, Footprint> {
    this.missingIds = 0;
    const groups = new Map<
      string,
      { id: number | string; pieces: number[][][][]; properties: Record<string, unknown> }
    >();
    for (const f of features) {
      // Properties first: reading `geometry` decodes and projects the tile geometry.
      const properties = f.properties ?? {};
      if (!keep(properties)) continue;
      const polygons = polygonsOf(f.geometry);
      if (!polygons.length) continue;
      if (f.id === undefined || f.id === null) {
        this.missingIds++;
        continue;
      }
      const key = String(f.id);
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { id: f.id, pieces: [], properties }));
      g.pieces.push(...polygons);
    }
    const next = new Map<string, Footprint>();
    for (const [key, g] of groups) {
      const signature = g.pieces
        .map((p) => JSON.stringify(p))
        .sort()
        .join('|');
      const cached = this.cache.get(key);
      if (cached?.signature === signature) {
        next.set(key, cached);
        continue;
      }
      const [first, ...rest] = g.pieces as unknown as Polygon[];
      let polygons: number[][][][];
      try {
        polygons = (rest.length ? this.union(first!, ...rest) : [first!]) as number[][][][];
      } catch (err) {
        // The clipper can fail on near-coincident pieces: keep the biggest one, not nothing.
        this.onError?.(key, err);
        polygons = [largest(g.pieces)];
      }
      if (!polygons.length) continue;
      next.set(key, {
        id: g.id,
        key,
        polygons,
        properties: g.properties,
        centroid: centroidOf(polygons),
        terrainPoint: vertexAverage(largest(polygons)),
        signature,
      });
    }
    this.cache = next;
    return next;
  }
}
