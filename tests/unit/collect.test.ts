import { describe, expect, it, vi } from 'vitest';
import {
  collectMapped,
  collectPolygons,
  piecesHash,
  PointIndex,
  type CollectTarget,
} from '../../src/trees/collect';

const pt = (id: number | undefined, lng: number, lat: number, kind = 'tree') => ({
  id,
  properties: { kind },
  geometry: { type: 'Point', coordinates: [lng, lat] },
});
const ring = (x: number, y: number, d = 0.001) => [
  [x, y],
  [x + d, y],
  [x + d, y + d],
  [x, y + d],
  [x, y],
];
const poly = (id: number | undefined, kind: string, coords: number[][][]) => ({
  id,
  properties: { kind },
  geometry: { type: 'Polygon', coordinates: coords },
});

function fake(features: unknown[]) {
  const querySourceFeatures = vi.fn(() => features);
  return { map: { querySourceFeatures } as unknown as CollectTarget, querySourceFeatures };
}

describe('collectMapped', () => {
  it('queries tree points and de-duplicates tiles by id', () => {
    const { map, querySourceFeatures } = fake([
      pt(1, 2.29, 48.85),
      pt(1, 2.29, 48.85),
      pt(2, 2.291, 48.85),
      pt(undefined, 2.292, 48.85),
      poly(9, 'park', [ring(2.29, 48.85)]),
    ]);
    const trees = collectMapped(map, 'protomaps', 'pois');
    expect(trees.map((t) => t.key)).toEqual(['t:1', 't:2', 't:2.292000,48.850000']);
    expect(querySourceFeatures).toHaveBeenCalledWith('protomaps', {
      sourceLayer: 'pois',
      filter: ['==', ['get', 'kind'], 'tree'],
    });
  });

  it('omits the source layer for GeoJSON sources', () => {
    const { map, querySourceFeatures } = fake([]);
    collectMapped(map, 'geo', '');
    expect(querySourceFeatures).toHaveBeenCalledWith('geo', {
      filter: ['==', ['get', 'kind'], 'tree'],
    });
  });
});

describe('collectPolygons', () => {
  it('groups pieces by kind and id, skipping features without ids', () => {
    const { map, querySourceFeatures } = fake([
      poly(5, 'park', [ring(2.29, 48.85)]),
      poly(5, 'park', [ring(2.291, 48.85)]),
      poly(5, 'park', [ring(2.29, 48.85)]), // same piece from an overlapping tile
      poly(undefined, 'park', [ring(2.3, 48.85)]),
      {
        id: 6,
        properties: { kind: 'forest' },
        geometry: { type: 'MultiPolygon', coordinates: [[ring(2.31, 48.85)], [ring(2.32, 48.85)]] },
      },
      pt(7, 2.29, 48.85),
    ]);
    const groups = collectPolygons(map, 'protomaps', 'landuse', ['park', 'forest']);
    expect(groups.map((g) => [g.id, g.kind, g.pieces.length])).toEqual([
      ['park:5', 'park', 2],
      ['forest:6', 'forest', 2],
    ]);
    expect(querySourceFeatures).toHaveBeenCalledWith('protomaps', {
      sourceLayer: 'landuse',
      filter: ['in', ['get', 'kind'], ['literal', ['park', 'forest']]],
    });
  });

  it('does not query when no kinds are scattered', () => {
    const { map, querySourceFeatures } = fake([]);
    expect(collectPolygons(map, 'protomaps', 'landuse', [])).toEqual([]);
    expect(querySourceFeatures).not.toHaveBeenCalled();
  });
});

describe('PointIndex and piecesHash', () => {
  it('counts only points inside the pieces', () => {
    const index = new PointIndex([
      { key: 'a', lngLat: [2.2905, 48.8505] },
      { key: 'b', lngLat: [2.2915, 48.8505] },
      { key: 'c', lngLat: [2.2995, 48.8595] },
    ]);
    expect(index.countInside([[ring(2.29, 48.85)]])).toBe(1);
    expect(index.countInside([[ring(2.29, 48.85)], [ring(2.291, 48.85)]])).toBe(2);
  });

  it('changes when a piece is added', () => {
    const one = [[ring(2.29, 48.85)]];
    expect(piecesHash(one)).toBe(piecesHash([[ring(2.29, 48.85)]]));
    expect(piecesHash([...one, [ring(2.291, 48.85)]])).not.toBe(piecesHash(one));
  });
});
