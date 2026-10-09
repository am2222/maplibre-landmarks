import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Color, Group, Scene } from 'three';
import type { ModuleContext } from '../../src/core/LayerModule';
import { localPosition, originAt } from '../../src/core/mercator';
import { THEMES } from '../../src/core/theme';
import type { TreeModel } from '../../src/trees/models/types';
import { TreesModule, type TreesOptions } from '../../src/trees/TreesModule';
import { PointIndex } from '../../src/trees/collect';
import type { TreeUniforms } from '../../src/trees/material';
import { flush, view } from './helpers';

const C: [number, number] = [2.2945, 48.8584];
const M = 111_195;
const kx = M * Math.cos((C[1] * Math.PI) / 180);
const at = (e: number, n: number): [number, number] => [C[0] + e / kx, C[1] + n / M];
const square = (e: number, n: number, size: number) => [
  at(e - size / 2, n - size / 2),
  at(e + size / 2, n - size / 2),
  at(e + size / 2, n + size / 2),
  at(e - size / 2, n + size / 2),
  at(e - size / 2, n - size / 2),
];
const point = (id: number, lngLat: [number, number]) => ({
  id,
  properties: { kind: 'tree' },
  geometry: { type: 'Point', coordinates: lngLat },
});
const polygon = (id: number, kind: string, ring: number[][]) => ({
  id,
  properties: { kind },
  geometry: { type: 'Polygon', coordinates: [ring] },
});

const box: TreeModel = {
  id: 'box',
  variants: 2,
  build: () => ({
    trunk: new BoxGeometry(0.2, 1, 0.2).translate(0, 0.5, 0),
    foliage: new BoxGeometry(1, 1, 1).translate(0, 1.5, 0),
  }),
};

function setup(
  over: Partial<TreesOptions> = {},
  data?: { points?: unknown[]; polygons?: unknown[]; water?: unknown[] },
) {
  const features = {
    points: data?.points ?? [point(1, at(10, 0)), point(2, at(-20, 5)), point(3, at(400, 0))],
    polygons: data?.polygons ?? [],
    water: data?.water ?? [],
  };
  const handlers = new Map<string, (e: unknown) => void>();
  const listeners = new Map<string, ((e: unknown) => void)[]>();
  const map = {
    features,
    handlers,
    getSource: (id: string) => (id === 'src' ? {} : undefined),
    terrain: null as { source: string } | null,
    getTerrain(): { source: string } | null {
      return this.terrain;
    },
    queryTerrainElevation: vi.fn(() => 35),
    zoom: 17,
    getZoom(): number {
      return this.zoom;
    },
    querySourceFeatures: vi.fn((_s: string, o: { filter: unknown[]; sourceLayer?: string }) =>
      o.sourceLayer === 'water'
        ? features.water
        : o.filter[0] === '=='
          ? features.points
          : features.polygons,
    ),
    // Several listeners per event (the module and its tile feeds); handlers.get(t) calls them all.
    on: vi.fn((t: string, fn: (e: unknown) => void) => {
      const list = listeners.get(t) ?? [];
      list.push(fn);
      listeners.set(t, list);
      handlers.set(t, (e: unknown) => [...(listeners.get(t) ?? [])].forEach((f) => f(e)));
    }),
    off: vi.fn((t: string, fn?: (e: unknown) => void) => {
      const list = (listeners.get(t) ?? []).filter((f) => f !== fn);
      listeners.set(t, list);
      if (!list.length) handlers.delete(t);
    }),
  };
  const scene = new Scene();
  const core = { theme: 'day', setTheme: vi.fn() };
  const requestRepaint = vi.fn();
  const onError = vi.fn();
  // Every tree drawn unless a test is about density.
  const module = new TreesModule({
    source: 'src',
    models: [box],
    minZoom: 15,
    density: 1,
    onError,
    ...over,
  });
  const ctx = { map, core, scene, requestRepaint } as unknown as ModuleContext;
  module.onAdd(ctx);
  return { module, map, scene, core, requestRepaint, onError, ctx };
}

