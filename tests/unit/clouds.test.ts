import { describe, expect, it, vi } from 'vitest';
import { Color, DoubleSide, PerspectiveCamera, Scene } from 'three';
import type { ModuleContext } from '../../src/core/LayerModule';
import { originAt } from '../../src/core/mercator';
import { THEMES } from '../../src/core/theme';
import {
  CLOUD_CELL_M,
  CLOUD_PERIOD_CELLS,
  cloudColors,
  cloudNoiseOrigin,
  CloudsModule,
  deckFade,
} from '../../src/clouds/CloudsModule';
import { view } from './helpers';

function setup(options = {}, terrain = false) {
  const map = {
    getTerrain: () => (terrain ? { source: 'dem' } : null),
    queryTerrainElevation: () => 300,
  };
  const scene = new Scene();
  const requestRepaint = vi.fn();
  const module = new CloudsModule(options);
  module.onAdd({ map, scene, core: { theme: 'day' }, requestRepaint } as unknown as ModuleContext);
  return { map, scene, module, requestRepaint };
}

/** Render-time camera hook, as three calls it. */
const renderFrom = (module: CloudsModule, scene: Scene, y: number) => {
  const camera = new PerspectiveCamera(36, 1.5, 1, 1e5);
  camera.position.set(0, y, y);
  camera.updateMatrixWorld();
  module.shadow!.onBeforeRender(
    null as never,
    scene,
    camera,
    null as never,
    null as never,
    null as never,
  );
};

describe('cloudNoiseOrigin', () => {
  it('wraps into the cloud noise period and is stable across nearby origins', () => {
    const period = CLOUD_CELL_M * CLOUD_PERIOD_CELLS;
    const [x, z, scale] = cloudNoiseOrigin(originAt([2.2945, 48.8584]));
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThan(period);
    expect(z).toBeLessThan(period);
    // Ground metres → equator metres: 1 / cos(latitude).
    expect(scale).toBeCloseTo(1 / Math.cos((48.8584 * Math.PI) / 180), 3);
    // 100 m east, in noise metres, is 100 × scale further on (unless it wrapped).
    const [x2] = cloudNoiseOrigin(originAt([2.2945 + 100 / (111_320 * Math.cos(0.8527)), 48.8584]));
    const d = (((x2 - x) % period) + period) % period;
    expect(d).toBeCloseTo(100 * scale, -1);
  });
});

describe('deckFade', () => {
  it('draws the whole deck from low cameras and none from the cloud base up', () => {
    expect(deckFade(300, 1500)).toBe(1);
    expect(deckFade(900, 1500)).toBe(1);
    expect(deckFade(1200, 1500)).toBeCloseTo(0.5, 6);
    expect(deckFade(1500, 1500)).toBe(0);
    expect(deckFade(10_000, 1500)).toBe(0);
  });
});

describe('cloudColors', () => {
  it('lights clouds brighter than their shaded undersides, and darker at night', () => {
    const lum = (c: Color) => c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
    const day = cloudColors('day');
    expect(lum(day.sky)).toBeGreaterThan(lum(day.shadow));
    expect(lum(cloudColors('night').sky)).toBeLessThan(lum(day.sky));
  });
});

describe('CloudsModule', () => {
  it('adds the shadows then the deck: premultiplied, depth tested, no depth writes', () => {
    const { scene, module } = setup();
    expect(scene.children).toEqual([module.shadow, module.deck]);
    expect(module.shadow!.renderOrder).toBeLessThan(module.deck!.renderOrder);
    expect(module.deck!.material).toMatchObject({
      depthTest: true,
      depthWrite: false,
      side: DoubleSide,
    });
    // The shadows darken whatever lies under the layer, buildings too.
    expect(module.shadow!.material.depthTest).toBe(false);
    expect(module.deck!.geometry.getAttribute('aFace').count).toBe(8);
  });

  it('applies the options and clamps them', () => {
    const u = setup({
      coverage: 3,
      density: 2,
      base: 800,
      thickness: 10,
      steps: 99,
      shadows: false,
    }).module.uniforms;
    expect(u.uCoverage.value).toBe(1);
    expect(u.uDensity.value).toBe(2);
    expect(u.uBase.value).toBe(800);
    expect(u.uTop.value).toBe(850); // at least 50 m deep
    expect(u.uSteps.value).toBe(32);
    expect(u.uShadow.value).toBe(0);
  });

  it('sits its altitudes on the ground under the map centre with terrain', () => {
    const { module } = setup({ base: 1000, thickness: 500 }, true);
    module.update(view({ zoom: 13 }));
    expect(module.uniforms.uGround.value).toBe(300);
    expect(module.uniforms.uBase.value).toBe(1300);
    expect(module.uniforms.uTop.value).toBe(1800);
    module.setAltitude(2000, 1000);
    expect(module.uniforms.uBase.value).toBe(2300);
    expect(module.uniforms.uTop.value).toBe(3300);
  });

  it('drifts downwind with the wind speed and stops animating in calm air', () => {
    const { module } = setup({ wind: { speed: 10, directionDeg: 270 } });
    module.place(originAt([0, 0])); // noise scale 1 at the equator
    module.frame(0);
    expect(module.frame(1000)).toBe(true);
    // A westerly blows toward +x: the noise is sampled at xz − scroll, so scroll moves +x.
    expect(module.uniforms.uScroll.value.x).toBeCloseTo(10 * 0.1, 3); // dt is capped at 0.1 s
    module.setWind({ speed: 0 });
    expect(module.frame(1100)).toBe(false);
  });

  it('takes the sun and colours from the theme', () => {
    const { module, requestRepaint } = setup();
    module.themeChanged('dusk');
    const u = module.uniforms;
    expect(u.uSunColor.value.equals(new Color(THEMES.dusk.sunColor))).toBe(true);
    expect(u.uSunDir.value.length()).toBeCloseTo(1, 6);
    expect(u.uSkyColor.value.equals(cloudColors('dusk').sky)).toBe(true);
    expect(requestRepaint).toHaveBeenCalled();
  });

  it('keeps the deck at every height by default (fly-through)', () => {
    const { module, scene } = setup({ base: 1500 });
    renderFrom(module, scene, 1900); // inside the deck
    expect(module.uniforms.uDeckFade.value).toBe(1);
    renderFrom(module, scene, 9000); // above it
    expect(module.uniforms.uDeckFade.value).toBe(1);
  });

  it('without fly-through, fades the deck out toward the cloud base, keeping the shadows', () => {
    const { module, scene } = setup({ base: 1500, flyThrough: false });
    renderFrom(module, scene, 400);
    expect(module.uniforms.uDeckFade.value).toBe(1);
    renderFrom(module, scene, 2000);
    expect(module.uniforms.uDeckFade.value).toBe(0);
    expect(module.shadow!.visible).toBe(true);
  });

  it('switches the shadows off and on', () => {
    const { module } = setup();
    module.setShadows(false);
    expect(module.shadow!.visible).toBe(false);
    module.setShadows(0.6);
    expect(module.shadow!.visible).toBe(true);
    expect(module.uniforms.uShadow.value).toBe(0.6);
  });

  it('cleans up', () => {
    const { module, scene } = setup();
    module.onRemove();
    expect(scene.children).toEqual([]);
    expect(module.deck).toBeUndefined();
  });
});
