import { bboxOf, pointInPolygon, type PolygonCoords } from './scatter';

export interface MappedTree {
  key: string;
  lngLat: [number, number];
}

/** Identity of one tile piece of a polygon (ring size + first two vertices). */
export const pieceKey = (p: PolygonCoords) =>
  `${p[0]?.length ?? 0}:${p[0]?.[0]?.join(',')}:${p[0]?.[1]?.join(',')}`;

/** Bucketed point lookup for counting mapped trees inside polygons. */
export class PointIndex {
  private static readonly CELL = 0.001; // degrees (~100 m)
  private readonly buckets = new Map<string, MappedTree[]>();

  constructor(points: MappedTree[]) {
    for (const p of points) {
      const k = this.key(p.lngLat[0], p.lngLat[1]);
      let b = this.buckets.get(k);
      if (!b) this.buckets.set(k, (b = []));
      b.push(p);
    }
  }

  countInside(pieces: PolygonCoords[]): number {
    const [w, s, e, n] = bboxOf(pieces);
    if (!Number.isFinite(w)) return 0;
    const c = PointIndex.CELL;
    let count = 0;
    for (let x = Math.floor(w / c); x <= Math.floor(e / c); x++) {
      for (let y = Math.floor(s / c); y <= Math.floor(n / c); y++) {
        for (const p of this.buckets.get(`${x}:${y}`) ?? []) {
          if (pieces.some((poly) => pointInPolygon(p.lngLat, poly))) count++;
        }
      }
    }
    return count;
  }

  private key(lng: number, lat: number): string {
    return `${Math.floor(lng / PointIndex.CELL)}:${Math.floor(lat / PointIndex.CELL)}`;
  }
}
