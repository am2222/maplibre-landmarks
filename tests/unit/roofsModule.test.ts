import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Scene, type Mesh, type BufferGeometry } from 'three';
import type { ModuleContext } from '../../src/core/LayerModule';
import { setExemptionSource } from '../../src/labels/exemptions';
import { RoofsModule } from '../../src/roofs/RoofsModule';
import { ROOF_STATE } from '../../src/roofs/walls';
import { view } from './helpers';

const TAN_30 = Math.tan(Math.PI / 6);
// Degrees per metre in the mercator metres `localPosition` uses (exact near the view centre).
const DEG_PER_M = 360 / (2 * Math.PI * 6371008.8);
const M_LNG = DEG_PER_M / Math.cos((48.8584 * Math.PI) / 180);
const M_LAT = DEG_PER_M;

/** w × d metre rectangle whose south-west corner is (east, north) metres from the view centre. */
function rectAt(east: number, north: number, w: number, d: number) {
  const [lng, lat] = [2.2945 + east * M_LNG, 48.8584 + north * M_LAT];
  const [e, n] = [lng + w * M_LNG, lat + d * M_LAT];
  return [
    [
      [lng, lat],
      [e, lat],
      [e, n],
      [lng, n],
      [lng, lat],
    ],
  ];
}
const feature = (id: number | undefined, coordinates: number[][][], properties: object) => ({
  id,
  geometry: { type: 'Polygon', coordinates },
  properties,
});

function fakeMap() {
  const handlers = new Map<string, (e?: unknown) => void>();
  const listeners = new Map<string, ((e?: unknown) => void)[]>();
  const paint: Record<string, unknown> = { 'fill-extrusion-height': ['get', 'height'] };
  const states = new Map<unknown, Record<string, unknown>>();
  let layer = true;
  const map = {
    handlers,
    paint,
    states,
    features: [] as ReturnType<typeof feature>[],
    setLayer: (on: boolean) => (layer = on),
    terrain: null as object | null,
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
    vectorLayerIds: undefined as string[] | undefined,
    getSource: (id: string) => (id === 'b' ? { vectorLayerIds: map.vectorLayerIds } : undefined),
    querySourceFeatures: vi.fn((_s: string, _o?: object) => map.features),
    getLayer: (id: string) => (id === 'b3d' && layer ? { id } : undefined),
    getPaintProperty: (_id: string, p: string) => paint[p],
    setPaintProperty: vi.fn((_id: string, p: string, v: unknown) => (paint[p] = v)),
    setFeatureState: vi.fn((f: { id: unknown }, s: Record<string, unknown>) =>
      states.set(f.id, { ...states.get(f.id), ...s }),
    ),
    removeFeatureState: vi.fn((f: { id: unknown }) => states.delete(f.id)),
    getFeatureState: (f: { id: unknown }) => states.get(f.id) ?? {},
    getTerrain: () => map.terrain,
    queryTerrainElevation: vi.fn((ll: [number, number]) => (ll[0] > 2.2946 ? 10 : 0)),
  };
  return map;
}

function setup(over: object = {}) {
  const map = fakeMap();
  const scene = new Scene();
  const requestRepaint = vi.fn();
  const onError = vi.fn();
  const module = new RoofsModule({ source: 'b', extrusionLayer: 'b3d', onError, ...over });
  module.onAdd({ map, scene, core: {}, requestRepaint } as unknown as ModuleContext);
  return { map, scene, module, onError, requestRepaint };
}
const roofMesh = (scene: Scene) => scene.children[0] as Mesh<BufferGeometry>;
const stateOf = (m: ReturnType<typeof fakeMap>, id: number) =>
  m.states.get(id)?.[ROOF_STATE] as number | undefined;

/**
 * MapLibre's tile manager for source 'b': the tiles it renders now, each answering for its own
 * features (as `tile.querySourceFeatures` does).
 */
