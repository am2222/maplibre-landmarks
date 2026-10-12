import { afterEach, describe, expect, it, vi } from 'vitest';
import { Matrix4, Scene, Vector3, type InstancedMesh, type Mesh } from 'three';
import type { ModuleContext } from '../../src/core/LayerModule';
import {
  StreetFurnitureModule,
  type StreetFurnitureOptions,
} from '../../src/street/StreetFurnitureModule';
import * as pkg from '../../src/index';
import { view } from './helpers';

const C: [number, number] = [2.3522, 48.8566];
const M = 111_320;
const KX = M * Math.cos((C[1] * Math.PI) / 180);
const at = (east: number, north = 0): [number, number] => [C[0] + east / KX, C[1] + north / M];
const prop = (cls: string, east: number, north = 0, tags: object = {}, id?: string) => ({
  properties: {
    subtype: 'pedestrian',
    class: cls,
    source_tags: JSON.stringify(tags),
    ...(id ? { id } : {}),
  },
  geometry: { type: 'Point', coordinates: at(east, north) },
});

/** A `w` × `d` metre rectangle with its south-west corner `east`, `north` metres from C. */
const area = (
  cls: string,
  east: number,
  north: number,
  w: number,
  d: number,
  tags: object = {},
  id?: string,
) => ({
  properties: { class: cls, source_tags: JSON.stringify(tags), ...(id ? { id } : {}) },
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        at(east, north),
        at(east + w, north),
        at(east + w, north + d),
        at(east, north + d),
        at(east, north),
      ],
    ],
  },
});
const line = (cls: string, points: [number, number][], tags: object = {}) => ({
  properties: { class: cls, source_tags: JSON.stringify(tags) },
  geometry: { type: 'LineString', coordinates: points.map(([e, n]) => at(e, n)) },
});
const scaleOf = (m: InstancedMesh, i = 0) => {
  const matrix = new Matrix4();
  m.getMatrixAt(i, matrix);
  return new Vector3().setFromMatrixScale(matrix);
};
const areasMesh = (scene: Scene) =>
  scene.getObjectByName('street-furniture')!.getObjectByName('street-areas') as Mesh;

function setup(over: Partial<StreetFurnitureOptions> = {}, features: unknown[] = []) {
  const handlers = new Map<string, (e?: unknown) => void>();
  const listeners = new Map<string, ((e?: unknown) => void)[]>();
  const map = {
    features,
    getSource: (id: string) => (id === 'base' ? { type: 'vector' } : undefined),
    getTerrain: (): { source: string } | null => null,
    queryTerrainElevation: (_p: unknown): number | null => 0,
    getZoom: () => 17,
    getCenter: () => ({ lng: C[0], lat: C[1] }),
    querySourceFeatures: vi.fn(() => map.features),
    // Several listeners per event (the module and its tile feed); handlers.get(t) calls them all.
    on: vi.fn((t: string, fn: (e?: unknown) => void) => {
      listeners.set(t, [...(listeners.get(t) ?? []), fn]);
      handlers.set(t, (e?: unknown) => [...(listeners.get(t) ?? [])].forEach((f) => f(e)));
    }),
    off: vi.fn((t: string, fn?: (e?: unknown) => void) => {
      const list = (listeners.get(t) ?? []).filter((f) => f !== fn);
      listeners.set(t, list);
      if (!list.length) handlers.delete(t);
    }),
  };
  const scene = new Scene();
  const onError = vi.fn();
  const module = new StreetFurnitureModule({ source: 'base', onError, ...over });
  module.onAdd({
    map,
    scene,
    core: { theme: 'day' },
    requestRepaint: vi.fn(),
  } as unknown as ModuleContext);
  return { map, scene, module, onError, handlers };
}

const mesh = (scene: Scene, name: string) =>
  scene.getObjectByName('street-furniture')!.getObjectByName(name) as InstancedMesh;

afterEach(() => vi.useRealTimers());

