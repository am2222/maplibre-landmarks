import type { Map as MlMap } from 'maplibre-gl';
import { polygonsOf } from '../core/geometry';
import { bboxOf, pointInPolygon, type PolygonCoords } from './scatter';

export type CollectTarget = Pick<MlMap, 'querySourceFeatures'>;

export interface MappedTree {
  key: string;
  lngLat: [number, number];
}

export interface PolygonGroup {
  /** `kind:featureId` */
  id: string;
  kind: string;
  pieces: PolygonCoords[];
}

const layerOpt = (sourceLayer?: string) => (sourceLayer ? { sourceLayer } : {});

/** Protomaps `pois` points with kind=tree, de-duplicated across tiles. */
export function collectMapped(
  map: CollectTarget,
  source: string,
  sourceLayer?: string,
): MappedTree[] {
  const features = map.querySourceFeatures(source, {
    ...layerOpt(sourceLayer),
    filter: ['==', ['get', 'kind'], 'tree'],
  });
  const out = new Map<string, MappedTree>();
  for (const f of features) {
    if (f.geometry.type !== 'Point') continue;
    const [lng, lat] = f.geometry.coordinates as [number, number];
    const key =
      f.id !== undefined && f.id !== null ? `t:${f.id}` : `t:${lng.toFixed(6)},${lat.toFixed(6)}`;
    if (!out.has(key)) out.set(key, { key, lngLat: [lng, lat] });
  }
  return [...out.values()];
}

/** Identity of one tile piece of a polygon (ring size + first two vertices). */
export const pieceKey = (p: PolygonCoords) =>
  `${p[0]?.length ?? 0}:${p[0]?.[0]?.join(',')}:${p[0]?.[1]?.join(',')}`;

/** Green polygons of the given kinds, grouped by feature id (tiles split them into pieces). */
export function collectPolygons(
  map: CollectTarget,
  source: string,
  sourceLayer: string | undefined,
  kinds: string[],
): PolygonGroup[] {
  if (!kinds.length) return [];
  const features = map.querySourceFeatures(source, {
    ...layerOpt(sourceLayer),
    filter: ['in', ['get', 'kind'], ['literal', kinds]],
  });
  const groups = new Map<string, PolygonGroup & { seen: Set<string> }>();
  for (const f of features) {
    if (f.id === undefined || f.id === null) continue;
    const polys: PolygonCoords[] = polygonsOf(f.geometry as { type: string; coordinates: unknown });
    if (!polys.length) continue;
    const kind = String(f.properties?.kind);
    const id = `${kind}:${f.id}`;
    let group = groups.get(id);
    if (!group) groups.set(id, (group = { id, kind, pieces: [], seen: new Set() }));
    for (const p of polys) {
      const k = pieceKey(p);
      if (group.seen.has(k)) continue;
      group.seen.add(k);
      group.pieces.push(p);
    }
  }
  return [...groups.values()].map(({ id, kind, pieces }) => ({ id, kind, pieces }));
}

/** Changes whenever pieces are added or removed (tiles loading in or out). */
export function piecesHash(pieces: PolygonCoords[]): string {
  return pieces.map(pieceKey).sort().join('|');
}

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
