import { afterEach, describe, expect, it, vi } from 'vitest';
import { Scene, type InstancedMesh, type LineSegments } from 'three';
import type { ModuleContext } from '../../src/core/LayerModule';
import { PowerModule, type PowerOptions } from '../../src/power/PowerModule';
import { view } from './helpers';

const C: [number, number] = [2.2945, 48.8584];
const M = 111_320;
const KX = M * Math.cos((C[1] * Math.PI) / 180);
const at = (east: number, north = 0): [number, number] => [C[0] + east / KX, C[1] + north / M];
const towerAt = (east: number, tags = '{"power":"tower"}') => ({
  properties: { subtype: 'power', class: 'power_tower', source_tags: tags },
  geometry: { type: 'Point', coordinates: at(east) },
});
const line = (id: string, from: number, to: number, cls = 'power_line') => ({
  properties: { subtype: 'power', class: cls, id },
  geometry: { type: 'LineString', coordinates: [at(from), at(to)] },
});

function setup(over: Partial<PowerOptions> = {}, features: unknown[] = [], water: unknown[] = []) {
  const handlers = new Map<string, (e?: unknown) => void>();
  const listeners = new Map<string, ((e?: unknown) => void)[]>();
  const map = {
    features,
    handlers,
    getSource: (id: string) => (id === 'base' ? { type: 'vector' } : undefined),
    getTerrain: () => null,
    queryTerrainElevation: () => 0,
    getZoom: () => 16,
    getCenter: () => ({ lng: C[0], lat: C[1] }),
    querySourceFeatures: vi.fn((_s: string, o: { sourceLayer?: string }) =>
      o.sourceLayer === 'water' ? water : map.features,
    ),
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
  const requestRepaint = vi.fn();
  const onError = vi.fn();
  const module = new PowerModule({ source: 'base', onError, ...over });
  module.onAdd({ map, scene, core: { theme: 'day' }, requestRepaint } as unknown as ModuleContext);
  return { map, scene, module, onError, requestRepaint };
}

const meshes = (scene: Scene) => scene.getObjectByName('power')!.children;

afterEach(() => vi.useRealTimers());

describe('PowerModule', () => {
  it('stands a pylon on each tower and hangs three wires per span', () => {
    const { scene, module } = setup({}, [
      line('a', 0, 600),
      towerAt(0, '{"power":"tower","height":"42"}'),
      towerAt(300),
      towerAt(600),
    ]);
    module.update(view({ center: C, zoom: 16 }));
    expect(module.getStats()).toMatchObject({ supports: 3, spans: 2 });
    const pylons = meshes(scene).find((m) => m.name === 'tower') as InstancedMesh;
    expect(pylons.count).toBe(3);
    const wires = meshes(scene).find((m) => m.name === 'wires') as LineSegments;
    // 2 spans × 3 wires × 12 segments × 2 ends.
    expect(wires.geometry.getAttribute('position').count).toBe(2 * 3 * 12 * 2);
    expect(module.getStats().tallest).toBe(42);
  });

  it('asks only for power features, and draws nothing below minZoom', () => {
    const { map, module } = setup({ minZoom: 15 }, [line('a', 0, 300), towerAt(0), towerAt(300)]);
    module.update(view({ center: C, zoom: 14 }));
    expect(map.querySourceFeatures).not.toHaveBeenCalled();
    expect(module.getStats().supports).toBe(0);
    module.update(view({ center: C, zoom: 16 }));
    const [, options] = map.querySourceFeatures.mock.calls[0] as unknown as [
      string,
      { sourceLayer: string; filter: unknown[] },
    ];
    expect(options.sourceLayer).toBe('infrastructure');
    expect(JSON.stringify(options.filter)).toContain('power_tower');
    expect(JSON.stringify(options.filter)).not.toContain('"cable"');
  });

  it("puts no pole in a river where a minor line's vertex lies in it", () => {
    const minor = {
      properties: { subtype: 'power', class: 'minor_line', id: 'm' },
      geometry: { type: 'LineString', coordinates: [at(0), at(40), at(80)] },
    };
    const river = {
      properties: { subtype: 'river' },
      geometry: {
        type: 'Polygon',
        coordinates: [[at(30, -20), at(50, -20), at(50, 20), at(30, 20), at(30, -20)]],
      },
    };
    const { module } = setup({}, [minor], [river]);
    module.update(view({ center: C, zoom: 16 }));
    expect(module.getStats()).toMatchObject({ supports: 2, spans: 1 });
  });

  it('pitched: draws no support past the far cutoff', () => {
    const { module } = setup({}, [line('a', 0, 2400), towerAt(0), towerAt(1200), towerAt(2400)]);
    module.update(view({ center: C, zoom: 17, pitch: 70, heightPx: 900 })); // cutoff ~1.06 km
    expect(module.getStats()).toMatchObject({ supports: 1, spans: 0 });
  });

  it('reports a missing source once and cleans up on removal', () => {
    const { map, scene, module, onError } = setup({ source: 'nope' });
    module.update(view());
    module.update(view());
    expect(onError).toHaveBeenCalledTimes(1);
    module.onRemove();
    expect(scene.getObjectByName('power')).toBeUndefined();
    expect(map.handlers.has('sourcedata')).toBe(false);
  });
});
