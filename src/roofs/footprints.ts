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

/** Groups vector-tile pieces by feature id and unions them back into whole footprints. */
export class FootprintIndex {
  private cache = new Map<string, Footprint>();
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
      const polygons = polygonsOf(f.geometry);
      if (!polygons.length) continue;
      const properties = f.properties ?? {};
      if (!keep(properties)) continue;
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
      const polygons = (
        rest.length ? polygonClipping.union(first!, ...rest) : [first!]
      ) as number[][][][];
      next.set(key, {
        id: g.id,
        key,
        polygons,
        properties: g.properties,
        centroid: centroidOf(polygons),
        signature,
      });
    }
    this.cache = next;
    return next;
  }
}
