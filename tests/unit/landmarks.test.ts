import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Scene, type Object3D } from 'three';
import type { ModuleContext } from '../../src/core/LayerModule';
import { originAt } from '../../src/core/mercator';
import type { LandmarkEntry, Lod } from '../../src/landmarks/catalogue';
import { LandmarksModule, type LandmarksOptions } from '../../src/landmarks/LandmarksModule';
import {
  exemptionsFor,
  offExemptionsChanged,
  onExemptionsChanged,
} from '../../src/labels/exemptions';
import { BASE, CATALOGUE, entry, POINTER, rawCell } from './fixtures';
import { deferred, fakeFetch, flush, view } from './helpers';

const CELL = `${BASE}/api/v1/releases/r1/index/12/2074/1409.json`;

function routes(over: Record<string, unknown> = {}) {
  return {
    [`${BASE}/api/v1/latest.json`]: POINTER,
    [`${BASE}/api/v1/releases/r1/catalogue.json`]: CATALOGUE,
    [CELL]: rawCell([entry('eiffel', { attribution: 'IGN LiDAR' })]),
    ...over,
  };
}

const ORIGINAL_OPACITY = 0.5;

function fakeMapForModule() {
  const paint: Record<string, unknown> = { 'fill-opacity': ORIGINAL_OPACITY };
  const states = new Map<unknown, Record<string, unknown>>();
  const layers = new Set<string>(['buildings']);
  const sources = new Map<string, unknown>();
  const d = 0.00005;
  // One basemap building right under the Eiffel fixture's anchor.
  const features = [
    {
      id: 1,
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [2.2945 - d, 48.8584 - d],
            [2.2945 + d, 48.8584 - d],
            [2.2945 + d, 48.8584 + d],
            [2.2945 - d, 48.8584 - d],
          ],
        ],
      },
    },
  ];
  let terrain: object | null = null;
  const map = {
    paint,
    states,
    sources,
    setTerrain: (t: object | null) => (terrain = t),
    getTerrain: () => terrain,
    queryTerrainElevation: vi.fn(() => 35),
    getLayer: (id: string) =>
      layers.has(id)
        ? { id, type: 'fill', source: 'protomaps', sourceLayer: 'buildings' }
        : undefined,
    getPaintProperty: (_id: string, p: string) => paint[p],
    setPaintProperty: vi.fn((_id: string, p: string, v: unknown) => (paint[p] = v)),
    querySourceFeatures: () => features,
    setFeatureState: (f: { id: unknown }, st: Record<string, unknown>) =>
      states.set(f.id, { ...states.get(f.id), ...st }),
    removeFeatureState: (f: { id: unknown }, key: string) => delete states.get(f.id)?.[key],
    on: vi.fn(),
    off: vi.fn(),
    getSource: (id: string) => sources.get(id),
    addSource: (id: string, s: unknown) => sources.set(id, s),
    removeSource: (id: string) => sources.delete(id),
    addLayer: (l: { id: string }) => layers.add(l.id),
    removeLayer: (id: string) => layers.delete(id),
  };
  return map;
}

const isHidden = (s: { map: ReturnType<typeof fakeMapForModule> }) =>
  s.map.states.get(1)?.['landmarks:fade'] === 1;
const fadeOf = (s: { map: ReturnType<typeof fakeMapForModule> }) =>
  s.map.states.get(1)?.['landmarks:fade'] as number | undefined;

function setup(opts: Partial<LandmarksOptions> = {}, fetchRoutes = routes()) {
  const f = fakeFetch(fetchRoutes);
  const loads: {
    entry: LandmarkEntry;
    lod: Lod;
    d: ReturnType<typeof deferred<{ object: Object3D; bytes: number }>>;
  }[] = [];
  const onError = vi.fn();
  const onModelsChanged = vi.fn();
  const module = new LandmarksModule(
    'landmarks',
    {
      baseUrl: BASE,
      fetch: f,
      replaceBuildings: ['buildings'],
      onError,
      onModelsChanged,
      fadeMs: 0,
      ...opts,
    },
    (e, lod) => {
      const d = deferred<{ object: Object3D; bytes: number }>();
      loads.push({ entry: e, lod, d });
      return d.promise;
    },
  );
  const map = fakeMapForModule();
  const scene = new Scene();
  const core = { setTheme: vi.fn(), theme: 'day', warmUp: vi.fn(() => Promise.resolve()) };
  const requestRepaint = vi.fn();
  const ctx = { map, core, scene, requestRepaint } as unknown as ModuleContext;
  module.onAdd(ctx);
  return { module, f, loads, onError, onModelsChanged, map, scene, core, requestRepaint, ctx };
}

