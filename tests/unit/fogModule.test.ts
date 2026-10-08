import { describe, expect, it, vi } from 'vitest';
import { Color, DoubleSide, PerspectiveCamera, Scene } from 'three';
import type { ModuleContext } from '../../src/core/LayerModule';
import { originAt } from '../../src/core/mercator';
import { FOG_COLORS } from '../../src/fog/colors';
import { FogModule } from '../../src/fog/FogModule';
import { view } from './helpers';

function fakeMap() {
  const handlers = new Map<string, (e?: unknown) => void>();
  const map = {
    handlers,
    sky: undefined as object | undefined,
    terrain: null as object | null,
    on: vi.fn((t: string, fn: (e?: unknown) => void) => handlers.set(t, fn)),
    off: vi.fn((t: string) => handlers.delete(t)),
    styleLoaded: true,
    isStyleLoaded: () => map.styleLoaded,
    getSky: () => map.sky,
    setSky: vi.fn((s?: object) => (map.sky = s)),
    getTerrain: () => map.terrain,
    elevation: 42 as number | null,
    queryTerrainElevation: () => map.elevation,
    getCenter: () => ({ lng: 2.2945, lat: 48.8584 }),
    getBounds: () => ({
      getWest: () => 2.28,
      getEast: () => 2.3,
      getSouth: () => 48.85,
      getNorth: () => 48.87,
    }),
  };
  return map;
}

function setup(options = {}) {
  const map = fakeMap();
  const scene = new Scene();
  const module = new FogModule(options);
  const requestRepaint = vi.fn();
  module.onAdd({ map, scene, core: { theme: 'day' }, requestRepaint } as unknown as ModuleContext);
  return { map, scene, module, requestRepaint };
}
const hex = (c: Color) => `#${c.getHexString()}`;

