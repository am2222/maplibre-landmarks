import { describe, expect, it, vi } from 'vitest';
import {
  Color,
  DoubleSide,
  Mesh,
  PerspectiveCamera,
  Scene,
  type MeshStandardMaterial,
} from 'three';
import type { ModuleContext } from '../../src/core/LayerModule';
import { SKY_COLORS } from '../../src/core/theme';
import {
  boltSegments,
  flashAt,
  nextStrikeIn,
  strikeLength,
  strikePulses,
} from '../../src/rain/lightning';
import { Overcast, overcastColors, type SkyMap } from '../../src/rain/overcast';
import { RainModule } from '../../src/rain/RainModule';
import { RoofsModule } from '../../src/roofs/RoofsModule';
import { view } from './helpers';

/** Deterministic numbers in [0, 1). */
function seeded(seed = 1) {
  let a = seed;
  return () => {
    a = (a * 16807) % 2147483647;
    return (a - 1) / 2147483646;
  };
}

describe('lightning', () => {
  it('flickers 1–3 times, the first pulse the brightest, and fades out', () => {
    const rand = seeded(3);
    for (let i = 0; i < 20; i++) {
      const pulses = strikePulses(rand);
      expect(pulses.length).toBeGreaterThanOrEqual(1);
      expect(pulses.length).toBeLessThanOrEqual(3);
      expect(pulses[0]).toEqual({ at: 0, amp: 1 });
      for (const p of pulses.slice(1)) expect(p.amp).toBeLessThan(1);
      expect(flashAt(pulses, 0)).toBe(1);
      expect(flashAt(pulses, strikeLength(pulses))).toBeLessThan(0.01);
    }
    expect(flashAt([{ at: 0.2, amp: 1 }], 0.1)).toBe(0);
  });

  it('spaces strikes around the mean, never closer than a fifth of it', () => {
    const rand = seeded(7);
    const gaps = Array.from({ length: 2000 }, () => nextStrikeIn(10, rand));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(2);
    const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    expect(mean).toBeGreaterThan(8.5);
    expect(mean).toBeLessThan(11.5);
  });

  it('draws a connected bolt from the cloud to the ground', () => {
    const rand = seeded(11);
    const top: [number, number, number] = [100, 1000, -50];
    const ground: [number, number, number] = [120, 0, -40];
    const segments = boltSegments(top, ground, rand);
    expect(segments[0]![0]).toEqual(top);
    // The main channel is continuous and ends exactly on the ground point.
    let i = 0;
    while (i + 1 < segments.length && segments[i]![1] === segments[i + 1]![0]) i++;
    expect(segments[i]![1]).toEqual(ground);
    for (const [a, b] of segments) {
      expect(b[1]).toBeLessThan(a[1]); // always downward
      expect([...a, ...b].every(Number.isFinite)).toBe(true);
    }
  });
});

function fakeSky(sky?: object) {
  const map = {
    sky: sky as object | undefined,
    getSky: () => map.sky,
    setSky: vi.fn((s?: object) => (map.sky = s)),
  };
  return map;
}

describe('Overcast', () => {
  it('greys and darkens the theme sky, more with more rain, keeping night dark', () => {
    const lum = (hex: string) => {
      const c = new Color(hex);
      return c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
    };
    const sat = (hex: string) => new Color(hex).getHSL({ h: 0, s: 0, l: 0 }).s;
    const light = overcastColors('day', 0.4)['sky-color'];
    const heavy = overcastColors('day', 1)['sky-color'];
    expect(sat(heavy)).toBeLessThan(sat(light));
    expect(sat(light)).toBeLessThan(sat(SKY_COLORS.day.sky));
    expect(lum(heavy)).toBeLessThan(lum(SKY_COLORS.day.sky));
    expect(lum(overcastColors('night', 1)['sky-color'])).toBeLessThan(lum(heavy));
  });

  it('restores the previous sky, resetting keys it lacked', () => {
    const map = fakeSky({ 'sky-color': '#123456', 'atmosphere-blend': 0.5 });
    const o = new Overcast(map as unknown as SkyMap);
    o.apply('day', 1);
    expect(map.sky).toMatchObject({ 'atmosphere-blend': 0.5 });
    expect((map.sky as Record<string, string>)['sky-color']).not.toBe('#123456');
    o.restore();
    expect(map.sky).toEqual({
      'sky-color': '#123456',
      'horizon-color': '#ffffff',
      'fog-color': '#ffffff',
      'atmosphere-blend': 0.5,
    });
  });

  it('leaves a sky the app changed meanwhile', () => {
    const map = fakeSky();
    const o = new Overcast(map as unknown as SkyMap);
    o.apply('day', 1);
    map.sky = { 'sky-color': '#ff0000' };
    o.restore();
    expect(map.sky).toEqual({ 'sky-color': '#ff0000' });
  });
});

