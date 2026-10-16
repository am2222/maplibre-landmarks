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
    querySourceFeatures: vi.fn(
      (_s: string, _o?: { sourceLayer?: string }): unknown[] => map.features,
    ),
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

  it('warns once when the source tiles are sliced past their last zoom', () => {
    const onError = vi.fn();
    const { map, module } = setup({ onError }, [
      { ...segment('a', 0, 300), tile: { z: 16, x: 18970, y: 23452 } },
    ]);
    map.getSource = (id: string) =>
      id === 'transport' ? { type: 'vector', maxzoom: 14 } : undefined;
    module.update(view({ center: C, zoom: 16 }));
    module.update(view({ center: C, zoom: 16.5 }));
    const sliced = onError.mock.calls.filter(([e]) => String(e).includes('sliced past zoom 14'));
    expect(sliced).toHaveLength(1);
  });

  it('keeps placing a bridge from a tile that has left the view', () => {
    // A 400 m segment across the edge between two zoom-15 tiles, bridged from 200 to 300 m.
    const z = 15;
    const x = Math.floor(((C[0] + 180) / 360) * 2 ** z) + 1;
    const edge = (x / 2 ** z) * 360 - 180;
    const y = Math.floor(
      ((1 -
        Math.log(Math.tan((C[1] * Math.PI) / 180) + 1 / Math.cos((C[1] * Math.PI) / 180)) /
          Math.PI) /
        2) *
        2 ** z,
    );
    const east = (m: number): [number, number] => [edge + m / KX, C[1]];
    const props = {
      id: 's',
      subtype: 'road',
      class: 'primary',
      road_flags: '[{"between":[0.5,0.75],"values":["is_bridge"]}]',
    };
    const piece = (from: number, to: number, tx: number) => ({
      properties: props,
      geometry: { type: 'LineString', coordinates: [east(from), east(to)] },
      tile: { z, x: tx, y },
    });
    const west = piece(-200, 10, x - 1);
    const eastPiece = piece(-10, 200, x);
    const { map, module } = setup({}, [west, eastPiece]);
    const at = view({ center: east(0), zoom: 16 });
    module.update(at);
    expect(module.getStats().bridges).toBe(1);
    map.features = [eastPiece]; // the western tile leaves the view
    module.update(view({ center: east(1), zoom: 16 }));
    expect(module.getStats().bridges).toBe(1);
  });

  it('draws the roads on the ground only when asked, with a patch over each junction', () => {
    const road = (id: string, from: number, to: number, connectors: string) =>
      segment(id, from, to, { road_flags: undefined, connectors });
    const features = [
      road('a', -100, 0, '[{"connector_id":"w","at":0},{"connector_id":"x","at":1}]'),
      road('b', 0, 100, '[{"connector_id":"x","at":0},{"connector_id":"e","at":1}]'),
      // A side road ending at x: three ways meet there.
      {
        properties: {
          id: 'c',
          subtype: 'road',
          class: 'residential',
          connectors: '[{"connector_id":"x","at":0},{"connector_id":"n","at":1}]',
        },
        geometry: { type: 'LineString', coordinates: [at(0), at(0, 80)] },
      },
    ];
    const connectors = [
      { properties: { id: 'x' }, geometry: { type: 'Point', coordinates: at(0) } },
    ];
    const plain = setup({}, features);
    plain.map.querySourceFeatures.mockImplementation((_s: string, o?: { sourceLayer?: string }) =>
      o?.sourceLayer === 'connector' ? connectors : plain.map.features,
    );
    plain.module.update(view({ center: C, zoom: 16 }));
    expect(plain.module.getStats()).toMatchObject({ bridges: 0, ground: 0, junctions: 0 });
    const ground = setup({ groundRoads: true }, features);
    ground.map.querySourceFeatures.mockImplementation((_s: string, o?: { sourceLayer?: string }) =>
      o?.sourceLayer === 'connector' ? connectors : ground.map.features,
    );
    ground.module.update(view({ center: C, zoom: 16 }));
    expect(ground.module.getStats()).toMatchObject({ ground: 3, junctions: 1 });
    expect(deck(ground.scene).geometry.getAttribute('position').count).toBeGreaterThan(0);
  });

  it('stands a portal where a road goes into a tunnel', () => {
    const { module } = setup({}, [
      segment('t', 0, 300, { road_flags: '[{"between":[0.5,1],"values":["is_tunnel"]}]' }),
    ]);
    module.update(view({ center: C, zoom: 16 }));
    expect(module.getStats()).toMatchObject({ bridges: 0, portals: 1 });
  });

  it('cuts down into a tunnel on the level, but not into a hillside', () => {
    const tunnel = segment('t', 0, 300, {
      road_flags: '[{"between":[0.5,1],"values":["is_tunnel"]}]',
    });
    const mask = (scene: Scene) =>
      (scene.getObjectByName('ground-mask') as Mesh<BufferGeometry>).geometry.getAttribute(
        'position',
      )?.count ?? 0;
    const flat = setup({}, [tunnel]);
    flat.module.update(view({ center: C, zoom: 16 }));
    expect(flat.module.getStats().portals).toBe(1);
    expect(mask(flat.scene)).toBeGreaterThan(0);
    // The ground rising 20 m over the tunnel, from 10 m past its mouth (at 150 m east).
    const hill = setup({}, [tunnel]);
    hill.map.getTerrain = () => ({ source: 'dem' });
    hill.map.queryTerrainElevation = ((p: [number, number]) =>
      (p[0] - C[0]) * KX > 155 ? 20 : 0) as never;
    hill.module.update(view({ center: C, zoom: 16 }));
    expect(hill.module.getStats().portals).toBe(1);
    expect(mask(hill.scene)).toBe(0);
  });

  it('draws nothing below minZoom', () => {
    const { scene, module } = setup({}, [segment('a', 0, 300)]);
    module.update(view({ center: C, zoom: 14 }));
    expect(module.getStats().bridges).toBe(0);
    expect(deck(scene).geometry.getAttribute('position')).toBeUndefined();
  });
});