function renderTiles(map: ReturnType<typeof fakeMap>, tiles: Record<string, unknown[]>) {
  const list = Object.entries(tiles).map(([key, features]) => {
    const [z, x, y] = key.split('/').map(Number);
    return {
      tileID: { canonical: { z, x, y } },
      querySourceFeatures: vi.fn((result: unknown[]) => result.push(...features)),
    };
  });
  // One manager per source (MapLibre keeps it while the source lives): only its tiles change.
  const style = ((map as { style?: { tileManagers: Record<string, object> } }).style ??= {
    tileManagers: {},
  });
  style.tileManagers.b = Object.assign(style.tileManagers.b ?? {}, {
    getRenderableIds: () => list.map((_, i) => i),
    getTileByID: (i: number) => list[i],
  });
  return list;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('RoofsModule', () => {
  it('roofs tagged buildings, writes their roof height and shortens their walls', () => {
    const { map, scene, module } = setup();
    map.features = [
      feature(1, rectAt(0, 0, 40, 20), { height: 20, roof_shape: 'gabled' }),
      feature(2, rectAt(100, 0, 10, 10), { height: 20 }),
    ];
    module.update(view());
    expect(stateOf(map, 1)).toBeCloseTo(10 * TAN_30, 1);
    expect(map.states.has(2)).toBe(false);
    expect(map.paint['fill-extrusion-height']).toEqual([
      'max',
      0,
      ['-', ['get', 'height'], ['coalesce', ['feature-state', ROOF_STATE], 0]],
    ]);
    expect(module.getStats().buildings).toBe(1);
    expect(roofMesh(scene).geometry.getAttribute('position').count).toBeGreaterThan(0);
  });

  it('merges tile pieces before sizing the roof', () => {
    const { map, module } = setup();
    // 40 × 30 m building cut in two 20 × 30 m pieces (overlapping slightly, like tile buffers).
    map.features = [
      feature(1, rectAt(0, 0, 20.5, 30), { height: 30, roof_shape: 'gabled' }),
      feature(1, rectAt(19.5, 0, 20.5, 30), { height: 30, roof_shape: 'gabled' }),
    ];
    module.update(view());
    expect(stateOf(map, 1)).toBeCloseTo(15 * TAN_30, 1); // whole: W = 15; a piece alone: W = 10
  });

  it('skips outlines with parts and buildings under a landmark', () => {
    const { map, module } = setup();
    map.features = [
      feature(1, rectAt(0, 0, 20, 20), { height: 20, roof_shape: 'hipped', has_parts: true }),
      feature(2, rectAt(200, 0, 20, 20), { height: 20, roof_shape: 'hipped' }),
    ];
    const [lng, lat] = [2.2945 + 210 * M_LNG, 48.8584 + 10 * M_LAT];
    setExemptionSource(map, 'landmarks', () => [
      [
        [
          [lng - 0.001, lat - 0.001],
          [lng + 0.001, lat - 0.001],
          [lng + 0.001, lat + 0.001],
          [lng - 0.001, lat + 0.001],
          [lng - 0.001, lat - 0.001],
        ],
      ],
    ]);
    module.update(view());
    expect(module.getStats().buildings).toBe(0);
    setExemptionSource(map, 'landmarks', null);
    vi.advanceTimersByTime(200); // exemption change → rebuild
    expect(module.getStats().buildings).toBe(1);
  });

  it('puts the roof back in the same frame a landmark lets its building go', () => {
    const { map, module } = setup();
    map.features = [feature(1, rectAt(0, 0, 20, 20), { height: 20, roof_shape: 'hipped' })];
    const [lng, lat] = [2.2945 + 10 * M_LNG, 48.8584 + 10 * M_LAT];
    const d = 0.001;
    const around = [
      [lng - d, lat - d],
      [lng + d, lat - d],
      [lng + d, lat + d],
      [lng - d, lat + d],
      [lng - d, lat - d],
    ];
    setExemptionSource(map, 'landmarks', () => [[around]]);
    module.update(view());
    expect(module.getStats().buildings).toBe(0);
    setExemptionSource(map, 'landmarks', null); // landmark layer turned off
    // No debounce: the wall would show at full height until the roof comes back.
    expect(module.getStats().buildings).toBe(1);
    expect(stateOf(map, 1)).toBeGreaterThan(0);
  });

  it('pitched: roofs no building beyond the far cutoff, nor reads its tile', () => {
    const { map, module } = setup();
    const far = renderTiles(map, {
      '15/16592/11272': [feature(1, rectAt(0, 0, 20, 20), { height: 20, roof_shape: 'dome' })],
      '15/16610/11272': [feature(2, rectAt(2000, 0, 20, 20), { height: 20, roof_shape: 'dome' })],
    })[1]!;
    module.update(view({ zoom: 17, pitch: 70, heightPx: 900 })); // cutoff ~1.06 km
    expect(map.states.has(2)).toBe(false);
    expect(far.querySourceFeatures).not.toHaveBeenCalled();
    expect(stateOf(map, 1)).toBeGreaterThan(0);
    module.update(view({ zoom: 17, pitch: 30, heightPx: 900 }));
    expect(stateOf(map, 2)).toBeGreaterThan(0);
  });

  it('roofs past the cutoff when farCutoff is off', () => {
    const { map, module } = setup({ farCutoff: false });
    map.features = [feature(2, rectAt(2000, 0, 20, 20), { height: 20, roof_shape: 'dome' })];
    module.update(view({ zoom: 17, pitch: 70, heightPx: 900 }));
    expect(stateOf(map, 2)).toBeGreaterThan(0);
  });

  it('gables a side-hipped wing at the end where it meets another part', () => {
    const { map, scene, module } = setup();
    map.features = [
      // 20 × 10 m wing, roof 16–20 m, touching a lower building at its east end.
      feature(1, rectAt(0, 0, 20, 10), { height: 20, roof_shape: 'side_hipped', roof_height: 4 }),
      feature(2, rectAt(20, 0, 10, 10), { height: 10, roof_shape: 'pyramidal' }),
    ];
    module.update(view());
    const p = Array.from(roofMesh(scene).geometry.getAttribute('position').array);
    // Ridge points of the wing (the only vertices at 20 m), east-west extent in metres.
    const ridge = p.filter((_, i) => i % 3 === 0 && Math.abs(p[i + 1]! - 20) < 1e-3);
    const span = Math.max(...ridge) - Math.min(...ridge);
    expect(span).toBeCloseTo(15, 1); // hipped west (5 m in), gabled east (to the wall)
  });

  it('draws only the nearest maxBuildings', () => {
    const { map, module } = setup({ maxBuildings: 1 });
    map.features = [
      feature(1, rectAt(300, 0, 20, 20), { height: 20, roof_shape: 'pyramidal' }),
      feature(2, rectAt(10, 0, 20, 20), { height: 20, roof_shape: 'pyramidal' }),
    ];
    module.update(view());
    expect(map.states.has(1)).toBe(false);
    expect(stateOf(map, 2)).toBeGreaterThan(0);
  });

  it('rebuilds when its source tiles arrive, without a camera move', () => {
    const { map, module } = setup();
    module.update(view());
    expect(module.getStats().buildings).toBe(0);
    map.features = [feature(1, rectAt(0, 0, 20, 20), { height: 20, roof_shape: 'dome' })];
    map.handlers.get('sourcedata')!({ sourceId: 'other' });
    vi.advanceTimersByTime(200);
    expect(module.getStats().buildings).toBe(0);
    map.handlers.get('sourcedata')!({ sourceId: 'b' });
    vi.advanceTimersByTime(200);
    expect(module.getStats().buildings).toBe(1);
  });

  it('builds a split building from the tiles holding it, as each tile comes and goes', () => {
    const { map, module } = setup();
    // 40 × 30 m building cut in two pieces, one per tile.
    const west = feature(1, rectAt(0, 0, 20.5, 30), { height: 30, roof_shape: 'gabled' });
    const east = feature(1, rectAt(19.5, 0, 20.5, 30), { height: 30, roof_shape: 'gabled' });
    renderTiles(map, { '15/16592/11272': [west] });
    module.update(view());
    expect(stateOf(map, 1)).toBeCloseTo(10.25 * TAN_30, 1); // the west piece alone (20.5 m)
    renderTiles(map, { '15/16592/11272': [west], '15/16593/11272': [east] });
    module.update(view());
    expect(stateOf(map, 1)).toBeCloseTo(15 * TAN_30, 1); // whole: W = 15
    renderTiles(map, { '15/16593/11272': [east] });
    module.update(view());
    expect(stateOf(map, 1)).toBeCloseTo(10.25 * TAN_30, 1); // the east piece alone
    renderTiles(map, {});
    module.update(view());
    expect(map.states.has(1)).toBe(false);
    expect(module.getStats().buildings).toBe(0);
    expect(map.querySourceFeatures).not.toHaveBeenCalled();
  });

  it('keeps a reloaded tile roofed, with its new data', () => {
    const { map, module } = setup();
    const [tile] = renderTiles(map, {
      '15/16592/11272': [feature(1, rectAt(0, 0, 20, 20), { height: 20, roof_shape: 'dome' })],
    });
    module.update(view());
    tile!.querySourceFeatures.mockImplementation((result: unknown[]) =>
      result.push(
        feature(1, rectAt(0, 0, 20, 20), { height: 20, roof_shape: 'dome' }),
        feature(2, rectAt(100, 0, 20, 20), { height: 20, roof_shape: 'dome' }),
      ),
    );
    map.handlers.get('sourcedata')!({ sourceId: 'b', tile }); // reload
    module.update(view());
    expect(module.getStats().buildings).toBe(2);
  });

  it('reads each tile once: updating again queries no tile', () => {
    const { map, module } = setup();
    const [tile] = renderTiles(map, {
      '15/16592/11272': [feature(1, rectAt(0, 0, 20, 20), { height: 20, roof_shape: 'dome' })],
    });
    module.update(view());
    module.update(view({ center: [2.2946, 48.8585] }));
    expect(tile!.querySourceFeatures).toHaveBeenCalledTimes(1);
    expect(module.getStats().buildings).toBe(1);
  });

  it('holds no tiles while zoomed out below minZoom', () => {
    const { map, module } = setup();
    const [tile] = renderTiles(map, {
      '15/16592/11272': [feature(1, rectAt(0, 0, 20, 20), { height: 20, roof_shape: 'dome' })],
    });
    module.update(view());
    module.update(view({ zoom: 13 }));
    expect(module.getStats().buildings).toBe(0);
    expect(map.states.has(1)).toBe(false);
    module.update(view());
    expect(tile!.querySourceFeatures).toHaveBeenCalledTimes(2); // re-read on the way back in
    expect(module.getStats().buildings).toBe(1);
  });

  it('reports a missing extrusion layer once and wraps it once it appears', () => {
    const { map, module, onError } = setup();
    map.setLayer(false);
    map.paint['fill-extrusion-height'] = ['get', 'height'];
    module.styleChanged(true);
    module.update(view());
    module.update(view());
    expect(onError).toHaveBeenCalledTimes(1);
    map.setLayer(true);
    module.update(view());
    expect(map.paint['fill-extrusion-height']).toEqual([
      'max',
      0,
      ['-', ['get', 'height'], ['coalesce', ['feature-state', ROOF_STATE], 0]],
    ]);
  });

  it('reports buildings without ids once', () => {
    const { map, module, onError } = setup();
    map.features = [feature(undefined, rectAt(0, 0, 20, 20), { height: 20, roof_shape: 'dome' })];
    module.update(view());
    module.update(view());
    expect(onError).toHaveBeenCalledTimes(1);
    expect(module.getStats().buildings).toBe(0);
  });

  it('bakes terrain height differences into the batch', () => {
    const { map, scene, module } = setup();
    map.terrain = {};
    map.features = [
      feature(1, rectAt(0, 0, 10, 10), { height: 10, roof_shape: 'pyramidal', roof_height: 2 }),
      feature(2, rectAt(100, 0, 10, 10), { height: 10, roof_shape: 'pyramidal', roof_height: 2 }),
    ];
    module.update(view());
    const ys = Array.from(roofMesh(scene).geometry.getAttribute('position').array).filter(
      (_, i) => i % 3 === 1,
    );
    // Building 1 sits at ground 0 (walls to 8, apex 10); building 2 at ground 10 (apex 20).
    expect(Math.min(...ys)).toBeCloseTo(8, 6);
    expect(Math.max(...ys)).toBeCloseTo(20, 6);
  });

  it('removal clears feature-state, restores the walls and frees the mesh', () => {
    const { map, scene, module } = setup();
    map.features = [feature(1, rectAt(0, 0, 20, 20), { height: 20, roof_shape: 'dome' })];
    module.update(view());
    module.onRemove();
    expect(map.states.size).toBe(0);
    expect(map.paint['fill-extrusion-height']).toEqual(['get', 'height']);
    expect(scene.children).toHaveLength(0);
    expect(map.handlers.size).toBe(0);
  });

  it('draws no roofs when the wall height cannot be wrapped (legacy function)', () => {
    const map0 = fakeMap();
    map0.paint['fill-extrusion-height'] = { stops: [[15, 0]] };
    const scene = new Scene();
    const onError = vi.fn();
    const module = new RoofsModule({ source: 'b', extrusionLayer: 'b3d', onError });
    module.onAdd({
      map: map0,
      scene,
      core: {},
      requestRepaint: vi.fn(),
    } as unknown as ModuleContext);
    map0.features = [feature(1, rectAt(0, 0, 20, 20), { height: 20, roof_shape: 'dome' })];
    module.update(view());
    expect(module.getStats().buildings).toBe(0);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('colours walls from facade attributes when asked', () => {
    const { map } = setup({ wallColors: true });
    const color = map.paint['fill-extrusion-color'] as unknown[];
    expect(color[0]).toBe('let');
    expect(JSON.stringify(color[2])).toContain('["get","facade_color"]');
  });

  it('asks MapLibre for roofed buildings only', () => {
    const { map, module } = setup();
    module.update(view());
    const [, options] = map.querySourceFeatures.mock.calls[0] as unknown as [
      string,
      { filter?: unknown[] },
    ];
    expect(JSON.stringify(options.filter)).toContain('roof_shape');
    expect(JSON.stringify(options.filter)).toContain('double_saltbox');
  });

  it('reports a source layer the source does not have', () => {
    const { map, module, onError } = setup({ sourceLayer: 'buildings' });
    map.vectorLayerIds = ['building'];
    module.update(view());
    module.update(view());
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0]![0])).toContain('buildings');
  });
});
