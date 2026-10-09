import { describe, expect, it, vi } from 'vitest';
import type { FeedMap } from '../../src/core/tileFeed';
import { WaterMask } from '../../src/core/waterMask';

const square = (x0: number, y0: number, d: number) => [
  [x0, y0],
  [x0 + d, y0],
  [x0 + d, y0 + d],
  [x0, y0 + d],
  [x0, y0],
];
const lake = {
  geometry: {
    type: 'Polygon',
    coordinates: [square(2.3, 48.85, 0.01), square(2.303, 48.853, 0.002)],
  },
  properties: {},
};

function fakeMap(features: unknown[]) {
  const handlers = new Map<string, (e: unknown) => void>();
  return {
    on: vi.fn((t: string, fn: (e: unknown) => void) => handlers.set(t, fn)),
    off: vi.fn(),
    getSource: () => ({}),
    querySourceFeatures: vi.fn(() => features),
    emit: (e: object) => handlers.get('sourcedata')!({ sourceId: 'src', ...e }),
  };
}

describe('WaterMask', () => {
  it('knows which points are in water (holes are islands), from the held tiles', () => {
    const map = fakeMap([lake]);
    const onChange = vi.fn();
    const mask = new WaterMask(map as unknown as FeedMap, {
      source: 'src',
      sourceLayer: 'water',
      onChange,
    });
    mask.settle();
    expect(onChange).toHaveBeenCalled();
    expect(mask.contains([2.301, 48.851])).toBe(true);
    expect(mask.contains([2.304, 48.854])).toBe(false); // island
    expect(mask.contains([2.32, 48.851])).toBe(false);
    expect(map.querySourceFeatures).toHaveBeenCalledWith(
      'src',
      expect.objectContaining({ sourceLayer: 'water' }),
    );
    mask.reset();
    expect(mask.contains([2.301, 48.851])).toBe(false);
  });

  it('answers from a per-tile raster for tiles: agrees with the exact test away from shores', async () => {
    const { pointInPolygons } = await import('../../src/core/geometry');
    const { tileBounds } = await import('../../src/core/tileFeed');
    const key = { z: 15, x: 16594, y: 11272 };
    const [w, s, e, n] = tileBounds('15/16594/11272');
    // A round lake with a square island, inside the tile.
    const cx = (w + e) / 2;
    const cy = (s + n) / 2;
    const r = (e - w) * 0.3;
    const ring = Array.from({ length: 65 }, (_, k) => {
      const a = (k / 64) * 2 * Math.PI;
      return [cx + r * Math.cos(a), cy + r * 0.7 * Math.sin(a)];
    });
    const d = r * 0.2;
    const island = [
      [cx - d, cy - d],
      [cx + d, cy - d],
      [cx + d, cy + d],
      [cx - d, cy + d],
      [cx - d, cy - d],
    ];
    const lakeTile = { geometry: { type: 'Polygon', coordinates: [ring, island] }, properties: {} };
    const map = fakeMap([]);
    const mask = new WaterMask(map as unknown as FeedMap, { source: 'src', sourceLayer: 'water' });
    map.emit({
      tile: {
        tileID: { canonical: key },
        querySourceFeatures: (result: unknown[]) => result.push(lakeTile),
      },
    });
    let agree = 0;
    let total = 0;
    for (let i = 1; i < 40; i++)
      for (let j = 1; j < 40; j++) {
        const p: [number, number] = [w + ((e - w) * i) / 40, s + ((n - s) * j) / 40];
        total++;
        if (mask.contains(p) === pointInPolygons(p, [[ring, island]])) agree++;
      }
    expect(agree / total).toBeGreaterThan(0.99);
    expect(mask.contains([cx, cy])).toBe(false); // the island
    expect(mask.contains([cx + r * 0.6, cy])).toBe(true);
    expect(mask.contains([w + (e - w) * 0.02, cy])).toBe(false);
  });

  it('looks up a tile of water in well under a microsecond per point', () => {
    const big = Array.from({ length: 5001 }, (_, k) => {
      const a = (k / 5000) * 2 * Math.PI;
      return [2.35 + 0.004 * Math.cos(a), 48.85 + 0.003 * Math.sin(a)];
    });
    const map = fakeMap([]);
    const mask = new WaterMask(map as unknown as FeedMap, { source: 'src', sourceLayer: 'water' });
    const z = 15;
    const x = Math.floor(((2.35 + 180) / 360) * 2 ** z);
    const rad = (48.85 * Math.PI) / 180;
    const y = Math.floor(
      ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z,
    );
    map.emit({
      tile: {
        tileID: { canonical: { z, x, y } },
        querySourceFeatures: (result: unknown[]) =>
          result.push({ geometry: { type: 'Polygon', coordinates: [big] }, properties: {} }),
      },
    });
    const t0 = performance.now();
    let wet = 0;
    for (let i = 0; i < 100_000; i++)
      if (
        mask.contains([
          2.35 + ((i % 300) - 150) * 0.00003,
          48.85 + (Math.floor(i / 300) - 166) * 0.00002,
        ])
      )
        wet++;
    expect(wet).toBeGreaterThan(0);
    expect(performance.now() - t0).toBeLessThan(process.env.CI ? 400 : 100);
  });
});