async function loadEiffel(s: ReturnType<typeof setup>, object: Object3D = new Group()) {
  s.module.update(view());
  await flush();
  s.loads[0]!.d.resolve({ object, bytes: 10 });
  await flush();
  return object;
}

/** A model with one real material, so its opacity can be observed. */
function model() {
  const material = new MeshStandardMaterial();
  const group = new Group().add(new Mesh(new BoxGeometry(), material));
  return { group, material };
}

describe('LandmarksModule', () => {
  it('applies the theme option on add', () => {
    const s = setup({ theme: 'night' });
    expect(s.core.setTheme).toHaveBeenCalledWith('night');
  });

  it('applies the theme option only on the first add (review #5)', () => {
    const s = setup({ theme: 'night' });
    s.module.onRemove();
    s.module.onAdd(s.ctx);
    expect(s.core.setTheme).toHaveBeenCalledTimes(1);
  });

  it('leaves the map theme alone without a theme option', () => {
    const s = setup();
    expect(s.core.setTheme).not.toHaveBeenCalled();
  });

  it('does nothing below zoom 14', async () => {
    const s = setup();
    s.module.update(view({ zoom: 13 }));
    await flush();
    expect(s.f.calls).toEqual([]);
  });

  it('discovers, loads and adds a landmark to the scene', async () => {
    const s = setup();
    const object = await loadEiffel(s);
    expect(s.loads[0]!.entry.id).toBe('eiffel');
    expect(s.loads[0]!.lod).toBe('low');
    expect(s.scene.children).toContain(object);
    expect(s.requestRepaint).toHaveBeenCalled();
    expect(s.onModelsChanged).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: 'eiffel', lod: 'low', attribution: 'IGN LiDAR' }),
    ]);
    expect(s.module.getAttribution()).toContain('IGN LiDAR');
    expect(
      (s.map.sources.get('landmarks-attribution') as { attribution: string }).attribution,
    ).toContain('IGN LiDAR');
  });

  it('hides the basemap building once the model is in the scene', async () => {
    const s = setup();
    s.module.update(view());
    await flush();
    expect(isHidden(s)).toBe(false);
    s.loads[0]!.d.resolve({ object: new Group(), bytes: 10 });
    await flush();
    expect(isHidden(s)).toBe(true);
  });

  it('places models relative to the origin, with terrain elevation', async () => {
    const s = setup();
    const object = await loadEiffel(s);
    s.module.place(originAt([2.2945, 48.8584]));
    expect(object.position.x).toBeCloseTo(0, 6);
    expect(object.position.y).toBe(0);
    const handler = (type: string) =>
      s.map.on.mock.calls.find(([t]) => t === type)![1] as (e?: object) => void;
    s.map.setTerrain({ source: 'dem' });
    handler('terrain')();
    s.module.place(originAt([2.2945, 48.8584]));
    expect(object.position.y).toBe(35);
  });

  it('fits the footing to terrain, and restores it when terrain is turned off', async () => {
    const s = setup();
    const geometry = new BoxGeometry(10, 10, 10).translate(0, 5, 0);
    const group = new Group().add(new Mesh(geometry, new MeshStandardMaterial()));
    await loadEiffel(s, group);
    const terrain = s.map.on.mock.calls.find(([t]) => t === 'terrain')![1] as () => void;
    const origin = originAt([2.2945, 48.8584]);
    s.map.setTerrain({ source: 'dem' });
    terrain();
    s.module.place(origin);
    expect(geometry.boundingBox!.min.y).toBeCloseTo(-0.25, 6); // flat terrain: just the sink
    s.map.setTerrain(null);
    terrain();
    s.module.place(origin);
    expect(geometry.boundingBox!.min.y).toBe(0);
  });

  it('caches terrain elevation until DEM tiles arrive', async () => {
    const s = setup();
    s.map.setTerrain({ source: 'dem' });
    const object = await loadEiffel(s);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const origin = originAt([2.2945, 48.8584]);
      s.module.place(origin);
      s.module.place(origin);
      expect(s.map.queryTerrainElevation).toHaveBeenCalledTimes(1);
      expect(object.position.y).toBe(35);

      const sourcedata = s.map.on.mock.calls.find(([t]) => t === 'sourcedata')![1] as (
        e: object,
      ) => void;
      // Other sources and metadata events leave the cache alone.
      sourcedata({ sourceId: 'protomaps' });
      sourcedata({ sourceId: 'dem', sourceDataType: 'metadata' });
      vi.advanceTimersByTime(200);
      s.module.place(origin);
      expect(s.map.queryTerrainElevation).toHaveBeenCalledTimes(1);

      s.map.queryTerrainElevation.mockReturnValue(40);
      sourcedata({ sourceId: 'dem' });
      sourcedata({ sourceId: 'dem' });
      vi.advanceTimersByTime(150);
      expect(s.requestRepaint).toHaveBeenCalled();
      s.module.place(origin);
      expect(s.map.queryTerrainElevation).toHaveBeenCalledTimes(2);
      expect(object.position.y).toBe(40);
    } finally {
      vi.useRealTimers();
    }
  });

  it('warms shaders up, then fades the model in while its building sinks', async () => {
    const s = setup({ fadeMs: 400 });
    const warm = deferred<void>();
    s.core.warmUp.mockReturnValueOnce(warm.promise);
    const { group, material } = model();
    await loadEiffel(s, group);
    expect(s.core.warmUp).toHaveBeenCalledWith(group, s.scene);
    expect(s.scene.children).not.toContain(group); // not drawn before its shaders are ready
    expect(fadeOf(s)).toBeUndefined();

    warm.resolve();
    await flush();
    expect(s.scene.children).toContain(group);
    expect(material.alphaHash).toBe(true);
    expect(material.opacity).toBe(0);
    expect(fadeOf(s)).toBe(0);

    expect(s.module.frame(1000)).toBe(true); // clock starts on the first frame
    expect(s.module.frame(1200)).toBe(true);
    expect(material.opacity).toBeGreaterThan(0.2);
    expect(material.opacity).toBeLessThan(0.8);
    expect(fadeOf(s)).toBeCloseTo(material.opacity, 6);
    expect(s.module.frame(1400)).toBe(false);
    expect(material.opacity).toBe(1);
    expect(isHidden(s)).toBe(true);
    expect(s.module.frame(1500)).toBe(false); // idle frames do nothing
  });

  it('cross-fades LODs: the old model stays underneath until the new one is in', async () => {
    const s = setup({ fadeMs: 400 });
    const low = model();
    await loadEiffel(s, low.group);
    s.module.frame(0);
    s.module.frame(400);
    expect(low.material.opacity).toBe(1);

    s.module.update(view({ zoom: 17.5 }));
    await flush();
    expect(s.loads[1]!.lod).toBe('detail');
    const detail = model();
    s.loads[1]!.d.resolve({ object: detail.group, bytes: 20 });
    await flush();
    expect(s.scene.children).toContain(low.group);
    expect(s.scene.children).toContain(detail.group);

    s.module.frame(1000);
    s.module.frame(1200);
    expect(low.material.opacity).toBe(1);
    expect(detail.material.opacity).toBeGreaterThan(0);
    expect(detail.group.children[0]!.renderOrder).toBe(1); // drawn over the old LOD
    expect(isHidden(s)).toBe(true); // the building never comes back during the swap
    s.module.frame(1400);
    expect(s.scene.children).not.toContain(low.group);
    expect(detail.group.children[0]!.renderOrder).toBe(0);
    expect(isHidden(s)).toBe(true);
  });

  it('fades a leaving model out before caching it, and the building rises back', async () => {
    const s = setup({ fadeMs: 400 });
    const { group, material } = model();
    await loadEiffel(s, group);
    s.module.frame(0);
    s.module.frame(400);

    s.module.update(view({ zoom: 13 }));
    await flush();
    expect(s.scene.children).toContain(group); // still on screen, fading
    s.module.frame(1000);
    s.module.frame(1200);
    expect(material.opacity).toBeGreaterThan(0);
    expect(material.opacity).toBeLessThan(1);
    expect(fadeOf(s)).toBeLessThan(1);
    expect(s.module.frame(1400)).toBe(false);
    expect(s.scene.children).not.toContain(group);
    expect(fadeOf(s)).toBeUndefined(); // feature-state cleared once fully shown again

    // Coming back reuses the cached model without a new download.
    s.module.update(view());
    await flush();
    expect(s.loads).toHaveLength(1);
    expect(s.scene.children).toContain(group);
  });

  it('reverses a fade-out when the model is wanted again mid-way', async () => {
    const s = setup({ fadeMs: 400 });
    const { group, material } = model();
    await loadEiffel(s, group);
    s.module.frame(0);
    s.module.frame(400);
    s.module.update(view({ zoom: 13 }));
    await flush();
    s.module.frame(1000);
    s.module.frame(1200);
    s.module.update(view());
    await flush();
    s.module.frame(1300);
    s.module.frame(2000);
    expect(s.loads).toHaveLength(1);
    expect(s.scene.children).toContain(group);
    expect(material.opacity).toBe(1);
    expect(isHidden(s)).toBe(true);
  });

  it('stays quiet when nothing is published', async () => {
    const s = setup(
      {},
      routes({ [`${BASE}/api/v1/latest.json`]: { ...POINTER, catalogue: null } }),
    );
    s.module.update(view());
    await flush();
    expect(s.onError).not.toHaveBeenCalled();
    expect(s.f.calls).toHaveLength(1);
  });

  it('reports catalogue failures once and recovers on the next update', async () => {
    const r = routes({ [`${BASE}/api/v1/latest.json`]: 503 });
    const s = setup({}, r);
    s.module.update(view());
    await flush();
    expect(s.onError).toHaveBeenCalledTimes(1);
    expect(s.onError.mock.calls[0]![1]).toEqual({ stage: 'catalogue' });
    r[`${BASE}/api/v1/latest.json`] = POINTER;
    s.module.update(view());
    await flush();
    expect(s.loads).toHaveLength(1);
  });

  it('reports cell failures with the cell stage', async () => {
    const s = setup({}, routes({ [CELL]: 500 }));
    s.module.update(view());
    await flush();
    expect(s.onError.mock.calls[0]![1]).toEqual({ stage: 'cell' });
  });

  it('ignores superseded discovery runs', async () => {
    const s = setup();
    s.module.update(view());
    s.module.update(view({ bounds: [-74.02, 40.7, -73.98, 40.72], center: [-74, 40.71] }));
    await flush();
    expect(s.loads).toHaveLength(0);
  });

  it('onRemove clears the scene, restores the basemap and drops attribution; late loads are discarded', async () => {
    const s = setup();
    s.module.update(view());
    await flush();
    s.module.onRemove();
    const late = new Group();
    s.loads[0]!.d.resolve({ object: late, bytes: 1 });
    await flush();
    expect(s.scene.children).not.toContain(late);
    expect(s.map.paint['fill-opacity']).toBe(ORIGINAL_OPACITY);
    expect(isHidden(s)).toBe(false);
    expect(s.map.sources.size).toBe(0);
    expect(s.onError).not.toHaveBeenCalled();
  });

  it('re-applies replacement and attribution after a diffed setStyle', async () => {
    const s = setup();
    await loadEiffel(s);
    expect(isHidden(s)).toBe(true);
    // The diff resets the layer paint to the new style's, the new source has no feature-state,
    // and our attribution source is dropped.
    s.map.paint['fill-opacity'] = 0.8;
    s.map.states.clear();
    s.map.removeLayer('landmarks-attribution');
    s.map.removeSource('landmarks-attribution');
    s.module.styleChanged(true);
    expect(s.map.paint['fill-opacity']).toEqual([
      '*',
      0.8,
      ['-', 1, ['coalesce', ['feature-state', 'landmarks:fade'], 0]],
    ]);
    expect(isHidden(s)).toBe(true);
    expect(s.map.sources.has('landmarks-attribution')).toBe(true);
    s.module.onRemove();
    expect(s.map.paint['fill-opacity']).toBe(0.8);
    expect(isHidden(s)).toBe(false);
  });

  it('leaves the new style untouched when a full setStyle dropped the layer', async () => {
    const s = setup();
    await loadEiffel(s);
    s.map.paint['fill-opacity'] = 0.8;
    s.map.states.clear();
    s.map.removeLayer('landmarks-attribution');
    s.map.removeSource('landmarks-attribution');
    s.map.setPaintProperty.mockClear();
    s.module.styleChanged(false);
    s.module.onRemove();
    expect(s.map.paint['fill-opacity']).toBe(0.8);
    expect(s.map.setPaintProperty).not.toHaveBeenCalled();
    expect(s.map.sources.size).toBe(0);
  });

  it('exempts the footprints of shown landmarks from label occlusion', async () => {
    const s = setup();
    const listener = vi.fn();
    onExemptionsChanged(s.map, listener);
    expect(exemptionsFor(s.map)).toEqual([]);
    await loadEiffel(s);
    expect(exemptionsFor(s.map)).toHaveLength(1); // the fixture's bounds rectangle
    expect(listener).toHaveBeenCalled();
    s.module.onRemove();
    expect(exemptionsFor(s.map)).toEqual([]);
    offExemptionsChanged(s.map, listener);
  });
});
