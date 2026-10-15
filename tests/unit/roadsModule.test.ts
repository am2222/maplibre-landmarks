import { afterEach, describe, expect, it, vi } from 'vitest';
import { Scene, type BufferGeometry, type Mesh } from 'three';
import { RoadsModule, type RoadsOptions } from '../../src/roads/RoadsModule';
import { LEVEL_M } from '../../src/roads/geometry';
import type { ModuleContext } from '../../src/core/LayerModule';
import { view } from './helpers';

const C: [number, number] = [-75.7135, 45.4205];
const M = 111_320;
const KX = M * Math.cos((C[1] * Math.PI) / 180);
const at = (east: number, north = 0): [number, number] => [C[0] + east / KX, C[1] + north / M];
const segment = (id: string, from: number, to: number, props: object = {}) => ({
  properties: {
    id,
    subtype: 'road',
    class: 'primary',
    road_flags: '[{"values":["is_bridge"]}]',
    ...props,
  },
  geometry: { type: 'LineString', coordinates: [at(from), at(to)] },
});

function setup(over: Partial<RoadsOptions> = {}, features: unknown[] = []) {
  const layout = new Map<string, unknown>([['roads_bridges_major', undefined]]);
  const map = {
    features,
    layout,
    getSource: (id: string) => (id === 'transport' ? { type: 'vector' } : undefined),
    getTerrain: (): { source: string } | null => null,
    queryTerrainElevation: (): number | null => 0,
    querySourceFeatures: vi.fn(() => map.features),
    getLayer: (id: string) => (layout.has(id) ? { id } : undefined),
    getLayoutProperty: (id: string) => layout.get(id),
    setLayoutProperty: vi.fn((id: string, _p: string, v: unknown) => layout.set(id, v)),
    on: vi.fn(),
    off: vi.fn(),
  };
  const scene = new Scene();
  const module = new RoadsModule({ source: 'transport', onError: vi.fn(), ...over });
  module.onAdd({ map, scene, core: {}, requestRepaint: vi.fn() } as unknown as ModuleContext);
  return { map, scene, module };
}

const deck = (scene: Scene) => scene.getObjectByName('raised-roads') as Mesh<BufferGeometry>;

afterEach(() => vi.useRealTimers());

describe('RoadsModule', () => {
  it('draws one deck for a bridge mapped as two segments, a full level up', () => {
    const { scene, module } = setup({}, [segment('a', 0, 150), segment('b', 150, 300)]);
    module.update(view({ center: C, zoom: 16 }));
    expect(module.getStats()).toMatchObject({ bridges: 1 });
    expect(module.getStats().highest).toBeCloseTo(LEVEL_M, 1);
    expect(deck(scene).geometry.getAttribute('position').count).toBeGreaterThan(0);
  });

  it('ramps the roads leading onto a bridge up to it', () => {
    const { module } = setup({}, [
      segment('bridge', 0, 200),
      segment('west', -150, 0, { road_flags: undefined }),
      segment('east', 200, 350, { road_flags: undefined }),
    ]);
    module.update(view({ center: C, zoom: 16 }));
    expect(module.getStats()).toMatchObject({ bridges: 1, approaches: 2 });
    expect(module.getStats().highest).toBeCloseTo(LEVEL_M, 1);
  });

  it('asks for all road segments (bridges and the roads around them)', () => {
    const { map, module } = setup({ rail: false }, []);
    module.update(view({ center: C, zoom: 16 }));
    const calls = map.querySourceFeatures.mock.calls as unknown as [
      string,
      { sourceLayer: string; filter?: unknown[] },
    ][];
    const layers = calls.map(([, o]) => o.sourceLayer);
    expect(new Set(layers)).toEqual(new Set(['segment', 'connector']));
    const options = calls.find(([, o]) => o.sourceLayer === 'segment')![1];
    expect(options.filter).toEqual(['in', ['get', 'subtype'], ['literal', ['road']]]);
  });

  it('hides the replaced flat bridge layers while on, and gives them back', () => {
    const { map, module } = setup({ replaceLayers: ['roads_bridges_major', 'missing'] });
    expect(map.layout.get('roads_bridges_major')).toBe('none');
    module.onRemove();
    expect(map.layout.get('roads_bridges_major')).toBe('visible');
  });

  it('draws nothing below minZoom', () => {
    const { scene, module } = setup({}, [segment('a', 0, 300)]);
    module.update(view({ center: C, zoom: 14 }));
    expect(module.getStats().bridges).toBe(0);
    expect(deck(scene).geometry.getAttribute('position')).toBeUndefined();
  });
});
