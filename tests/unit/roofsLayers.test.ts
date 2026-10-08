import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Scene } from 'three';
import type { ModuleContext } from '../../src/core/LayerModule';
import { RoofsModule } from '../../src/roofs/RoofsModule';
import { ROOF_STATE } from '../../src/roofs/walls';
import { FADE_STATE } from '../../src/landmarks/replacement';
import { notifyExemptionsChanged } from '../../src/labels/exemptions';
import { view } from './helpers';

const DEG_PER_M = 360 / (2 * Math.PI * 6371008.8);
const M_LNG = DEG_PER_M / Math.cos((48.8584 * Math.PI) / 180);

/** w × d metre rectangle, south-west corner (east, north) metres from the view centre. */
function rectAt(east: number, north: number, w: number, d: number) {
  const [lng, lat] = [2.2945 + east * M_LNG, 48.8584 + north * DEG_PER_M];
  const [e, n] = [lng + w * M_LNG, lat + d * DEG_PER_M];
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
const gabled = (id: number, east: number) => ({
  id,
  geometry: { type: 'Polygon', coordinates: rectAt(east, 0, 10, 20) },
  properties: { height: 12, roof_shape: 'gabled', roof_height: 3 },
});

/** Overture's official tiles: buildings and building parts in separate source layers. */
function fakeMap() {
  const handlers = new Map<string, (e?: unknown) => void>();
  const layers: Record<
    string,
    { id: string; sourceLayer: string; paint: Record<string, unknown> }
  > = {
    walls: {
      id: 'walls',
      sourceLayer: 'building',
      paint: { 'fill-extrusion-height': ['get', 'height'] },
    },
    'part-walls': {
      id: 'part-walls',
      sourceLayer: 'building_part',
      paint: { 'fill-extrusion-height': ['get', 'height'] },
    },
  };
  const states = new Map<string, Record<string, unknown>>();
  const features: Record<string, ReturnType<typeof gabled>[]> = { building: [], building_part: [] };
  const map = {
    handlers,
    layers,
    states,
    features,
    on: vi.fn((t: string, fn: (e?: unknown) => void) => handlers.set(t, fn)),
    off: vi.fn((t: string) => handlers.delete(t)),
    getSource: (id: string) =>
      id === 'overture' ? { vectorLayerIds: ['building', 'building_part'] } : undefined,
    querySourceFeatures: vi.fn(
      (_s: string, o: { sourceLayer?: string }) => features[o.sourceLayer ?? ''] ?? [],
    ),
    getLayer: (id: string) => layers[id],
    getPaintProperty: (id: string, p: string) => layers[id]?.paint[p],
    setPaintProperty: vi.fn((id: string, p: string, v: unknown) => (layers[id]!.paint[p] = v)),
    setFeatureState: vi.fn((f: { sourceLayer?: string; id: unknown }, s: Record<string, unknown>) =>
      states.set(`${f.sourceLayer}:${f.id}`, { ...states.get(`${f.sourceLayer}:${f.id}`), ...s }),
    ),
    removeFeatureState: vi.fn((f: { sourceLayer?: string; id: unknown }) =>
      states.delete(`${f.sourceLayer}:${f.id}`),
    ),
    getFeatureState: (f: { sourceLayer?: string; id: unknown }) =>
      states.get(`${f.sourceLayer}:${f.id}`) ?? {},
    getTerrain: () => null,
    queryTerrainElevation: () => 0,
  };
  return map;
}

function setup(extrusionLayer: string | string[] = ['walls', 'part-walls']) {
  const map = fakeMap();
  const onError = vi.fn();
  const module = new RoofsModule({ source: 'overture', extrusionLayer, onError });
  module.onAdd({
    map,
    scene: new Scene(),
    core: {},
    requestRepaint: vi.fn(),
  } as unknown as ModuleContext);
  return { map, module, onError };
}
const wrapped = (v: unknown) => JSON.stringify(v).includes(ROOF_STATE);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('RoofsModule with several extrusion layers (buildings + building parts)', () => {
  it('reads each wall layer’s own source layer and draws roofs from both', () => {
    const { map, module } = setup();
    map.features.building = [gabled(1, 0)];
    map.features.building_part = [gabled(2, 30)];
    module.update(view({ zoom: 16 }));
    const layersQueried = map.querySourceFeatures.mock.calls.map((c) => c[1]?.sourceLayer).sort();
    expect(layersQueried).toEqual(['building', 'building_part']);
    expect(module.getStats().buildings).toBe(2);
    expect(map.states.get('building:1')?.[ROOF_STATE]).toBe(3);
    expect(map.states.get('building_part:2')?.[ROOF_STATE]).toBe(3);
  });

  it('shortens the walls of every extrusion layer', () => {
    const { map, module } = setup();
    module.update(view({ zoom: 16 }));
    expect(wrapped(map.layers.walls!.paint['fill-extrusion-height'])).toBe(true);
    expect(wrapped(map.layers['part-walls']!.paint['fill-extrusion-height'])).toBe(true);
    module.onRemove();
    expect(map.layers.walls!.paint['fill-extrusion-height']).toEqual(['get', 'height']);
    expect(map.layers['part-walls']!.paint['fill-extrusion-height']).toEqual(['get', 'height']);
  });

  it('keeps a building and a part with the same id apart', () => {
    const { map, module } = setup();
    map.features.building = [gabled(7, 0)];
    map.features.building_part = [gabled(7, 30)];
    module.update(view({ zoom: 16 }));
    expect(module.getStats().buildings).toBe(2);
    expect(map.states.has('building:7')).toBe(true);
    expect(map.states.has('building_part:7')).toBe(true);
    map.features.building = [];
    module.update(view({ zoom: 16 }));
    expect(map.states.has('building:7')).toBe(false);
    expect(map.states.has('building_part:7')).toBe(true);
  });

  it('reports a missing wall layer once and still draws the other layer’s roofs', () => {
    const { map, module, onError } = setup(['walls', 'missing-walls']);
    map.features.building = [gabled(1, 0)];
    module.update(view({ zoom: 16 }));
    module.update(view({ zoom: 16 }));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0]![0])).toContain('missing-walls');
    expect(module.getStats().buildings).toBe(1);
  });

  it('does not touch feature-state of a source the style no longer has', () => {
    const { map, module } = setup();
    map.features.building = [gabled(1, 0)];
    module.update(view({ zoom: 16 }));
    // A style swap removed the source (MapLibre reports an error event per call, it does not throw).
    map.getSource = () => undefined;
    module.styleChanged(true);
    module.onRemove();
    expect(map.removeFeatureState).not.toHaveBeenCalled();
  });

  it('leaves alone feature-state it no longer owns (a swap replaced the source)', () => {
    const { map, module } = setup();
    map.features.building = [gabled(1, 0)];
    module.update(view({ zoom: 16 }));
    // The new source has an empty feature-state store; removing a key there breaks MapLibre's
    // next render (it deletes from a missing state object).
    map.states.clear();
    module.styleChanged(true);
    expect(map.removeFeatureState).not.toHaveBeenCalled();
  });

  it('draws no roof on buildings a landmark model replaces, and brings it back after', () => {
    const { map, module } = setup();
    map.features.building = [gabled(1, 0), gabled(2, 30)];
    // The landmark replacement hides walls with this state; roofs must hide with them.
    map.states.set('building:1', { [FADE_STATE]: 1 });
    module.update(view({ zoom: 16 }));
    expect(module.getStats().buildings).toBe(1);
    expect(map.states.get('building:1')?.[ROOF_STATE]).toBeUndefined();
    expect(map.states.get('building:2')?.[ROOF_STATE]).toBe(3);
    // The model leaves: the replacement clears its state and notifies.
    map.states.delete('building:1');
    notifyExemptionsChanged(map);
    vi.advanceTimersByTime(200);
    expect(module.getStats().buildings).toBe(2);
  });

  it('still accepts a single extrusion layer name', () => {
    const { map, module } = setup('part-walls');
    map.features.building_part = [gabled(2, 0)];
    module.update(view({ zoom: 16 }));
    expect(module.getStats().buildings).toBe(1);
    expect(map.states.get('building_part:2')?.[ROOF_STATE]).toBe(3);
  });
});