const uniformsOf = (scene: Scene) =>
  (
    (scene.children[0] as Group).children[0] as unknown as {
      material: { userData: { treeUniforms: TreeUniforms } };
    }
  ).material.userData.treeUniforms;

afterEach(() => vi.useRealTimers());

describe('TreesModule', () => {
  it('draws mapped trees once models are ready', async () => {
    const s = setup();
    s.module.update(view({ center: C, zoom: 17 }));
    await flush();
    const stats = s.module.getStats();
    expect(stats.mapped).toBe(3);
    expect(stats.drawn).toBe(3);
    expect(stats.near).toBe(2); // the tree 400 m away is beyond lodDistanceM 300
    expect(stats.far).toBe(1);
    expect(s.requestRepaint).toHaveBeenCalled();
  });

  it('raises newly shown trees from the ground, repainting until they stand', async () => {
    const s = setup({ wind: { strength: 0 }, riseMs: 400 });
    s.module.update(view({ center: C, zoom: 17 }));
    await flush();
    const now = performance.now();
    expect(s.module.frame(now)).toBe(true); // rising (wind is calm)
    expect(uniformsOf(s.scene).uRise.value).toBeCloseTo(0.4, 6);
    expect(s.module.frame(now + 500)).toBe(false); // standing: no more repaints needed
  });

  it('applies the theme option and follows theme changes', async () => {
    const s = setup({ theme: 'dusk' });
    expect(s.core.setTheme).toHaveBeenCalledWith('dusk');
    await flush(); // meshes (and so the material) exist once models are prepared
    s.module.themeChanged('night');
    const u = uniformsOf(s.scene);
    expect(u.uFoliage.value.equals(new Color(THEMES.night.palette.foliage))).toBe(true);
  });

  it('scatters into a park without mapped trees and skips a forest full of them', async () => {
    const forestTrees = Array.from({ length: 20 }, (_, i) =>
      point(100 + i, at(-110 + (i % 5) * 10, -20 + Math.floor(i / 5) * 10)),
    );
    const s = setup(
      {},
      {
        points: forestTrees,
        polygons: [polygon(1, 'park', square(90, 0, 80)), polygon(2, 'forest', square(-90, 0, 60))],
      },
    );
    s.module.update(view({ center: C, zoom: 17 }));
    await flush();
    const stats = s.module.getStats();
    expect(stats.polygonsFilled).toBe(1);
    expect(stats.polygonsSkipped).toBe(1);
    expect(stats.scattered).toBeGreaterThan(8);
    expect(stats.drawn).toBe(20 + stats.scattered);
  });

  it('keeps a fixed share of trees by density, mapped street trees too, live', async () => {
    const street = Array.from({ length: 200 }, (_, k) => point(1000 + k, at(-100 + k, 50)));
    const data = { points: street, polygons: [polygon(2, 'forest', square(0, -100, 200))] };
    const full = setup({ density: 1, maxTrees: 100_000 }, data);
    full.module.update(view({ center: C, zoom: 17 }));
    await flush();
    const all = full.module.getStats();
    expect(all.mapped).toBe(200);
    const half = setup({ density: 0.5, maxTrees: 100_000 }, data);
    half.module.update(view({ center: C, zoom: 17 }));
    await flush();
    const kept = half.module.getStats();
    for (const [n, total] of [
      [kept.scattered, all.scattered],
      [kept.mapped, all.mapped],
    ] as const) {
      expect(n / total).toBeGreaterThan(0.38);
      expect(n / total).toBeLessThan(0.62);
    }
    half.module.setDensity(1);
    expect(half.module.getStats()).toMatchObject({ mapped: all.mapped, scattered: all.scattered });
  });

  it('pitched: draws no tree beyond the far cutoff, and shrinks those near it', async () => {
    const s = setup({}, { points: [point(1, at(10, 0)), point(2, at(2000, 0))] });
    const wide = { center: C, zoom: 17, heightPx: 900, bounds: [2.2, 48.8, 2.4, 48.9] as const };
    s.module.update(view({ ...wide, pitch: 70, bounds: [...wide.bounds] })); // cutoff ~1.06 km
    await flush();
    expect(s.module.getStats().drawn).toBe(1);
    const u = uniformsOf(s.scene);
    expect(u.uCutoff.value).toBeGreaterThan(1000);
    expect(u.uCutoff.value).toBeLessThan(1100);
    s.module.update(view({ ...wide, pitch: 30, bounds: [...wide.bounds] }));
    expect(s.module.getStats().drawn).toBe(2);
    expect(u.uCutoff.value).toBeGreaterThan(1e8); // off
  });

  it('draws past the cutoff when farCutoff is off', async () => {
    const s = setup({ farCutoff: false }, { points: [point(1, at(10, 0)), point(2, at(2000, 0))] });
    s.module.update(
      view({ center: C, zoom: 17, pitch: 70, heightPx: 900, bounds: [2.2, 48.8, 2.4, 48.9] }),
    );
    await flush();
    expect(s.module.getStats().drawn).toBe(2);
  });

  it('pitched: reads a far tile only once the cutoff reaches it', async () => {
    const s = setup({}, { points: [] });
    const pitched = view({ center: C, zoom: 17, pitch: 70, heightPx: 900 });
    s.module.update(pitched);
    await flush();
    const query = vi.fn();
    s.map.handlers.get('sourcedata')!({
      sourceId: 'src',
      tile: { tileID: { canonical: { z: 15, x: 16610, y: 11272 } }, querySourceFeatures: query },
    }); // ~14 km east
    expect(query).not.toHaveBeenCalled();
    s.module.update(view({ center: C, zoom: 17, pitch: 20, heightPx: 900 }));
    expect(query).toHaveBeenCalled();
  });

  it('scatters no tree into a lake inside a wood (mapped trees stay)', async () => {
    const wood = polygon(2, 'forest', square(0, 0, 200));
    const lake = {
      properties: { kind: 'water' },
      geometry: { type: 'Polygon', coordinates: [square(0, 0, 100)] },
    };
    const dry = setup({ maxTrees: 100_000 }, { points: [point(1, at(10, 10))], polygons: [wood] });
    dry.module.update(view({ center: C, zoom: 17 }));
    await flush();
    const wet = setup(
      { maxTrees: 100_000 },
      { points: [point(1, at(10, 10))], polygons: [wood], water: [lake] },
    );
    wet.module.update(view({ center: C, zoom: 17 }));
    await flush();
    const [all, kept] = [dry.module.getStats(), wet.module.getStats()];
    // A quarter of the wood is lake: about a quarter of its trees go, the mapped one stays.
    expect(kept.scattered / all.scattered).toBeGreaterThan(0.68);
    expect(kept.scattered / all.scattered).toBeLessThan(0.82);
    expect(kept.mapped).toBe(1);
  });

  it('reads no water from a source without layers (GeoJSON), unless one is named', async () => {
    const s = setup({ sourceLayers: { points: '', polygons: '' } });
    s.module.update(view({ center: C, zoom: 17 }));
    await flush();
    const layersAsked = s.map.querySourceFeatures.mock.calls.map(
      (c) => (c[1] as { sourceLayer?: string }).sourceLayer,
    );
    expect(layersAsked).not.toContain('water');
    expect(s.map.querySourceFeatures.mock.calls).toHaveLength(2); // points and woods only
  });

  it('recomputes scatter when more pieces of a polygon load', async () => {
    const full = square(90, 0, 80);
    const westHalf = [at(50, -40), at(90, -40), at(90, 40), at(50, 40), at(50, -40)];
    const s = setup({}, { points: [], polygons: [polygon(1, 'park', westHalf)] });
    s.module.update(view({ center: C, zoom: 17 }));
    await flush();
    const partial = s.module.getStats().scattered;
    s.map.features.polygons = [polygon(1, 'park', westHalf), polygon(1, 'park', full)];
    s.module.update(view({ center: C, zoom: 17 }));
    expect(s.module.getStats().scattered).toBeGreaterThan(partial);
  });

  it('draws nothing below minZoom', async () => {
    const s = setup();
    s.module.update(view({ center: C, zoom: 14 }));
    await flush();
    expect(s.module.getStats().drawn).toBe(0);
    expect(s.map.querySourceFeatures).not.toHaveBeenCalled();
  });

  it('stays fast in a near-horizontal view: far woods cannot beat the nearest trees', async () => {
    // A low camera sees woods out to the horizon: 3,000 woods over ~10 km, one park near the
    // centre, delivered tile by tile (z15) as MapLibre loads them.
    const woods = Array.from({ length: 3000 }, (_, i) =>
      polygon(10 + i, 'wood', square(400 + (i % 60) * 160, -4000 + Math.floor(i / 60) * 160, 120)),
    );
    const near = polygon(1, 'park', square(0, 0, 300));
    const s = setup({ maxTrees: 4000, thinBeyondM: Infinity }, { points: [], polygons: [] });
    await flush();
    const z15 = (lng: number, lat: number) => {
      const r = (lat * Math.PI) / 180;
      return {
        z: 15,
        x: Math.floor(((lng + 180) / 360) * 2 ** 15),
        y: Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** 15),
      };
    };
    const byTile = new Map<
      string,
      { tile: { z: number; x: number; y: number }; features: unknown[] }
    >();
    for (const f of [near, ...woods]) {
      const [lng, lat] = (f.geometry.coordinates as number[][][])[0]![0]!;
      const tile = z15(lng!, lat!);
      const key = `${tile.x}/${tile.y}`;
      if (!byTile.has(key)) byTile.set(key, { tile, features: [] });
      byTile.get(key)!.features.push(f);
    }
    const wide = view({ center: C, zoom: 17, pitch: 85, bounds: [2.2, 48.8, 2.45, 48.95] });
    s.module.update(wide); // seeds the feeds (nothing loaded yet)
    for (const { tile, features } of byTile.values())
      s.map.handlers.get('sourcedata')!({
        sourceId: 'src',
        tile: {
          tileID: { canonical: tile },
          querySourceFeatures: (
            result: unknown[],
            params: { filter: unknown[]; sourceLayer?: string },
          ) => {
            // Woods only: no tree points, and no water in these tiles.
            if (params.filter[0] !== '==' && params.sourceLayer !== 'water')
              result.push(...features);
          },
        },
      });
    s.map.querySourceFeatures.mockClear();
    const t0 = performance.now();
    s.module.update(wide);
    const ms = performance.now() - t0;
    // Tiles arrived through events: updating reads nothing from the source.
    expect(s.map.querySourceFeatures).not.toHaveBeenCalled();
    expect(s.module.getStats().drawn).toBe(4000);
    // Far tiles are never scattered: the nearest tiles already hold the nearest 4,000 trees.
    expect(ms).toBeLessThan(process.env.CI ? 1500 : 300);
  });

  it('thins woods with distance and stops reading them 8× the thinning distance out', async () => {
    // A low camera sees woods out to the horizon: 3,000 woods over ~10 km, one park near the
    // centre, delivered tile by tile (z15) as MapLibre loads them.
    const woods = Array.from({ length: 3000 }, (_, i) =>
      polygon(10 + i, 'wood', square(400 + (i % 60) * 160, -4000 + Math.floor(i / 60) * 160, 120)),
    );
    const near = polygon(1, 'park', square(0, 0, 300));
    const s = setup({ maxTrees: 4000 }, { points: [], polygons: [] });
    await flush();
    const z15 = (lng: number, lat: number) => {
      const r = (lat * Math.PI) / 180;
      return {
        z: 15,
        x: Math.floor(((lng + 180) / 360) * 2 ** 15),
        y: Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** 15),
      };
    };
    const byTile = new Map<
      string,
      { tile: { z: number; x: number; y: number }; features: unknown[] }
    >();
    for (const f of [near, ...woods]) {
      const [lng, lat] = (f.geometry.coordinates as number[][][])[0]![0]!;
      const tile = z15(lng!, lat!);
      const key = `${tile.x}/${tile.y}`;
      if (!byTile.has(key)) byTile.set(key, { tile, features: [] });
      byTile.get(key)!.features.push(f);
    }
    const wide = view({ center: C, zoom: 17, pitch: 85, bounds: [2.2, 48.8, 2.45, 48.95] });
    s.module.update(wide); // seeds the feeds (nothing loaded yet)
    for (const { tile, features } of byTile.values())
      s.map.handlers.get('sourcedata')!({
        sourceId: 'src',
        tile: {
          tileID: { canonical: tile },
          querySourceFeatures: (
            result: unknown[],
            params: { filter: unknown[]; sourceLayer?: string },
          ) => {
            // Woods only: no tree points, and no water in these tiles.
            if (params.filter[0] !== '==' && params.sourceLayer !== 'water')
              result.push(...features);
          },
        },
      });
    s.map.querySourceFeatures.mockClear();
    const t0 = performance.now();
    s.module.update(wide);
    const ms = performance.now() - t0;
    // Tiles arrived through events: updating reads nothing from the source.
    expect(s.map.querySourceFeatures).not.toHaveBeenCalled();
    // Thinned: the budget is never reached, yet tiles past 2 km are skipped, so it stays fast.
    const { drawn } = s.module.getStats();
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThan(4000);
    expect(ms).toBeLessThan(process.env.CI ? 1500 : 300);
  });

  it('zoomed out below minZoom: holds no tiles and ignores arriving ones', async () => {
    const s = setup();
    s.module.update(view({ center: C, zoom: 17 }));
    await flush();
    s.module.update(view({ center: C, zoom: 12 }));
    const query = vi.fn();
    s.map.handlers.get('sourcedata')!({
      sourceId: 'src',
      tile: { tileID: { canonical: { z: 12, x: 2074, y: 1409 } }, querySourceFeatures: query },
    });
    expect(query).not.toHaveBeenCalled();
    s.map.querySourceFeatures.mockClear();
    s.module.update(view({ center: C, zoom: 17 })); // back in: seeded from what is loaded
    expect(s.map.querySourceFeatures).toHaveBeenCalled();
    expect(s.module.getStats().mapped).toBe(3);
  });

  /** A tile announced by MapLibre with its own trees (points) and green polygons. */
  const tileWith = (canonical: object, points: unknown[], polygons: unknown[] = []) => ({
    tileID: { canonical },
    querySourceFeatures: (
      result: unknown[],
      params: { filter: unknown[]; sourceLayer?: string },
    ) =>
      params.sourceLayer === 'water'
        ? 0
        : result.push(...(params.filter[0] === '==' ? points : polygons)),
  });

  it('keeps a reloaded tile drawn once (the same tile object announced again)', async () => {
    const s = setup({}, { points: [] });
    s.module.update(view({ center: C, zoom: 17 }));
    await flush();
    const tile = tileWith({ z: 15, x: 16594, y: 11272 }, [point(1, at(10, 0))]);
    s.map.handlers.get('sourcedata')!({ sourceId: 'src', tile });
    s.map.handlers.get('sourcedata')!({ sourceId: 'src', tile }); // reload
    s.module.update(view({ center: C, zoom: 17 }));
    expect(s.module.getStats().mapped).toBe(1);
    expect(s.module.getStats().drawn).toBe(1);
  });

  it('draws a tree held by a parent and a child tile once', async () => {
    const s = setup({}, { points: [] });
    s.module.update(view({ center: C, zoom: 17 }));
    await flush();
    const tree = point(1, at(10, 0));
    for (const canonical of [
      { z: 14, x: 8297, y: 5636 },
      { z: 15, x: 16594, y: 11272 },
    ])
      s.map.handlers.get('sourcedata')!({ sourceId: 'src', tile: tileWith(canonical, [tree]) });
    s.module.update(view({ center: C, zoom: 17 }));
    expect(s.module.getStats().drawn).toBe(1);
  });

  it("does not double a park's scattered trees while a parent and a child tile hold it", async () => {
    const park = (size: number) => polygon(5, 'park', square(0, 0, size));
    const scatteredWith = async (parentToo: boolean) => {
      const s = setup({}, { points: [] });
      s.module.update(view({ center: C, zoom: 17 }));
      await flush();
      if (parentToo)
        s.map.handlers.get('sourcedata')!({
          sourceId: 'src',
          tile: tileWith({ z: 14, x: 8296, y: 5636 }, [], [park(61)]), // its own simplification
        });
      s.map.handlers.get('sourcedata')!({
        sourceId: 'src',
        tile: tileWith({ z: 15, x: 16592, y: 11272 }, [], [park(60)]),
      });
      s.module.update(view({ center: C, zoom: 17 }));
      return s.module.getStats().scattered;
    };
    const childOnly = await scatteredWith(false);
    expect(childOnly).toBeGreaterThan(0);
    expect(await scatteredWith(true)).toBe(childOnly);
  });

  it('starts its tiles over after a style swap and draws again', async () => {
    const s = setup();
    s.module.update(view({ center: C, zoom: 17 }));
    await flush();
    s.map.querySourceFeatures.mockClear();
    s.module.styleChanged(true);
    expect(s.map.querySourceFeatures).toHaveBeenCalled(); // re-seeded
    expect(s.module.getStats().mapped).toBe(3);
  });

  it('counts mapped trees inside a piece again only when its tile changes', async () => {
    const count = vi.spyOn(PointIndex.prototype, 'countInside');
    const s = setup(
      {},
      { points: [point(1, at(80, 0))], polygons: [polygon(1, 'park', square(90, 0, 80))] },
    );
    await flush();
    s.module.update(view({ center: C, zoom: 17 }));
    const first = count.mock.calls.length;
    expect(first).toBeGreaterThan(0);
    s.module.update(view({ center: C, zoom: 17 }));
    expect(count.mock.calls.length).toBe(first); // nothing changed: kept
    s.map.features.points = [point(1, at(80, 0)), point(2, at(95, 5))];
    s.module.update(view({ center: C, zoom: 17 }));
    expect(count.mock.calls.length).toBe(first + 1); // the tile's trees changed: counted again
    count.mockRestore();
  });

  it('caps at maxTrees', async () => {
    const s = setup({ maxTrees: 2 });
    s.module.update(view({ center: C, zoom: 17 }));
    await flush();
    expect(s.module.getStats().drawn).toBe(2);
  });

  it('animates only while there is wind and trees', async () => {
    const s = setup();
    expect(s.module.frame(1000)).toBe(false); // nothing drawn yet
    s.module.update(view({ center: C, zoom: 17 }));
    await flush();
    expect(s.module.frame(2000)).toBe(true);
    expect(uniformsOf(s.scene).uTime.value).toBe(2);
    s.module.setWind({ strength: 0 });
    expect(s.module.frame(3000)).toBe(false);
  });

  it('reports a missing source once', async () => {
    const s = setup({ source: 'nope' });
    await flush();
    s.module.update(view({ center: C, zoom: 17 }));
    s.module.update(view({ center: C, zoom: 17 }));
    expect(s.onError).toHaveBeenCalledTimes(1);
    expect(s.onError.mock.calls[0]![1]).toEqual({ stage: 'source' });
  });

  it('drops a failing model, reports it, and draws with the others', async () => {
    const broken: TreeModel = { id: 'broken', build: () => Promise.reject(new Error('404')) };
    const s = setup({ models: [broken, box] });
    s.module.update(view({ center: C, zoom: 17 }));
    await flush();
    expect(s.onError).toHaveBeenCalledWith(expect.any(Error), { stage: 'model', id: 'broken' });
    expect(s.module.getStats().drawn).toBe(3);
  });

  it('re-runs the update when tiles of its source load', async () => {
    const s = setup({}, { points: [] });
    s.module.update(view({ center: C, zoom: 17 }));
    await flush();
    expect(s.module.getStats().drawn).toBe(0);
    vi.useFakeTimers();
    s.map.features.points = [point(1, at(10, 0))];
    s.map.handlers.get('sourcedata')!({ sourceId: 'other' });
    vi.advanceTimersByTime(250);
    expect(s.module.getStats().drawn).toBe(0);
    s.map.handlers.get('sourcedata')!({ sourceId: 'src' });
    vi.advanceTimersByTime(250);
    expect(s.module.getStats().drawn).toBe(1);
  });

  it('places the batch group relative to the render origin', async () => {
    const s = setup();
    s.module.update(view({ center: C, zoom: 17 }));
    await flush();
    const origin = originAt(at(50, 0));
    s.module.place(origin);
    const group = s.scene.children[0] as Group;
    expect(group.position.x).toBeCloseTo(localPosition(origin, C, 0)[0], 6);
  });

  it('cleans up, including when removed before models are ready', async () => {
    const s = setup();
    s.module.onRemove();
    await flush();
    expect(s.scene.children).toHaveLength(0);
    expect(s.map.handlers.has('sourcedata')).toBe(false);
    expect(s.onError).not.toHaveBeenCalled();
  });

  it('scatters only newly loaded pieces of a polygon (review #1)', async () => {
    const westHalf = [at(50, -40), at(90, -40), at(90, 40), at(50, 40), at(50, -40)];
    const eastHalf = [at(90, -40), at(130, -40), at(130, 40), at(90, 40), at(90, -40)];
    const s = setup({}, { points: [], polygons: [polygon(1, 'park', westHalf)] });
    s.module.update(view({ center: C, zoom: 17 }));
    await flush();
    expect(s.module.getStats().piecesScattered).toBe(1);
    s.map.features.polygons = [polygon(1, 'park', westHalf), polygon(1, 'park', eastHalf)];
    s.module.update(view({ center: C, zoom: 17 }));
    expect(s.module.getStats().piecesScattered).toBe(1);
    s.module.update(view({ center: C, zoom: 17 }));
    expect(s.module.getStats().piecesScattered).toBe(0);
  });

  it('replants trees when terrain is toggled (review #4)', async () => {
    const s = setup();
    s.module.update(view({ center: C, zoom: 17 }));
    await flush();
    expect(s.map.queryTerrainElevation).not.toHaveBeenCalled();
    s.map.terrain = { source: 'dem' };
    s.map.handlers.get('terrain')!({});
    expect(s.map.queryTerrainElevation).toHaveBeenCalled();
  });

  it('replants trees when elevation tiles arrive (review #4)', async () => {
    const s = setup();
    s.map.terrain = { source: 'dem' };
    s.module.update(view({ center: C, zoom: 17 }));
    await flush();
    vi.useFakeTimers();
    s.map.queryTerrainElevation.mockClear();
    s.map.handlers.get('sourcedata')!({ sourceId: 'dem' });
    vi.advanceTimersByTime(250);
    expect(s.map.queryTerrainElevation).toHaveBeenCalled();
  });

  it('applies the theme option only on the first add (review #5)', async () => {
    const s = setup({ theme: 'dusk' });
    s.module.onRemove();
    s.module.onAdd(s.ctx);
    await flush();
    expect(s.core.setTheme).toHaveBeenCalledTimes(1);
  });
});
