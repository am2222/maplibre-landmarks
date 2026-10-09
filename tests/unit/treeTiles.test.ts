import { describe, expect, it } from 'vitest';
import type { FeedFeature } from '../../src/core/tileFeed';
import { scatterPiece } from '../../src/trees/scatter';
import { TreeTiles } from '../../src/trees/tileStore';

const C: [number, number] = [2.2945, 48.8584];
const M = 111_195;
const kx = M * Math.cos((C[1] * Math.PI) / 180);
const at = (e: number, n: number): [number, number] => [C[0] + e / kx, C[1] + n / M];
const rect = (w: number, s: number, e: number, n: number) => [
  at(w, s),
  at(e, s),
  at(e, n),
  at(w, n),
  at(w, s),
];
const park = (id: number, ring: number[][]): FeedFeature => ({
  id,
  properties: { kind: 'park' },
  geometry: { type: 'Polygon', coordinates: [ring] },
});
const tree = (id: number, lngLat: [number, number]): FeedFeature => ({
  id,
  properties: { kind: 'tree' },
  geometry: { type: 'Point', coordinates: lngLat },
});
const opts = { scatter: { park: 1 / 400 }, skipRatio: 0.25 };
const keysOf = (store: TreeTiles) =>
  store
    .tiles()
    .flatMap((t) => t.scatter().map((p) => p.key))
    .sort();

describe('TreeTiles', () => {
  it('scatters a park split over two tiles exactly as its pieces scatter today', () => {
    const store = new TreeTiles(opts);
    const west = rect(-200, -100, 0, 100);
    const east = rect(0, -100, 200, 100);
    store.setPolygons('15/1/1', [park(1, west)]);
    store.setPolygons('15/2/1', [park(1, east)]);
    const expected = [
      ...scatterPiece('park', [west], 1 / 400),
      ...scatterPiece('park', [east], 1 / 400),
    ]
      .map((p) => p.key)
      .sort();
    expect(keysOf(store)).toEqual(expected);
  });

  it('drops only the dropped tile', () => {
    const store = new TreeTiles(opts);
    store.setPolygons('15/1/1', [park(1, rect(-200, -100, 0, 100))]);
    store.setPolygons('15/2/1', [park(1, rect(0, -100, 200, 100))]);
    store.setPoints('15/2/1', [tree(7, at(100, 0))]);
    store.drop('15/1/1');
    expect(store.tiles().map((t) => t.key)).toEqual(['15/2/1']);
    expect(store.tiles()[0]!.mapped.map((m) => m.key)).toEqual(['t:7']);
  });

  it('skips scattering a piece that already holds enough mapped trees (per piece)', () => {
    const store = new TreeTiles(opts);
    const ring = rect(-50, -50, 50, 50); // 10,000 m²: target 25 trees, skip at 25% = 6.25
    store.setPolygons('15/1/1', [park(1, ring)]);
    store.setPoints(
      '15/1/1',
      Array.from({ length: 8 }, (_, i) => tree(i, at(-30 + i * 8, 0))),
    );
    expect(store.tiles()[0]!.scatter()).toHaveLength(0);
    store.setPoints('15/1/1', [tree(1, at(0, 0))]);
    expect(store.tiles()[0]!.scatter().length).toBeGreaterThan(0);
  });

  it("dropping a tile's points keeps its polygons (two feeds share the tile)", () => {
    const store = new TreeTiles(opts);
    store.setPolygons('15/1/1', [park(1, rect(-200, -100, 0, 100))]);
    store.setPoints('15/1/1', [tree(1, at(-300, 0))]);
    store.dropPoints('15/1/1');
    expect(store.tiles()).toHaveLength(1);
    expect(store.tiles()[0]!.scatter().length).toBeGreaterThan(0);
    store.dropPolygons('15/1/1');
    expect(store.tiles()).toHaveLength(0);
  });

  it('gives every scattered tree its thinning value once', () => {
    const store = new TreeTiles(opts);
    store.setPolygons('15/1/1', [park(1, rect(-200, -100, 200, 100))]);
    for (const p of store.tiles()[0]!.scatter()) {
      expect(p.thin).toBeGreaterThanOrEqual(0);
      expect(p.thin).toBeLessThan(1);
    }
  });

  it('re-scatters only tiles whose data changed (piece cache)', () => {
    const store = new TreeTiles(opts);
    store.setPolygons('15/1/1', [park(1, rect(-200, -100, 0, 100))]);
    store.tiles().forEach((t) => t.scatter());
    const before = store.piecesScattered;
    store.setPolygons('15/2/1', [park(1, rect(0, -100, 200, 100))]);
    store.tiles().forEach((t) => t.scatter());
    expect(store.piecesScattered - before).toBe(1);
  });
});