function setupRain(options = {}) {
  const map = {
    sky: undefined as object | undefined,
    getSky: () => map.sky,
    setSky: vi.fn((s?: object) => (map.sky = s)),
    isStyleLoaded: () => true,
    getTerrain: () => null,
    queryTerrainElevation: () => 0,
  };
  const scene = new Scene();
  const core = { theme: 'day', wetness: 0, setWetness: vi.fn((w: number) => (core.wetness = w)) };
  const requestRepaint = vi.fn();
  const module = new RainModule({ random: seeded(5), maxDrops: 1000, ...options });
  module.onAdd({ map, scene, core, requestRepaint } as unknown as ModuleContext);
  return { map, scene, core, module, requestRepaint };
}

describe('RainModule', () => {
  it('adds the overcast, the rain and a hidden bolt, in that draw order', () => {
    const { scene, module } = setupRain();
    expect(scene.children).toEqual([module.overlay, module.rain, module.bolt]);
    expect(module.overlay!.renderOrder).toBeLessThan(module.rain!.renderOrder);
    expect(module.rain!.material).toMatchObject({ depthWrite: false, transparent: true });
    expect(module.rain!.material.side).toBe(DoubleSide);
    expect(module.overlay!.material.depthTest).toBe(false);
    expect(module.bolt!.visible).toBe(false);
  });

  it('scales drops, opacity and darkness with intensity; 0 stops the rain', () => {
    const { module, requestRepaint } = setupRain({ intensity: 1 });
    expect(module.getStats().drops).toBe(1000);
    expect(module.rain!.geometry.drawRange.count).toBe(6000);
    const darken = () => module.overlay!.material.uniforms.uDarken!.value as number;
    expect(darken()).toBeCloseTo(0.45, 6);
    module.setIntensity(0.5);
    expect(module.getStats().drops).toBe(Math.round(1000 * (0.15 + 0.85 * 0.5)));
    expect(darken()).toBeCloseTo(0.225, 6);
    expect(requestRepaint).toHaveBeenCalled();
    module.setIntensity(0);
    expect(module.getStats().drops).toBe(0);
    expect(module.rain!.visible).toBe(false);
    expect(module.overlay!.visible).toBe(false);
    expect(module.frame(1000)).toBe(false);
  });

  it('greys the sky while it rains and restores it when removed', () => {
    const { map, module } = setupRain();
    expect(map.sky).toMatchObject(overcastColors('day', 0.4 + 0.6 * 0.7));
    module.themeChanged('night');
    expect(map.sky).toMatchObject(overcastColors('night', 0.4 + 0.6 * 0.7));
    module.onRemove();
    expect(map.sky).toBeUndefined();
  });

  it('wets the map while it rains and dries it when removed (unless wet is off)', () => {
    const { core, module } = setupRain({ intensity: 0.8 });
    expect(core.wetness).toBe(0.8);
    module.onRemove();
    expect(core.wetness).toBe(0);
    expect(setupRain({ wet: false }).core.setWetness).not.toHaveBeenCalled();
  });

  it('slants with the wind, downwind', () => {
    const { module } = setupRain({ wind: { strength: 0 } });
    const [x, y, z] = module.uniforms.uDir.value.toArray();
    expect([Math.abs(x), y, Math.abs(z)]).toEqual([0, -1, 0]);
    module.setWind({ strength: 1, directionDeg: 270 }); // westerly: falls toward the east (+x)
    const d = module.uniforms.uDir.value;
    expect(d.x).toBeGreaterThan(0.3);
    expect(d.y).toBeLessThan(-0.9);
    expect(Math.abs(d.z)).toBeLessThan(1e-9);
  });

  it('falls each frame, keeping the offset small', () => {
    const { module } = setupRain({ wind: { strength: 0 } });
    module.frame(0);
    expect(module.frame(100)).toBe(true);
    const fall = module.uniforms.uFall.value;
    expect(fall.y).toBeGreaterThan(0); // the drops' positions move down by this much
    for (let t = 200; t < 200_000; t += 100) module.frame(t);
    expect(Math.abs(fall.y)).toBeLessThan(1e5);
  });

  it('strikes on its own, flashing and fading, with lightning on', () => {
    const { module } = setupRain({ lightning: { intervalS: 1, bolts: 1 } });
    let peak = 0;
    for (let t = 0; t < 10_000; t += 16) {
      module.frame(t);
      peak = Math.max(peak, module.getStats().flash);
    }
    expect(module.getStats().strikes).toBeGreaterThan(3);
    expect(peak).toBeGreaterThan(0.5);
  });

  it('never strikes by itself with lightning off, but strike() still flashes', () => {
    const { module, scene } = setupRain({ lightning: false });
    for (let t = 0; t < 60_000; t += 100) module.frame(t);
    expect(module.getStats().strikes).toBe(0);
    // Place the camera so the bolt has somewhere to go.
    const camera = new PerspectiveCamera(36, 1.5, 1, 1e5);
    camera.position.set(0, 400, 600);
    camera.updateMatrixWorld();
    module.rain!.onBeforeRender(
      null as never,
      scene,
      camera,
      null as never,
      null as never,
      null as never,
    );
    module.frame(60_000);
    module.strike();
    module.frame(60_016);
    expect(module.getStats().strikes).toBe(1);
    expect(module.getStats().flash).toBeGreaterThan(0.5);
    expect(module.bolt!.visible).toBe(true);
    expect(module.bolt!.geometry.getAttribute('position').count).toBeGreaterThan(0);
    for (let t = 60_100; t < 62_000; t += 16) module.frame(t);
    expect(module.getStats().flash).toBe(0);
    expect(module.bolt!.visible).toBe(false);
  });

  it('sizes the rain box from the camera distance and keeps rain above flat ground', () => {
    const { module, scene } = setupRain();
    module.update(view({ zoom: 16 }));
    const camera = new PerspectiveCamera(36, 1.5, 1, 1e5);
    const box = (y: number) => {
      camera.position.set(0, y, y);
      camera.updateMatrixWorld();
      module.rain!.onBeforeRender(
        null as never,
        scene,
        camera,
        null as never,
        null as never,
        null as never,
      );
      return module.uniforms.uBoxSize.value;
    };
    expect(box(1000)).toBeGreaterThan(box(200));
    expect(module.uniforms.uGround.value).toBe(0);
  });
});

describe('wet roofs', () => {
  function roofs(wetness?: number) {
    const map = { on: vi.fn(), off: vi.fn(), getLayer: () => undefined, getTerrain: () => null };
    const scene = new Scene();
    const module = new RoofsModule({ source: 'b', extrusionLayer: 'b3d', onError: vi.fn() });
    module.onAdd({
      map,
      scene,
      core: { wetness },
      requestRepaint: vi.fn(),
    } as unknown as ModuleContext);
    const material = (scene.children[0] as Mesh).material as MeshStandardMaterial;
    return { module, material };
  }

  it('turn darker and glossier with the rain, and dry again', () => {
    const { module, material } = roofs();
    expect(material.roughness).toBe(0.9);
    module.wetnessChanged(1);
    expect(material.roughness).toBeCloseTo(0.35, 6);
    expect(material.color.r).toBeCloseTo(0.7, 6);
    module.wetnessChanged(0);
    expect(material.roughness).toBe(0.9);
    expect(material.color.r).toBe(1);
  });

  it('start wet when added during rain', () => {
    expect(roofs(1).material.roughness).toBeCloseTo(0.35, 6);
  });
});
