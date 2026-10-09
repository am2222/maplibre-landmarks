import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DirectionalLight,
  Group,
  HemisphereLight,
  Matrix4,
  PerspectiveCamera,
  type Scene,
} from 'three';
import type { Map as MlMap } from 'maplibre-gl';
import { createLightRig, THEMES } from '../../src/core/theme';
import type { LayerModule } from '../../src/core/LayerModule';
import { cameraMatrix, mercatorX } from '../../src/core/mercator';
import { ModuleLayer } from '../../src/core/ModuleLayer';
import { acquireCore, releaseCore, setTheme, type RendererLike } from '../../src/core/ThreeCore';

function fakeRenderer() {
  return {
    resetState: vi.fn(),
    render: vi.fn(),
    dispose: vi.fn(),
  } satisfies RendererLike;
}

function fakeMap() {
  const handlers = new Map<string, () => void>();
  return {
    handlers,
    getCenter: () => ({ lng: 2.2945, lat: 48.8584 }),
    getCanvas: () => ({}) as HTMLCanvasElement,
    getZoom: () => 16,
    getPitch: () => 45,
    getBearing: () => 10,
    getBounds: () => ({
      getWest: () => 2.28,
      getSouth: () => 48.85,
      getEast: () => 2.3,
      getNorth: () => 48.87,
    }),
    on: vi.fn((type: string, fn: () => void) => handlers.set(type, fn)),
    off: vi.fn((type: string) => handlers.delete(type)),
    triggerRepaint: vi.fn(),
    styleLayers: new Set<string>(),
    getLayer(id: string) {
      return this.styleLayers.has(id) ? { id } : undefined;
    },
  };
}

const gl = {} as WebGL2RenderingContext;
const PERSPECTIVE = new PerspectiveCamera(36, 1.5, 0.1, 1000).projectionMatrix.toArray();

/** A custom-layer render input whose view is identity (mainMatrix equals the projection). */
function frame(projectionTransition = 0) {
  return {
    projectionMatrix: PERSPECTIVE,
    defaultProjectionData: { mainMatrix: PERSPECTIVE, projectionTransition },
  } as never;
}
const asMap = (m: ReturnType<typeof fakeMap>) => m as unknown as MlMap;

afterEach(() => vi.useRealTimers());

describe('theme', () => {
  it('builds a hemisphere + sun rig and switches themes', () => {
    const rig = createLightRig('day');
    const hemi = rig.group.children.find((c) => c instanceof HemisphereLight) as HemisphereLight;
    const sun = rig.group.children.find((c) => c instanceof DirectionalLight) as DirectionalLight;
    expect(hemi.intensity).toBe(THEMES.day.hemi);
    rig.setTheme('night');
    expect(hemi.intensity).toBe(THEMES.night.hemi);
    expect(sun.intensity).toBe(THEMES.night.sun);
    rig.setTheme('dusk');
    expect(hemi.intensity).toBe(THEMES.dusk.hemi);
  });

  it('defines a palette for every theme', () => {
    for (const t of ['day', 'dawn', 'dusk', 'night'] as const) {
      expect(THEMES[t].palette.foliage).toBeTypeOf('number');
      expect(THEMES[t].palette.trunk).toBeTypeOf('number');
    }
  });

  it('adopts a theme set on the map before the core existed', () => {
    const map = fakeMap();
    setTheme(asMap(map), 'night');
    const core = acquireCore(asMap(map), gl, () => fakeRenderer());
    expect(core.theme).toBe('night');
    releaseCore(asMap(map));
  });

  it('setTheme(map) updates every scene and notifies registered modules', () => {
    const map = fakeMap();
    const core = acquireCore(asMap(map), gl, () => fakeRenderer());
    const scene = core.createScene();
    const mod = { themeChanged: vi.fn() };
    core.register(mod);
    setTheme(asMap(map), 'dusk');
    expect(mod.themeChanged).toHaveBeenCalledWith('dusk');
    const hemi = scene.children[0]!.children.find(
      (c) => c instanceof HemisphereLight,
    ) as HemisphereLight;
    expect(hemi.intensity).toBe(THEMES.dusk.hemi);
    core.unregister(mod);
    setTheme(asMap(map), 'day');
    expect(mod.themeChanged).toHaveBeenCalledTimes(1);
    releaseCore(asMap(map));
  });

  it('keeps the theme when the core is released and re-created', () => {
    const map = fakeMap();
    acquireCore(asMap(map), gl, () => fakeRenderer()).setTheme('dawn');
    releaseCore(asMap(map));
    expect(acquireCore(asMap(map), gl, () => fakeRenderer()).theme).toBe('dawn');
    releaseCore(asMap(map));
  });
});

