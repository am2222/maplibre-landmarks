import { afterEach, describe, expect, it, vi } from 'vitest';
import { Matrix4, Scene, Vector3, type InstancedMesh } from 'three';
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
    expect(module.getStats()).toEqual({ total: 3, byKind: { bench: 2, bollard: 1 } });
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
    expect(module.getStats()).toEqual({ total: 2, byKind: { bench: 2 } });
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

describe('package exports', () => {
  it('exports the street furniture layer', () => {
    expect(pkg.StreetFurnitureLayer).toBeTypeOf('function');
    expect(pkg.PROP_KINDS).toContain('bench');
  });
});
