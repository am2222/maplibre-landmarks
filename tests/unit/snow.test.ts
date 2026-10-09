import { describe, expect, it, vi } from 'vitest';
import { DoubleSide, Mesh, MeshStandardMaterial, PerspectiveCamera, Scene, ShaderLib } from 'three';
import type { ModuleContext } from '../../src/core/LayerModule';
import { withSnowCover } from '../../src/core/snowCover';
import { overcastColors, SNOW_CLOUD } from '../../src/rain/overcast';
import { RoofsModule } from '../../src/roofs/RoofsModule';
import { SnowModule } from '../../src/snow/SnowModule';

function setupSnow(options = {}) {
  const map = {
    sky: undefined as object | undefined,
    getSky: () => map.sky,
    setSky: vi.fn((s?: object) => (map.sky = s)),
    isStyleLoaded: () => true,
    getTerrain: () => null,
    queryTerrainElevation: () => 0,
  };
  const scene = new Scene();
  const core = {
    theme: 'day',
    snowCover: 0,
    setSnowCover: vi.fn((c: number) => (core.snowCover = c)),
  };
  const requestRepaint = vi.fn();
  const module = new SnowModule({ random: () => 0.5, maxFlakes: 1000, ...options });
  module.onAdd({ map, scene, core, requestRepaint } as unknown as ModuleContext);
  return { map, scene, core, module, requestRepaint };
}

describe('SnowModule', () => {
  it('adds the haze under double-sided, non-depth-writing flakes', () => {
    const { scene, module } = setupSnow();
    expect(scene.children).toEqual([module.overlay, module.snow]);
    expect(module.overlay!.renderOrder).toBeLessThan(module.snow!.renderOrder);
    expect(module.snow!.material).toMatchObject({ depthWrite: false, transparent: true });
    expect(module.snow!.material.side).toBe(DoubleSide);
  });

  it('scales flakes and haze with intensity; 0 stops the snow', () => {
    const { module } = setupSnow({ intensity: 1 });
    expect(module.getStats().flakes).toBe(1000);
    const haze = () => module.overlay!.material.uniforms.uFlash!.value as number;
    expect(haze()).toBeCloseTo(0.25, 6);
    // Mixes toward the haze colour: what it adds equals what it takes away.
    expect(module.overlay!.material.uniforms.uDarken!.value).toBe(haze());
    module.setIntensity(0);
    expect(module.getStats().flakes).toBe(0);
    expect(module.snow!.visible).toBe(false);
    expect(module.overlay!.visible).toBe(false);
  });

  it('greys the sky with lighter snow clouds and restores it when removed', () => {
    const { map, module } = setupSnow();
    expect(map.sky).toMatchObject(overcastColors('day', 0.5 + 0.5 * 0.6, SNOW_CLOUD));
    module.onRemove();
    expect(map.sky).toBeUndefined();
  });

  it('settles on roofs over `settle` seconds, then melts when it stops', () => {
    const { core, module } = setupSnow({ intensity: 1, settle: 10 });
    expect(core.snowCover).toBe(0);
    module.frame(0);
    for (let t = 100; t <= 5000; t += 100) module.frame(t);
    expect(core.snowCover).toBeCloseTo(0.5, 2);
    for (let t = 5100; t <= 12_000; t += 100) module.frame(t);
    expect(core.snowCover).toBe(1);
    module.setIntensity(0);
    expect(module.frame(12_100)).toBe(true); // still melting
    for (let t = 12_200; t <= 30_000; t += 100) module.frame(t);
    expect(core.snowCover).toBe(0);
    expect(module.frame(30_100)).toBe(false);
  });

  it('covers at once with settle 0, never with settle false, and clears on remove', () => {
    expect(setupSnow({ intensity: 0.7, settle: 0 }).core.snowCover).toBe(0.7);
    const off = setupSnow({ settle: false });
    for (let t = 0; t < 60_000; t += 100) off.module.frame(t);
    expect(off.core.setSnowCover).not.toHaveBeenCalled();
    const { core, module } = setupSnow({ intensity: 1, settle: 0 });
    module.onRemove();
    expect(core.snowCover).toBe(0);
  });

  it('drifts downwind and keeps its clock and offset small', () => {
    const { module, scene } = setupSnow({ wind: { strength: 1, directionDeg: 270 } });
    const camera = new PerspectiveCamera(36, 1.5, 1, 1e5);
    camera.position.set(0, 400, 400);
    camera.updateMatrixWorld();
    module.snow!.onBeforeRender(
      null as never,
      scene,
      camera,
      null as never,
      null as never,
      null as never,
    );
    module.frame(0);
    module.frame(100);
    const fall = module.uniforms.uFall.value;
    expect(fall.y).toBeGreaterThan(0); // positions move down by this much
    expect(fall.x).toBeLessThan(0); // and east (+x), downwind of a westerly
    for (let t = 200; t < 2_000_000; t += 1000) module.frame(t);
    expect(module.uniforms.uTime.value).toBeLessThan(2 * Math.PI * 100);
    expect(Math.abs(fall.y)).toBeLessThan(1e5);
  });
});

describe('snow cover on materials', () => {
  it('whitens upward faces by uSnowCover and keeps a distinct program', () => {
    const material = new MeshStandardMaterial();
    const uniform = { uSnowCover: { value: 0.5 } };
    withSnowCover(material, uniform);
    const shader = {
      vertexShader: ShaderLib.standard.vertexShader,
      fragmentShader: ShaderLib.standard.fragmentShader,
      uniforms: {} as Record<string, unknown>,
    };
    material.onBeforeCompile(shader as never, {} as never);
    expect(shader.uniforms.uSnowCover).toBe(uniform.uSnowCover);
    expect(shader.vertexShader).toContain('vSnowUp = objectNormal.y');
    expect(shader.fragmentShader).toContain('uSnowCover * smoothstep');
    expect(material.customProgramCacheKey()).toContain('snow-cover');
  });

  it('roofs follow the map-wide snow cover, from the moment they are added', () => {
    const map = { on: vi.fn(), off: vi.fn(), getLayer: () => undefined, getTerrain: () => null };
    const scene = new Scene();
    const module = new RoofsModule({ source: 'b', extrusionLayer: 'b3d', onError: vi.fn() });
    module.onAdd({
      map,
      scene,
      core: { snowCover: 0.4 },
      requestRepaint: vi.fn(),
    } as unknown as ModuleContext);
    const material = (scene.children[0] as Mesh).material as MeshStandardMaterial;
    const shader = {
      vertexShader: ShaderLib.standard.vertexShader,
      fragmentShader: ShaderLib.standard.fragmentShader,
      uniforms: {} as Record<string, { value: number }>,
    };
    material.onBeforeCompile(shader as never, {} as never);
    expect(shader.uniforms.uSnowCover!.value).toBe(0.4);
    module.snowCoverChanged(1);
    expect(shader.uniforms.uSnowCover!.value).toBe(1);
  });
});