describe('ThreeCore', () => {
  it('is shared per map and reference counted', () => {
    const map = fakeMap();
    const r = fakeRenderer();
    const factory = vi.fn(() => r);
    const a = acquireCore(asMap(map), gl, factory);
    const b = acquireCore(asMap(map), gl, factory);
    expect(a).toBe(b);
    expect(factory).toHaveBeenCalledTimes(1);
    releaseCore(asMap(map));
    expect(r.dispose).not.toHaveBeenCalled();
    releaseCore(asMap(map));
    expect(r.dispose).toHaveBeenCalledTimes(1);
    expect(acquireCore(asMap(map), gl, factory)).not.toBe(a);
    releaseCore(asMap(map));
  });

  it('renders around a per-frame origin with a split projection and view', () => {
    const map = fakeMap();
    const r = fakeRenderer();
    const core = acquireCore(asMap(map), gl, () => r);
    const scene = core.createScene();
    const place = vi.fn();
    const view = new Matrix4()
      .makeTranslation(0.1, -0.2, -3)
      .multiply(new Matrix4().makeScale(2, 2, 2));
    const main = new Matrix4().fromArray(PERSPECTIVE).multiply(view).toArray();
    core.render(scene, { mainMatrix: main, projectionMatrix: PERSPECTIVE }, place);
    const origin = place.mock.calls[0]![0];
    expect(origin.x).toBeCloseTo(mercatorX(2.2945), 12);
    expect(r.resetState).toHaveBeenCalledTimes(2);
    const [renderedScene, camera] = r.render.mock.calls[0]!;
    expect(renderedScene).toBe(scene);
    expect(camera.projectionMatrix.toArray()).toEqual(PERSPECTIVE);
    // projection × view reproduces MapLibre's matrix around the origin...
    const combined = camera.projectionMatrix.clone().multiply(camera.matrixWorldInverse).toArray();
    const expected = cameraMatrix(main, origin).toArray();
    combined.forEach((v: number, i: number) => expect(v).toBeCloseTo(expected[i]!, 6));
    // ...and the camera sits where the view puts it: 3 m (in local units) above the ground.
    const worldToView = camera.matrixWorld.clone().multiply(camera.matrixWorldInverse).toArray();
    worldToView.forEach((v: number, i: number) => expect(v).toBeCloseTo(i % 5 === 0 ? 1 : 0, 6));
    expect(camera.matrixAutoUpdate).toBe(false);
    releaseCore(asMap(map));
  });

  it('applies the theme to every scene', () => {
    const map = fakeMap();
    const core = acquireCore(asMap(map), gl, () => fakeRenderer());
    const s1 = core.createScene();
    core.setTheme('dawn');
    const s2 = core.createScene();
    const intensity = (s: Scene) =>
      (s.children[0]!.children.find((c) => c instanceof HemisphereLight) as HemisphereLight)
        .intensity;
    expect(intensity(s1)).toBe(THEMES.dawn.hemi);
    expect(intensity(s2)).toBe(THEMES.dawn.hemi);
    releaseCore(asMap(map));
  });
});

