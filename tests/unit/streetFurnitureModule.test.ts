import { afterEach, describe, expect, it, vi } from 'vitest';
import { Matrix4, Scene, Vector3, type InstancedMesh, type Mesh } from 'three';
import type { ModuleContext } from '../../src/core/LayerModule';
import {
  StreetFurnitureModule,
  type StreetFurnitureOptions,
} from '../../src/street/StreetFurnitureModule';
import * as pkg from '../../src/index';
import { tileBounds } from '../../src/core/tileFeed';
import { localPosition, originAt } from '../../src/core/mercator';
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
/** The z-level tile holding C and the one east of it: keys and MapLibre tile ids. */
function tilesAround(z: number) {
  const n = 2 ** z;
  const x = Math.floor(((C[0] + 180) / 360) * n);
  const r = (C[1] * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  const at = (tx: number) => ({ key: `${z}/${tx}/${y}`, tile: { z, x: tx, y } });
  return [at(x), at(x + 1)] as const;
}
const positions = (m: Mesh) =>
  Array.from(m.geometry.getAttribute('position').array as Float32Array);
/** Area of the triangles lying flat at height `y` (m²). */
function flatArea(p: number[], y: number): number {
  let total = 0;
  for (let i = 0; i < p.length; i += 9) {
    if ([p[i + 1], p[i + 4], p[i + 7]].some((v) => Math.abs(v! - y) > 1e-3)) continue;
    const [ax, az, bx, bz, cx, cz] = [p[i]!, p[i + 2]!, p[i + 3]!, p[i + 5]!, p[i + 6]!, p[i + 8]!];
    total += Math.abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) / 2;
  }
  return total;
}
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
    const p = positions(areasMesh(scene));
    expect(Math.max(...p.filter((_, i) => i % 3 === 1))).toBeCloseTo(0.9, 4); // the rail platform
    expect(flatArea(p, 0.9)).toBeCloseTo(40 * 4, -1);
    expect(flatArea(p, 0.32)).toBeCloseTo(36, 0); // fountain water: 80% of its 0.4 m rim
    expect(flatArea(p, 0.6)).toBeCloseTo(30 * 3, -1); // the pier line: a 3 m deck
  });

  it('keeps areas where they are on the ground when the view moves', () => {
    const { scene, module } = setup({}, [area('fountain', 0, 0, 6, 6, { height: '0.5' }, 'f1')]);
    const world = () => {
      // A vertex in metres from C: the mesh is laid out around the anchor (the view centre).
      module.place({ x: 0.5, y: 0.5, scale: 1e-8 }); // any origin: compare relative to C
      const group = scene.getObjectByName('street-furniture')!;
      const p = areasMesh(scene).geometry.getAttribute('position');
      const xs = Array.from({ length: p.count }, (_, i) => p.getX(i) + group.position.x);
      return Math.min(...xs) - group.position.x + anchorEast();
    };
    let anchorEast = () => 0;
    module.update(view({ center: C, zoom: 17 }));
    const before = world();
    const moved: [number, number] = at(150, 0); // due east: the same map scale
    module.update(view({ center: moved, zoom: 17 }));
    anchorEast = () => localPosition(originAt(C), moved)[0]; // the new anchor, east of C
    expect(world()).toBeCloseTo(before, 1);
  });

  it('skips indoor, below-ground and underground platforms', () => {
    const { module } = setup({}, [
      area('platform', 0, 0, 40, 4, { railway: 'platform', indoor: 'yes' }),
      area('platform', 0, 10, 40, 4, { railway: 'platform', level: '-1' }),
      area('platform', 0, 20, 40, 4, { railway: 'platform', location: 'underground' }),
      area('platform', 0, 30, 40, 4, { railway: 'platform', level: '0' }), // drawn
    ]);
    module.update(view({ center: C, zoom: 17 }));
    expect(module.getStats().areas).toBe(1);
  });

  it('draws an area split across two tiles in full, once', () => {
    // A 60 m platform across the edge between two z16 tiles: each tile holds all of it (its
    // buffer reaches past the edge); drawn, the pieces meet at the edge without overlapping.
    const [west, east] = tilesAround(16);
    const edge = (tileBounds(east.key)[0] - C[0]) * KX;
    // Each tile holds its own part plus 5 m of buffer past the edge, as vector tiles do.
    const tags = { railway: 'platform' };
    const { scene, module } = setup({}, [
      { ...area('platform', edge - 30, 0, 35, 4, tags, 'p1'), tile: west.tile },
      { ...area('platform', edge - 5, 0, 35, 4, tags, 'p1'), tile: east.tile },
    ]);
    module.update(view({ center: C, zoom: 17 }));
    expect(module.getStats().areas).toBe(1);
    const p = positions(areasMesh(scene));
    expect(Math.abs(flatArea(p, 0.9) - 60 * 4)).toBeLessThan(2); // not 280: no overlap
    const xs = p.filter((_, i) => i % 3 === 0);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(60, 0);
  });

  it('draws an area held at two zooms from the more detailed tiles only', () => {
    const [west] = tilesAround(16);
    const parent = { z: 15, x: west.tile.x >> 1, y: west.tile.y >> 1 };
    const fountain = area('fountain', 0, 0, 6, 6, { height: '0.5' }, 'f1');
    const { scene, module } = setup({}, [
      { ...fountain, tile: parent },
      { ...fountain, tile: west.tile },
    ]);
    module.update(view({ center: C, zoom: 17 }));
    expect(flatArea(positions(areasMesh(scene)), 0.4)).toBeCloseTo(36, 0); // one water surface
  });

  it('draws every part of an area made of several', () => {
    const two = area('fountain', 0, 0, 4, 4, { height: '0.5' }, 'f2');
    (two.geometry as { type: string; coordinates: unknown }) = {
      type: 'MultiPolygon',
      coordinates: [two.geometry.coordinates, area('fountain', 20, 0, 4, 4).geometry.coordinates],
    };
    const { scene, module } = setup({}, [two]);
    module.update(view({ center: C, zoom: 17 }));
    expect(flatArea(positions(areasMesh(scene)), 0.4)).toBeCloseTo(32, 0);
  });

  it('sizes a tank split across two tiles from its whole outline', () => {
    const [west, east] = tilesAround(16);
    const edge = (tileBounds(east.key)[0] - C[0]) * KX;
    // 30 × 30 m, two thirds west of the tile edge.
    // Each tile holds its own part plus 5 m of buffer past the edge.
    const tags = { height: '12' };
    const { scene, module } = setup({}, [
      { ...area('storage_tank', edge - 20, 0, 25, 30, tags, 't1'), tile: west.tile },
      { ...area('storage_tank', edge - 5, 0, 15, 30, tags, 't1'), tile: east.tile },
    ]);
    module.update(view({ center: C, zoom: 17 }));
    expect(module.getStats().byKind.storage_tank).toBe(1);
    const tanks = mesh(scene, 'storage_tank');
    expect(scaleOf(tanks).x).toBeCloseTo(Math.sqrt(900 / Math.PI), 1);
    const m = new Matrix4();
    tanks.getMatrixAt(0, m);
    const at = new Vector3().setFromMatrixPosition(m);
    // The outline's centre: 15 m east and 15 m north of its south-west corner.
    expect(at.x).toBeCloseTo(edge - 20 + 15, 0);
    expect(at.z).toBeCloseTo(-15, 0);
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
