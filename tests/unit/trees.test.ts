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
  data?: { points?: unknown[]; polygons?: unknown[] },
) {
  const features = {
    points: data?.points ?? [point(1, at(10, 0)), point(2, at(-20, 5)), point(3, at(400, 0))],
    polygons: data?.polygons ?? [],
  };
  const handlers = new Map<string, (e: unknown) => void>();
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
    querySourceFeatures: vi.fn((_s: string, o: { filter: unknown[] }) =>
      o.filter[0] === '==' ? features.points : features.polygons,
    ),
    on: vi.fn((t: string, fn: (e: unknown) => void) => handlers.set(t, fn)),
    off: vi.fn((t: string) => handlers.delete(t)),
  };
  const scene = new Scene();
  const core = { theme: 'day', setTheme: vi.fn() };
  const requestRepaint = vi.fn();
  const onError = vi.fn();
  const module = new TreesModule({ source: 'src', models: [box], minZoom: 15, onError, ...over });
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
    // A low camera sees woods out to the horizon: 3,000 woods over ~10 km, one park near the centre.
    const parks = Array.from({ length: 3000 }, (_, i) =>
      polygon(10 + i, 'wood', square(400 + (i % 60) * 160, -4000 + Math.floor(i / 60) * 160, 120)),
    );
    const s = setup(
      { maxTrees: 4000 },
      { points: [], polygons: [polygon(1, 'park', square(0, 0, 300)), ...parks] },
    );
    await flush();
    const wide = view({ center: C, zoom: 17, pitch: 85, bounds: [2.2, 48.8, 2.45, 48.95] });
    const t0 = performance.now();
    s.module.update(wide);
    const ms = performance.now() - t0;
    const stats = s.module.getStats();
    expect(stats.drawn).toBe(4000);
    // Every drawn tree is as near as the nearest 4,000 of all scattered: far parks were skipped,
    // not dropped from the answer.
    expect(ms).toBeLessThan(process.env.CI ? 1500 : 300);
  });

  it('counts mapped trees inside a polygon again only when its pieces or the trees change', async () => {
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
    expect(count.mock.calls.length).toBe(first); // nothing changed: cached
    s.map.features.points = [point(1, at(80, 0)), point(3, at(-900, 0))];
    s.module.update(view({ center: C, zoom: 17 }));
    expect(count.mock.calls.length).toBe(first); // a tree far from the park: still cached
    s.map.features.points = [point(1, at(80, 0)), point(3, at(-900, 0)), point(2, at(95, 5))];
    s.module.update(view({ center: C, zoom: 17 }));
    expect(count.mock.calls.length).toBe(first + 1); // a mapped tree arrived in the park: recount
    count.mockRestore();
  });

  it('starts at zoom 14 (with the 3D buildings), thinning scattered trees until zoom 16', async () => {
    const park = polygon(1, 'park', square(0, 0, 600));
    const s = setup({ minZoom: undefined }, { points: [point(1, at(10, 0))], polygons: [park] });
    await flush();
    const keysAt = (zoom: number) => {
      s.module.update(view({ center: C, zoom, bounds: [2.28, 48.85, 2.31, 48.87] }));
      return s.module.getStats().scattered;
    };
    const full = keysAt(16.5);
    const quarter = keysAt(14);
    const half = keysAt(15);
    expect(full).toBeGreaterThan(400);
    expect(quarter / full).toBeGreaterThan(0.18);
    expect(quarter / full).toBeLessThan(0.32);
    expect(half / full).toBeGreaterThan(0.4);
    expect(half / full).toBeLessThan(0.6);
    expect(s.module.getStats().mapped).toBe(1); // real (mapped) trees are always kept
    s.module.update(view({ center: C, zoom: 13.9 }));
    expect(s.module.getStats().drawn).toBe(0);
  });

  it('thins to a fixed subset: zooming in only adds trees', async () => {
    const s = setup({}, { points: [], polygons: [polygon(1, 'park', square(0, 0, 600))] });
    await flush();
    const drawnKeys = (zoom: number) => {
      s.module.update(view({ center: C, zoom, bounds: [2.28, 48.85, 2.31, 48.87] }));
      return new Set(s.module.drawnKeys());
    };
    const low = drawnKeys(14.5);
    const high = drawnKeys(16);
    for (const key of low) expect(high.has(key)).toBe(true);
  });

  it('grows trees out of the ground over the zoom after minZoom, like the buildings', async () => {
    const s = setup({ minZoom: 14 });
    await flush();
    const grow = () => uniformsOf(s.scene).uGrow.value;
    const origin = originAt(C);
    for (const [zoom, expected] of [
      [14, 0],
      [14.5, 0.5],
      [15, 1],
      [17, 1],
    ] as const) {
      s.map.zoom = zoom;
      s.module.place(origin);
      expect(grow()).toBeCloseTo(expected, 6);
    }
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