describe('FogModule', () => {
  it('adds a depth-tested, non-depth-writing slice mesh and tints the sky', () => {
    const { map, scene, module } = setup({ slices: 100 });
    expect(scene.children).toContain(module.mesh);
    const material = module.mesh!.material as {
      depthWrite: boolean;
      depthTest: boolean;
      transparent: boolean;
    };
    expect(material).toMatchObject({ depthWrite: false, depthTest: true, transparent: true });
    // Horizontal layers are seen from above and from below: no face culling.
    expect((module.mesh!.material as { side: number }).side).toBe(DoubleSide);
    expect(module.mesh!.geometry.getAttribute('aSlice').count).toBe(64 * 4); // clamped
    expect(hex(module.uniforms.uFogColor.value)).toBe(FOG_COLORS.day);
    expect(map.sky).toMatchObject({ 'fog-color': FOG_COLORS.day });
  });

  it('hides below minZoom and at zero density', () => {
    const { module } = setup({ minZoom: 14 });
    module.update(view({ zoom: 13 }));
    expect(module.mesh!.visible).toBe(false);
    module.update(view({ zoom: 16 }));
    expect(module.mesh!.visible).toBe(true);
    module.setDensity(0);
    expect(module.mesh!.visible).toBe(false);
    module.setDensity(0.9);
    expect(module.uniforms.uDensity.value).toBe(0.9);
    expect(module.mesh!.visible).toBe(true);
  });

  it('animates only with wind, wrapping time and scroll', () => {
    const { module } = setup({ wind: { speed: 10, direction: 90 } });
    expect(module.frame(1000)).toBe(true);
    expect(module.frame(1100)).toBe(true);
    expect(module.uniforms.uScroll.value.x).toBeCloseTo(1, 6); // 10 m/s east for 0.1 s
    for (let t = 1100; t < 1100 + 1e6; t += 100) module.frame(t); // 1000 s later
    expect(module.uniforms.uScroll.value.x).toBeLessThan(4096);
    expect(module.uniforms.uTime.value).toBeLessThan(1e4);
    module.setWind({ speed: 0 });
    expect(module.frame(1e7)).toBe(false);
  });

  it('follows the theme and the terrain, and anchors noise to the world', () => {
    const { map, module } = setup({ horizonHaze: true });
    module.themeChanged('night');
    expect(hex(module.uniforms.uFogColor.value)).toBe(FOG_COLORS.night);
    expect(map.sky).toMatchObject({ 'fog-color': FOG_COLORS.night });
    map.terrain = {};
    map.handlers.get('terrain')!();
    module.update(view());
    expect(module.uniforms.uTop.value).toBe(42 + 40); // valley floor + height
    module.place(originAt([2.2945, 48.8584]));
    expect(module.uniforms.uOrigin.value.x).toBeGreaterThanOrEqual(0);
    expect(module.uniforms.uOrigin.value.x).toBeLessThan(4096);
  });

  it('updates camera uniforms and the layer draw order right before drawing', () => {
    const { module } = setup({ radius: 500, slices: 8 });
    module.update(view());
    const camera = new PerspectiveCamera(50, 1, 1, 10000);
    camera.position.set(0, 800, 600);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    module.mesh!.onBeforeRender(
      null as never,
      null as never,
      camera,
      null as never,
      null as never,
      null as never,
    );
    expect(module.uniforms.uCamPos.value.toArray()).toEqual([0, 800, 600]);
    expect(module.uniforms.uRadius.value).toBe(500);
    const index = Array.from(module.mesh!.geometry.getIndex()!.array);
    const slice = module.mesh!.geometry.getAttribute('aSlice');
    expect(slice.getX(index[0]!)).toBe(0); // camera above the fog: bottom layer first
    expect(slice.getX(index.at(-1)!)).toBe(7);
  });

  it('stacks the layers from the ground to the soft top', () => {
    const { module } = setup({ slices: 8 });
    module.update(view());
    expect(module.uniforms.uStep.value).toBeCloseTo((40 + 14) / 8, 9);
    expect(module.uniforms.uAlt.value[0]).toBeCloseTo((40 + 14) / 16, 9);
    expect(module.uniforms.uAlt.value[7]).toBeCloseTo(54 - (40 + 14) / 16, 9);
  });

  it('removes its mesh and gives the sky back', () => {
    const { map, scene, module } = setup();
    module.onRemove();
    expect(scene.children).toHaveLength(0);
    expect(map.sky).toBeUndefined();
    expect(map.handlers.size).toBe(0);
  });

  it('does not touch the sky while a style is loading (setTheme during setStyle)', () => {
    const { map, module } = setup();
    map.styleLoaded = false;
    map.setSky.mockImplementation(() => {
      throw new Error('Style is not done loading.');
    });
    expect(() => module.themeChanged('dusk')).not.toThrow();
    expect(hex(module.uniforms.uFogColor.value)).toBe(FOG_COLORS.dusk);
    map.styleLoaded = true;
    map.setSky.mockImplementation((s?: object) => (map.sky = s));
    module.styleChanged(true);
    expect(map.sky).toMatchObject({ 'fog-color': FOG_COLORS.dusk });
  });

  it('refreshes the ground when terrain tiles arrive', () => {
    const { map, module } = setup();
    module.update(view());
    map.terrain = { source: 'dem' };
    map.handlers.get('sourcedata')!({ sourceId: 'dem' } as never);
    expect(module.uniforms.uTop.value).toBe(42 + 40);
  });

  it('repaints when it becomes visible again', () => {
    const { module, requestRepaint } = setup({ minZoom: 14 });
    module.update(view({ zoom: 13 }));
    requestRepaint.mockClear();
    module.update(view({ zoom: 15 }));
    expect(requestRepaint).toHaveBeenCalled();
  });

  it('flat maps: fog fills `height` metres above the ground plane, clipped at 0', () => {
    const { module } = setup();
    module.update(view());
    expect(module.uniforms.uTop.value).toBe(40);
    expect(module.uniforms.uClip.value).toBe(0);
    expect(module.uniforms.uSoft.value).toBeCloseTo(14, 9);
  });

  it('terrain: fog pools above the valley floor, without clipping, or up to an altitude', () => {
    const { map, module } = setup({ height: 300 });
    map.terrain = { source: 'dem' };
    module.update(view());
    expect(module.uniforms.uTop.value).toBe(342);
    expect(module.uniforms.uClip.value).toBeLessThan(-1e5);
    module.setAltitude(1500);
    expect(module.uniforms.uTop.value).toBe(1500);
    expect(module.uniforms.uSoft.value).toBeCloseTo(0.35 * (1500 - 42), 6);
    module.setAltitude(undefined);
    module.setHeight(100);
    expect(module.uniforms.uTop.value).toBe(142);
    map.elevation = null; // no DEM yet: fall back to the plain height
    module.update(view());
    expect(module.uniforms.uTop.value).toBe(100);
  });

  it('scales the noise cell with zoom and sets coverage', () => {
    const { module } = setup();
    module.update(view({ zoom: 13 }));
    expect(module.uniforms.uCell.value).toBe(1024);
    expect(module.uniforms.uPeriod.value).toBe(4);
    module.update(view({ zoom: 16 }));
    expect(module.uniforms.uCell.value).toBe(128);
    expect(module.uniforms.uCoverage.value).toBe(0.65);
    module.setCoverage(1.4);
    expect(module.uniforms.uCoverage.value).toBe(1);
  });

  it('widens the default radius with the camera distance', () => {
    const { module } = setup();
    const camera = new PerspectiveCamera(50, 1, 1, 100000);
    camera.position.set(0, 8000, 6000); // 10 km from the centre
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    module.mesh!.onBeforeRender(
      null as never,
      null as never,
      camera,
      null as never,
      null as never,
      null as never,
    );
    expect(module.uniforms.uRadius.value).toBeCloseTo(15000, 6);
  });

  it('reaches the farthest visible ground (view bounds), not just around the camera', () => {
    const { module } = setup();
    // ~35 km to the north-east corner, as in a low pitched view up a valley.
    module.update(view({ center: [6.735, 45.925], bounds: [6.7, 45.9, 7.1, 46.2] }));
    const camera = new PerspectiveCamera(50, 1, 1, 100000);
    camera.position.set(0, 800, 600);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    module.mesh!.onBeforeRender(
      null as never,
      null as never,
      camera,
      null as never,
      null as never,
      null as never,
    );
    const corner = Math.hypot(
      (7.1 - 6.735) * 111_195 * Math.cos((45.925 * Math.PI) / 180),
      (46.2 - 45.925) * 111_195,
    );
    expect(module.uniforms.uRadius.value).toBeGreaterThanOrEqual(corner * 0.99);
  });
});