describe('ModuleLayer', () => {
  function moduleSpy(frameResult = false) {
    return {
      onAdd: vi.fn(),
      update: vi.fn(),
      place: vi.fn(),
      frame: vi.fn(() => frameResult),
      onRemove: vi.fn(),
      styleChanged: vi.fn(),
      themeChanged: vi.fn(),
    } satisfies LayerModule;
  }

  it('wires a module into the MapLibre custom layer lifecycle', () => {
    vi.useFakeTimers();
    const map = fakeMap();
    const r = fakeRenderer();
    const mod = moduleSpy();
    const layer = new ModuleLayer('test', mod, { rendererFactory: () => r });
    expect(layer.type).toBe('custom');
    expect(layer.renderingMode).toBe('3d');

    layer.onAdd(map as unknown as MlMap, gl);
    expect(mod.onAdd).toHaveBeenCalledTimes(1);
    expect(mod.update).toHaveBeenCalledWith({
      zoom: 16,
      pitch: 45,
      bearing: 10,
      center: [2.2945, 48.8584],
      bounds: [2.28, 48.85, 2.3, 48.87],
    });

    const moveend = map.handlers.get('moveend')!;
    moveend();
    moveend();
    vi.advanceTimersByTime(149);
    expect(mod.update).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(mod.update).toHaveBeenCalledTimes(2);

    layer.render(gl, frame());
    expect(mod.place).toHaveBeenCalledTimes(1);
    expect(r.render).toHaveBeenCalledTimes(1);
    expect(map.triggerRepaint).not.toHaveBeenCalled();

    layer.onRemove(map as unknown as MlMap, gl);
    expect(mod.onRemove).toHaveBeenCalledTimes(1);
    expect(map.handlers.has('moveend')).toBe(false);
    expect(r.dispose).toHaveBeenCalledTimes(1);
  });

  it('requests another frame while the module animates', () => {
    const map = fakeMap();
    const layer = new ModuleLayer('anim', moduleSpy(true), {
      rendererFactory: () => fakeRenderer(),
    });
    layer.onAdd(map as unknown as MlMap, gl);
    layer.render(gl, frame());
    expect(map.triggerRepaint).toHaveBeenCalledTimes(1);
    layer.onRemove(map as unknown as MlMap, gl);
  });

  it('compiles queued models inside the render callback, then resolves', async () => {
    const map = fakeMap();
    let finish!: () => void;
    const r = {
      ...fakeRenderer(),
      compileAsync: vi.fn(() => new Promise<void>((res) => (finish = res))),
    };
    const mod = moduleSpy();
    const layer = new ModuleLayer('warm', mod, { rendererFactory: () => r, minZoom: 20 });
    layer.onAdd(map as unknown as MlMap, gl);
    const core = acquireCore(asMap(map), gl);
    const scene = core.createScene();
    const object = new Group();
    let ready = false;
    void core.warmUp(object, scene).then(() => (ready = true));
    expect(r.compileAsync).not.toHaveBeenCalled(); // GL is only touched during render

    layer.render(gl, frame()); // below minZoom: nothing drawn, but compiles still start
    expect(r.render).not.toHaveBeenCalled();
    expect(r.compileAsync).toHaveBeenCalledWith(object, expect.anything(), scene);
    expect(r.resetState).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    expect(ready).toBe(false);
    finish();
    await new Promise((res) => setTimeout(res, 0));
    expect(ready).toBe(true);
    releaseCore(asMap(map));
    layer.onRemove(map as unknown as MlMap, gl);
  });

  it('resolves warm-ups at once when the renderer cannot compile ahead', async () => {
    const map = fakeMap();
    const core = acquireCore(asMap(map), gl, () => fakeRenderer());
    await expect(core.warmUp(new Group(), core.createScene())).resolves.toBeUndefined();
    releaseCore(asMap(map));
  });

  it('skips frames during a globe transition and below minZoom', () => {
    const map = fakeMap(); // zoom 16
    const r = fakeRenderer();
    const mod = moduleSpy();
    const layer = new ModuleLayer('guarded', mod, { rendererFactory: () => r, minZoom: 17 });
    layer.onAdd(map as unknown as MlMap, gl);
    layer.render(gl, frame());
    expect(r.render).not.toHaveBeenCalled();
    layer.onRemove(map as unknown as MlMap, gl);

    const r2 = fakeRenderer();
    const layer2 = new ModuleLayer('globe', mod, { rendererFactory: () => r2 });
    layer2.onAdd(map as unknown as MlMap, gl);
    layer2.render(gl, frame(0.5));
    expect(r2.render).not.toHaveBeenCalled();
    layer2.render(gl, frame(0));
    expect(r2.render).toHaveBeenCalledTimes(1);
    layer2.onRemove(map as unknown as MlMap, gl);
  });

  it('re-syncs the module when a diffed setStyle keeps the layer', () => {
    const map = fakeMap();
    map.styleLayers.add('kept');
    const r = fakeRenderer();
    const mod = moduleSpy();
    const layer = new ModuleLayer('kept', mod, { rendererFactory: () => r });
    layer.onAdd(map as unknown as MlMap, gl);
    map.handlers.get('style.load')!();
    expect(mod.styleChanged).toHaveBeenCalledWith(true);
    expect(mod.onRemove).not.toHaveBeenCalled();
    expect(r.dispose).not.toHaveBeenCalled();
    layer.onRemove(map as unknown as MlMap, gl);
  });

  it('tears down when a full setStyle drops the layer without calling onRemove', () => {
    const map = fakeMap();
    const r = fakeRenderer();
    const mod = moduleSpy();
    const layer = new ModuleLayer('dropped', mod, { rendererFactory: () => r });
    layer.onAdd(map as unknown as MlMap, gl);
    map.handlers.get('style.load')!();
    expect(mod.styleChanged).toHaveBeenCalledWith(false);
    expect(mod.onRemove).toHaveBeenCalledTimes(1);
    expect(map.handlers.has('moveend')).toBe(false);
    expect(map.handlers.has('style.load')).toBe(false);
    expect(r.dispose).toHaveBeenCalledTimes(1);
    layer.onRemove(map as unknown as MlMap, gl);
    expect(mod.onRemove).toHaveBeenCalledTimes(1);
  });
  it('registers its module for theme changes while added', () => {
    const map = fakeMap();
    const mod = moduleSpy();
    const layer = new ModuleLayer('themed', mod, { rendererFactory: () => fakeRenderer() });
    layer.onAdd(map as unknown as MlMap, gl);
    setTheme(asMap(map), 'night');
    expect(mod.themeChanged).toHaveBeenCalledWith('night');
    layer.onRemove(map as unknown as MlMap, gl);
    setTheme(asMap(map), 'day');
    expect(mod.themeChanged).toHaveBeenCalledTimes(1);
  });

  it('tears down when a full setStyle re-adds a new layer under the same id (review #6)', () => {
    const map = fakeMap();
    const r = fakeRenderer();
    const mod = moduleSpy();
    const layer = new ModuleLayer('dup', mod, { rendererFactory: () => r });
    layer.onAdd(map as unknown as MlMap, gl);
    // The app's own style.load handler already added a *different* layer instance as 'dup'.
    const other = new ModuleLayer('dup', moduleSpy(), { rendererFactory: () => fakeRenderer() });
    (map as unknown as { getLayer: (id: string) => unknown }).getLayer = (id: string) =>
      id === 'dup' ? { id, implementation: other } : undefined;
    map.handlers.get('style.load')!();
    expect(mod.styleChanged).toHaveBeenCalledWith(false);
    expect(mod.onRemove).toHaveBeenCalledTimes(1);
  });
});

describe('wetness', () => {
  it('is shared map-wide and tells registered modules when it changes', () => {
    const map = fakeMap();
    const core = acquireCore(asMap(map), gl, () => fakeRenderer());
    const listener = { wetnessChanged: vi.fn() };
    core.register(listener);
    expect(core.wetness).toBe(0);
    core.setWetness(0.6);
    core.setWetness(0.6); // unchanged: no second call
    core.setWetness(3); // clamped
    expect(listener.wetnessChanged.mock.calls).toEqual([[0.6], [1]]);
    expect(core.wetness).toBe(1);
    releaseCore(asMap(map));
  });
});