describe('StreetFurnitureModule', () => {
  it('instances each prop kind in its own mesh', () => {
    const { scene, module } = setup({}, [
      prop('bench', 0),
      prop('bench', 10),
      prop('bollard', 5),
      prop('atm', 3), // not a furniture kind
    ]);
    module.update(view({ center: C, zoom: 17 }));
    expect(module.getStats()).toEqual({ total: 3, byKind: { bench: 2, bollard: 1 }, areas: 0 });
    expect(mesh(scene, 'bench').count).toBe(2);
    expect(mesh(scene, 'bollard').count).toBe(1);
    expect(mesh(scene, 'fire_hydrant').count).toBe(0);
  });

  it('draws a prop seen in two tiles once', () => {
    // The same bench in the buffers of two neighbouring tiles: two tile keys, one bench.
    const inTile = (x: number) => ({ ...prop('bench', 0), tile: { z: 16, x, y: 22546 } });
    const { module } = setup({}, [inTile(33196), inTile(33197)]);
    module.update(view({ center: C, zoom: 17 }));
    expect(module.getStats().total).toBe(1);
  });

  it('matches a prop by its Overture id across tiles of different zooms', () => {
    // A parent and a child tile quantise the same bench a few millimetres apart.
    const { module } = setup({}, [
      prop('bench', 0, 0, {}, 'b1'),
      prop('bench', 0.4, 0.3, {}, 'b1'),
      prop('bench', 10, 0, {}, 'b2'), // another bench
    ]);
    module.update(view({ center: C, zoom: 17 }));
    expect(module.getStats().total).toBe(2);
  });

  it('lifts props onto terrain that loads after them', () => {
    vi.useFakeTimers();
    const { scene, map, module, handlers } = setup({}, [prop('bench', 0)]);
    let ground = 0;
    map.getTerrain = () => ({ source: 'dem' });
    map.queryTerrainElevation = () => ground;
    module.update(view({ center: C, zoom: 17 }));
    const y = () => {
      const m = new Matrix4();
      mesh(scene, 'bench').getMatrixAt(0, m);
      return new Vector3().setFromMatrixPosition(m).y;
    };
    expect(y()).toBe(0);
    ground = 50; // the DEM tiles arrived
    handlers.get('sourcedata')!({ sourceId: 'dem' });
    vi.advanceTimersByTime(200);
    expect(y()).toBe(50);
    ground = 20; // terrain exaggeration changed
    handlers.get('terrain')!();
    vi.advanceTimersByTime(200);
    expect(y()).toBe(20);
  });

  it('gives each kind its own mesh even when listed twice', () => {
    const { scene, module } = setup({ kinds: ['bench', 'bench'], maxPerKind: 2 }, [
      prop('bench', 0),
      prop('bench', 10),
    ]);
    module.update(view({ center: C, zoom: 17 }));
    const group = scene.getObjectByName('street-furniture')!;
    expect(group.children.filter((c) => c.name === 'bench')).toHaveLength(1);
    expect(mesh(scene, 'bench').count).toBe(2);
    expect(module.getStats().total).toBe(2);
  });

  it('turns a prop to its OSM direction tag', () => {
    const { scene, module } = setup({}, [prop('bench', 0, 0, { direction: 'E' })]);
    module.update(view({ center: C, zoom: 17 }));
    const m = new Matrix4();
    mesh(scene, 'bench').getMatrixAt(0, m);
    // Front is −Z (north) before turning; facing east, it points +X.
    const front = new Vector3(0, 0, -1).transformDirection(m);
    expect(front.x).toBeCloseTo(1, 6);
    expect(front.z).toBeCloseTo(0, 6);
  });

  it('draws only the kinds asked for, nearest first up to maxPerKind', () => {
    const { module } = setup({ kinds: ['bench'], maxPerKind: 2 }, [
      prop('bench', 30),
      prop('bench', 10),
      prop('bench', 20),
      prop('bollard', 1),
    ]);
    module.update(view({ center: C, zoom: 17 }));
    expect(module.getStats()).toEqual({ total: 2, byKind: { bench: 2 }, areas: 0 });
  });

  it('reads nothing below minZoom', () => {
    const { map, module } = setup({}, [prop('bench', 0)]);
    module.update(view({ center: C, zoom: 15 }));
    expect(map.querySourceFeatures).not.toHaveBeenCalled();
    expect(module.getStats().total).toBe(0);
  });

  it('zooming out below minZoom clears the props and lets go of the tiles', () => {
    const { scene, map, module } = setup({}, [prop('bench', 0)]);
    module.update(view({ center: C, zoom: 17 }));
    expect(mesh(scene, 'bench').count).toBe(1);
    module.update(view({ center: C, zoom: 15 }));
    expect(mesh(scene, 'bench').count).toBe(0);
    expect(module.getStats().total).toBe(0);
    // The feed is suspended: no tile is held (or read) while zoomed out.
    expect((module as unknown as { tiles: Map<string, unknown> }).tiles.size).toBe(0);
    map.querySourceFeatures.mockClear();
    module.update(view({ center: C, zoom: 15 }));
    expect(map.querySourceFeatures).not.toHaveBeenCalled();
    module.update(view({ center: C, zoom: 17 }));
    expect(module.getStats().total).toBe(1);
  });

  it('pitched: draws no prop past the far cutoff', () => {
    const { module } = setup({}, [prop('bench', 0), prop('bench', 2000)]);
    module.update(view({ center: C, zoom: 17, pitch: 70, heightPx: 900 }));
    expect(module.getStats().total).toBe(1);
  });

  it('reports a missing source once and cleans up on removal', () => {
    const { scene, module, onError, handlers } = setup({ source: 'nope' });
    module.update(view({ center: C, zoom: 17 }));
    module.update(view({ center: C, zoom: 17 }));
    expect(onError).toHaveBeenCalledTimes(1);
    module.onRemove();
    expect(scene.getObjectByName('street-furniture')).toBeUndefined();
    expect(handlers.has('terrain')).toBe(false);
  });
});

