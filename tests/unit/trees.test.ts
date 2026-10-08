import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Color, Group, Scene } from 'three';
import type { ModuleContext } from '../../src/core/LayerModule';
import { localPosition, originAt } from '../../src/core/mercator';
import { THEMES } from '../../src/core/theme';
import type { TreeModel } from '../../src/trees/models/types';
import { TreesModule, type TreesOptions } from '../../src/trees/TreesModule';
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
