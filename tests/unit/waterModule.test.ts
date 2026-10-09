import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Scene, type BufferGeometry } from 'three';
import type { ModuleContext } from '../../src/core/LayerModule';
import { THEMES } from '../../src/core/theme';
import { WaterModule } from '../../src/water/WaterModule';
import { view } from './helpers';

const LNG = 2.2945;
const LAT = 48.8584;
const DEG_PER_M = 360 / (2 * Math.PI * 6371008.8);
const M_LNG = DEG_PER_M / Math.cos((LAT * Math.PI) / 180);

/** Closed w × d metre rectangle, south-west corner (east, north) metres from the view centre. */
function rect(east: number, north: number, w: number, d: number) {
  const [x0, y0] = [LNG + east * M_LNG, LAT + north * DEG_PER_M];
  const [x1, y1] = [x0 + w * M_LNG, y0 + d * DEG_PER_M];
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0],
  ];
}
const poly = (rings: number[][][], properties: object) => ({
  geometry: { type: 'Polygon', coordinates: rings },
  properties,
});
const LAKE = { kind: 'water', kind_detail: 'lake' };
const RIVER = { kind: 'water', kind_detail: 'river' };

function fakeMap() {
  const handlers = new Map<string, (e?: unknown) => void>();
  const listeners = new Map<string, ((e?: unknown) => void)[]>();
  const map = {
    handlers,
    polygons: [] as unknown[],
    lines: [] as unknown[],
    source: { type: 'vector', vectorLayerIds: ['water'] } as object | undefined,
    terrain: null as object | null,
    elevation: (_ll: [number, number]) => 0 as number | null,
    // Several listeners per event (the module and its tile feeds); handlers.get(t) calls them all.
    on: vi.fn((t: string, fn: (e?: unknown) => void) => {
      listeners.set(t, [...(listeners.get(t) ?? []), fn]);
      handlers.set(t, (e?: unknown) => [...(listeners.get(t) ?? [])].forEach((f) => f(e)));
    }),
    off: vi.fn((t: string, fn?: (e?: unknown) => void) => {
      const list = (listeners.get(t) ?? []).filter((f) => f !== fn);
      listeners.set(t, list);
      if (!list.length) handlers.delete(t);
    }),
    getSource: (id: string) => (id === 'protomaps' ? map.source : undefined),
    querySourceFeatures: vi.fn((_s: string, o: { filter?: unknown }) =>
      JSON.stringify(o.filter).includes('LineString') ? map.lines : map.polygons,
    ),
    getTerrain: () => map.terrain,
    queryTerrainElevation: vi.fn((ll: [number, number]) => map.elevation(ll)),
  };
  return map;
}

function setup(over: object = {}) {
  const map = fakeMap();
  const scene = new Scene();
  const requestRepaint = vi.fn();
  const onError = vi.fn();
  const module = new WaterModule({ onError, ...over });
  module.onAdd({ map, scene, core: { theme: 'day' }, requestRepaint } as unknown as ModuleContext);
  return { map, scene, module, onError, requestRepaint };
}
const attr = (g: BufferGeometry, name: string) =>
  Array.from(g.getAttribute(name).array as Float32Array);
const ys = (g: BufferGeometry) => attr(g, 'position').filter((_, i) => i % 3 === 1);