describe('StreetFurnitureModule: fountains, artworks, masts, tanks and areas', () => {
  it('draws figures among artworks, masts at their height, and no underground tank', () => {
    const { scene, module } = setup({}, [
      prop('artwork', 0, 0, { artwork_type: 'statue' }),
      prop('artwork', 5, 0, { artwork_type: 'mural' }),
      prop('communication_tower', 10, 0, { height: '139' }),
      prop('storage_tank', 20, 0, { location: 'underground' }),
      prop('storage_tank', 30, 0, { height: '6' }),
      prop('fountain', 40, 0, { fountain: 'wallace' }),
    ]);
    module.update(view({ center: C, zoom: 17 }));
    expect(module.getStats().byKind).toEqual({
      artwork: 1,
      communication_tower: 1,
      storage_tank: 1,
      fountain: 1,
    });
    expect(scaleOf(mesh(scene, 'communication_tower')).y).toBeCloseTo(139, 4);
    expect(scaleOf(mesh(scene, 'storage_tank')).y).toBeCloseTo(6, 4);
  });

  it('stands a storage tank mapped as an area as a cylinder on its outline', () => {
    const { scene, module } = setup({}, [area('storage_tank', 0, 0, 20, 20, { height: '12' })]);
    module.update(view({ center: C, zoom: 17 }));
    expect(module.getStats().byKind.storage_tank).toBe(1);
    const s = scaleOf(mesh(scene, 'storage_tank'));
    expect(s.x).toBeCloseTo(Math.sqrt(400 / Math.PI), 1); // the same area as the outline
    expect(s.y).toBeCloseTo(12, 4);
  });

  it('builds fountain basins, platforms and pier decks into one mesh', () => {
    const { scene, module } = setup({}, [
      area('fountain', 0, 0, 6, 6, { height: '0.4' }, 'f1'),
      area('platform', 20, 0, 40, 4, { railway: 'platform' }, 'p1'),
      line('pier', [
        [0, 30],
        [30, 30],
      ]),
    ]);
    module.update(view({ center: C, zoom: 17 }));
    expect(module.getStats().areas).toBe(3);
    const y = areasMesh(scene).geometry.getAttribute('position');
    let top = 0;
    for (let i = 0; i < y.count; i++) top = Math.max(top, y.getY(i));
    expect(top).toBeCloseTo(0.9, 4); // the rail platform
  });

  it('skips indoor and underground platforms', () => {
    const { module } = setup({}, [
      area('platform', 0, 0, 40, 4, { railway: 'platform', indoor: 'yes' }),
      area('platform', 0, 10, 40, 4, { subway: 'yes', level: '-3' }),
    ]);
    module.update(view({ center: C, zoom: 17 }));
    expect(module.getStats().areas).toBe(0);
  });

  it('draws an area clipped into two tiles once, from its larger piece', () => {
    const tiled = (w: number, x: number) => ({
      ...area('platform', 0, 0, w, 4, { railway: 'platform' }, 'p1'),
      tile: { z: 14, x, y: 5636 },
    });
    const { scene, module } = setup({}, [tiled(10, 8296), tiled(40, 8297)]);
    module.update(view({ center: C, zoom: 17 }));
    expect(module.getStats().areas).toBe(1);
    const x = areasMesh(scene).geometry.getAttribute('position');
    let span = 0;
    for (let i = 0; i < x.count; i++) span = Math.max(span, x.getX(i) - x.getX(0));
    expect(span).toBeGreaterThan(30); // the 40 m piece, not the 10 m one
  });

  it('reads no areas with areas: false', () => {
    const { map, module } = setup({ areas: false }, [area('platform', 0, 0, 40, 4, {})]);
    module.update(view({ center: C, zoom: 17 }));
    expect(module.getStats().areas).toBe(0);
    const [, options] = map.querySourceFeatures.mock.calls[0] as unknown as [
      string,
      { filter: unknown[] },
    ];
    expect(JSON.stringify(options.filter)).not.toContain('platform');
  });
});

describe('package exports', () => {
  it('exports the street furniture layer', () => {
    expect(pkg.StreetFurnitureLayer).toBeTypeOf('function');
    expect(pkg.PROP_KINDS).toContain('bench');
  });
});