/** A tile arriving as MapLibre announces it: its own polygons (and river lines). */
function emitTile(
  map: ReturnType<typeof fakeMap>,
  canonical: { z: number; x: number; y: number },
  polygons: unknown[],
  lines: unknown[] = [],
) {
  map.handlers.get('sourcedata')!({
    sourceId: 'protomaps',
    tile: {
      tileID: { canonical },
      querySourceFeatures: (result: unknown[], params: { filter?: unknown }) =>
        result.push(...(JSON.stringify(params.filter).includes('LineString') ? lines : polygons)),
    },
  });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('WaterModule', () => {
  it('draws water as an opaque body and blended shore ribbons around the view centre', () => {
    const { map, scene, module } = setup();
    map.polygons = [poly([rect(-50, -50, 100, 100)], LAKE)];
    module.update(view());
    const body = module.body!;
    const shore = module.shore!;
    expect(scene.children).toEqual(expect.arrayContaining([body, shore]));
    expect(body.geometry.getAttribute('position').count).toBe(4);
    expect(body.geometry.getIndex()!.count).toBe(6);
    expect(shore.geometry.getAttribute('position').count).toBe(16);
    expect(new Set(attr(body.geometry, 'aStyle'))).toEqual(new Set([1])); // lake
    expect(attr(body.geometry, 'aShore').every((s) => s === 0)).toBe(true);
    expect(body.material).toMatchObject({ transparent: false, depthWrite: false, depthTest: true });
    expect(shore.material).toMatchObject({ transparent: true, depthWrite: false, depthTest: true });
    const xs = attr(body.geometry, 'position').filter((_, i) => i % 3 === 0);
    for (const x of xs) expect(Math.abs(x)).toBeLessThan(50.5);
    expect(module.getStats()).toEqual({ pieces: 1, triangles: 10 });
  });

  it('draws nothing below minZoom', () => {
    const { map, module } = setup();
    map.polygons = [poly([rect(-50, -50, 100, 100)], LAKE)];
    module.update(view({ zoom: 11 }));
    expect(map.querySourceFeatures).not.toHaveBeenCalled();
    expect(module.body!.visible).toBe(false);
  });

  it('reports a missing source or source layer once', () => {
    const { map, module, onError } = setup();
    map.source = undefined;
    module.update(view());
    module.update(view());
    expect(onError).toHaveBeenCalledTimes(1);
    map.source = { type: 'vector', vectorLayerIds: ['roads'] };
    module.update(view());
    expect(onError).toHaveBeenCalledTimes(2);
    expect(String(onError.mock.calls[1]![0])).toContain('water');
  });

  it('keeps the nearest pieces within the triangle budget, a containing sea first', () => {
    const { map, module } = setup({ maxTriangles: 10 });
    map.polygons = [
      poly([rect(2000, 0, 100, 100)], LAKE),
      poly([rect(150, 0, 100, 100)], { kind: 'water', name: 'near' }),
    ];
    module.update(view());
    expect(module.getStats().pieces).toBe(1);
    const xs = attr(module.body!.geometry, 'position').filter((_, i) => i % 3 === 0);
    expect(Math.max(...xs)).toBeLessThan(300);
    map.polygons.push(poly([rect(-5000, -5000, 10000, 10000)], { kind: 'ocean' }));
    module.update(view());
    expect(new Set(attr(module.body!.geometry, 'aStyle'))).toEqual(new Set([0])); // sea only
  });

  it('splits multipolygons into pieces', () => {
    const { map, module } = setup();
    map.polygons = [
      {
        geometry: {
          type: 'MultiPolygon',
          coordinates: [[rect(-50, -50, 40, 40)], [rect(10, 10, 40, 40)]],
        },
        properties: LAKE,
      },
    ];
    module.update(view());
    expect(module.getStats().pieces).toBe(2);
    expect(module.body!.geometry.getAttribute('position').count).toBe(8);
  });

  it('puts no ribbon on a tile cut between two pieces', () => {
    const { map, module } = setup();
    map.polygons = [poly([rect(-100, -50, 100, 100)], LAKE), poly([rect(0, -50, 100, 100)], LAKE)];
    module.update(view());
    expect(module.shore!.geometry.getAttribute('position').count).toBe(24); // 2 × 3 edges
  });

  it('rebuilds (debounced) when its source gets data, not for other sources', () => {
    const { map, module } = setup();
    module.update(view());
    map.querySourceFeatures.mockClear();
    map.handlers.get('sourcedata')!({ sourceId: 'other', sourceDataType: 'content' });
    vi.advanceTimersByTime(200);
    expect(map.querySourceFeatures).not.toHaveBeenCalled();
    map.handlers.get('sourcedata')!({ sourceId: 'protomaps', sourceDataType: 'content' });
    vi.advanceTimersByTime(100);
    expect(map.querySourceFeatures).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60);
    expect(map.querySourceFeatures).toHaveBeenCalled();
  });

  it('terrain: lakes flat above the ground inside them (shared across pieces), rivers follow the ground', () => {
    const { map, module } = setup();
    map.terrain = { source: 'dem' };
    map.elevation = ([lng]) => (lng > LNG ? 120 : 100);
    map.polygons = [poly([rect(-100, -50, 100, 100)], LAKE), poly([rect(0, -50, 100, 100)], LAKE)];
    module.update(view());
    // West piece 100 m, east piece 120 m: one level for the lake, above both.
    for (const y of ys(module.body!.geometry)) expect(y).toBeCloseTo(120.3, 4);
    // A separate lake with the same (unnamed) properties, 0.8 m off the shore (bounds touching),
    // keeps its own level and does not lift the big lake.
    map.elevation = ([lng, lat]) => (lat > LAT + 50.6 * DEG_PER_M ? 900 : lng > LNG ? 120 : 100);
    map.polygons.push(poly([rect(-100, 50.8, 20, 20)], LAKE));
    module.update(view());
    const heights = ys(module.body!.geometry);
    expect(heights.filter((y) => Math.abs(y - 120.3) < 1e-3)).toHaveLength(8);
    expect(heights.filter((y) => Math.abs(y - 900.3) < 1e-3)).toHaveLength(4);
    map.polygons = [poly([rect(-50, -10, 100, 20)], RIVER)];
    module.update(view());
    const pos = attr(module.body!.geometry, 'position');
    for (let i = 0; i < pos.length; i += 3)
      expect(pos[i + 1]).toBeCloseTo(pos[i]! > 0 ? 120.3 : 100.3, 4);
  });

  it('returns to the ground plane when terrain is switched off', () => {
    const { map, module } = setup();
    map.terrain = { source: 'dem' };
    map.elevation = () => 100;
    map.polygons = [poly([rect(-50, -50, 100, 100)], LAKE)];
    module.update(view());
    map.terrain = null;
    map.handlers.get('terrain')!();
    vi.advanceTimersByTime(200);
    for (const y of ys(module.body!.geometry)) expect(y).toBe(0);
  });

  it('gives river vertices the flow of the nearest river line, lakes none', () => {
    const { map, module } = setup();
    map.polygons = [poly([rect(-50, -10, 100, 20)], RIVER), poly([rect(-50, 100, 40, 40)], LAKE)];
    map.lines = [
      {
        geometry: {
          type: 'LineString',
          coordinates: [
            [LNG - 0.001, LAT],
            [LNG + 0.001, LAT],
          ],
        },
        properties: { kind: 'river' },
      },
    ];
    module.update(view());
    const style = attr(module.body!.geometry, 'aStyle');
    const flow = attr(module.body!.geometry, 'aFlow');
    style.forEach((s, i) => {
      if (s === 2) expect([flow[i * 2], flow[i * 2 + 1]]).toEqual([1, 0]);
      else expect([flow[i * 2], flow[i * 2 + 1]]).toEqual([0, 0]);
    });
  });

  it('follows the theme and colour overrides; waves animate only when on', () => {
    const { map, module } = setup({ colors: { lake: '#ff0000' } });
    expect(module.uniforms.uShallow.value[1]!.getHexString()).toBe('ff0000');
    module.themeChanged('night');
    expect(module.uniforms.uSky.value.getHex()).toBe(THEMES.night.sky);
    map.polygons = [poly([rect(-50, -50, 100, 100)], LAKE)];
    module.update(view());
    expect(module.frame(1000)).toBe(true);
    module.setWaves(0);
    expect(module.uniforms.uWaves.value).toBe(0);
    expect(module.frame(1100)).toBe(false);
    module.setWaves(1);
    for (let t = 1100; t < 1100 + 3_000_000; t += 100) module.frame(t);
    expect(module.uniforms.uTime.value).toBeLessThan(2048);
  });

  it('rebuilds after a style swap only while attached', () => {
    const { map, module } = setup();
    module.update(view());
    map.querySourceFeatures.mockClear();
    module.styleChanged(false);
    vi.advanceTimersByTime(200);
    expect(map.querySourceFeatures).not.toHaveBeenCalled();
    module.styleChanged(true);
    vi.advanceTimersByTime(200);
    expect(map.querySourceFeatures).toHaveBeenCalled();
  });

  it('rebuilds thousands of small pools quickly (no all-pairs scans)', () => {
    vi.useRealTimers();
    const { map, module } = setup();
    // 6,400 pools on a 25 m grid, each 8 m square: exactly axis-aligned edges, like MVT pools.
    for (let i = 0; i < 80; i++)
      for (let j = 0; j < 80; j++)
        map.polygons.push(
          poly([rect(i * 25 - 1000, j * 25 - 1000, 8, 8)], { kind: 'swimming_pool' }),
        );
    const t0 = performance.now();
    module.update(view());
    const first = performance.now() - t0;
    const t1 = performance.now();
    module.update(view());
    const again = performance.now() - t1;
    expect(module.getStats().pieces).toBe(6400);
    expect(first).toBeLessThan(1500);
    expect(again).toBeLessThan(500);
  });

  it('builds each tile once: updating reads nothing from the source (tiles arrive by event)', () => {
    const { map, module } = setup();
    module.update(view()); // seeds (nothing loaded yet)
    emitTile(map, { z: 15, x: 1, y: 1 }, [poly([rect(-50, -50, 100, 100)], LAKE)]);
    map.querySourceFeatures.mockClear();
    module.update(view());
    expect(map.querySourceFeatures).not.toHaveBeenCalled();
    expect(module.getStats().pieces).toBe(1);
  });

  it('merges again only when tiles change or the view moves 2 km away', () => {
    const { map, module } = setup();
    module.update(view());
    emitTile(map, { z: 15, x: 1, y: 1 }, [poly([rect(-50, -50, 100, 100)], LAKE)]);
    module.update(view());
    const geometry = () => module.body!.geometry.getAttribute('position');
    const first = geometry();
    module.update(view({ center: [LNG + 0.01, LAT] })); // ~730 m
    expect(geometry()).toBe(first);
    module.update(view({ center: [LNG + 0.03, LAT] })); // ~2.2 km: re-centred
    expect(geometry()).not.toBe(first);
  });

  it('zoomed out below minZoom: holds no tiles and ignores arriving ones', () => {
    const { map, module } = setup();
    module.update(view());
    emitTile(map, { z: 15, x: 1, y: 1 }, [poly([rect(-50, -50, 100, 100)], LAKE)]);
    module.update(view({ zoom: 11 }));
    const query = vi.fn();
    map.handlers.get('sourcedata')!({
      sourceId: 'protomaps',
      tile: { tileID: { canonical: { z: 11, x: 1, y: 1 } }, querySourceFeatures: query },
    });
    expect(query).not.toHaveBeenCalled();
    map.polygons = [poly([rect(-50, -50, 100, 100)], LAKE)];
    module.update(view()); // back in: seeded from what is loaded
    expect(module.getStats().pieces).toBe(1);
  });

  it('keeps a reloaded tile drawn (the same tile object announced again)', () => {
    const { map, module } = setup();
    module.update(view());
    const lake = [poly([rect(-50, -50, 100, 100)], LAKE)];
    const tile = {
      tileID: { canonical: { z: 15, x: 1, y: 1 } },
      querySourceFeatures: (result: unknown[], params: { filter?: unknown }) =>
        result.push(...(JSON.stringify(params.filter).includes('LineString') ? [] : lake)),
    };
    map.handlers.get('sourcedata')!({ sourceId: 'protomaps', tile });
    module.update(view());
    map.handlers.get('sourcedata')!({ sourceId: 'protomaps', tile }); // reload
    module.update(view());
    expect(module.getStats().pieces).toBe(1);
  });

  it('drops the foam on a tile cut once the neighbouring tile arrives', () => {
    const { map, module } = setup();
    module.update(view());
    emitTile(map, { z: 15, x: 1, y: 1 }, [poly([rect(-100, -50, 100, 100)], LAKE)]);
    module.update(view());
    // Alone, the west half's cut edge looks like a shore: 4 ribbons.
    expect(module.shore!.geometry.getAttribute('position').count).toBe(16);
    emitTile(map, { z: 15, x: 2, y: 1 }, [poly([rect(0, -50, 100, 100)], LAKE)]);
    module.update(view());
    expect(module.shore!.geometry.getAttribute('position').count).toBe(24); // 2 × 3 edges
  });

  it('removes its meshes and listeners', () => {
    const { map, scene, module } = setup();
    module.onRemove();
    expect(scene.children).toHaveLength(0);
    expect(map.off).toHaveBeenCalledWith('sourcedata', expect.any(Function));
    expect(map.off).toHaveBeenCalledWith('terrain', expect.any(Function));
  });
});
