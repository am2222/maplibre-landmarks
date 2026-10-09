import { describe, expect, it } from 'vitest';
import { Color, ShaderLib } from 'three';
import { THEMES } from '../../src/core/theme';
import { createTreeMaterial, windVector } from '../../src/trees/material';

describe('windVector', () => {
  it('points downwind in local XZ (X east, Z south)', () => {
    const [x1, z1] = windVector(270); // westerly blows east
    expect(x1).toBeCloseTo(1, 6);
    expect(z1).toBeCloseTo(0, 6);
    const [x2, z2] = windVector(0); // northerly blows south (+Z)
    expect(x2).toBeCloseTo(0, 6);
    expect(z2).toBeCloseTo(1, 6);
  });
});

describe('createTreeMaterial', () => {
  it('patches the standard shader with wind and palette colouring', () => {
    const { material, uniforms } = createTreeMaterial();
    const shader = {
      vertexShader: ShaderLib.physical.vertexShader,
      fragmentShader: ShaderLib.physical.fragmentShader,
      uniforms: {} as Record<string, unknown>,
    };
    material.onBeforeCompile(shader as never, {} as never);
    expect(shader.vertexShader).not.toContain('#include <project_vertex>');
    expect(shader.vertexShader).toContain('mvPosition = instanceMatrix * mvPosition');
    expect(shader.vertexShader).toContain('uWindDir');
    expect(shader.vertexShader).toContain('attribute float aTint');
    expect(shader.vertexShader).toContain('attribute float aPhase');
    expect(shader.vertexShader).toContain('attribute float aBorn');
    expect(shader.vertexShader).toContain('transformed * ( uGrow * risen * kept )');
    expect(shader.uniforms.uRise).toBe(uniforms.uRise);
    expect(shader.vertexShader).not.toContain('dot( treeOrigin.xz');
    expect(shader.fragmentShader).toContain('mix( uTrunk, foliageCol, vPart )');
    expect(shader.uniforms.uTime).toBe(uniforms.uTime);
    expect(material.customProgramCacheKey()).toBe('trees-v4');
    expect(material.userData.treeUniforms).toBe(uniforms);
  });

  it('patches in seasons: leaf drop, seasonal colours and snow', () => {
    const { material, uniforms } = createTreeMaterial();
    const shader = {
      vertexShader: ShaderLib.physical.vertexShader,
      fragmentShader: ShaderLib.physical.fragmentShader,
      uniforms: {} as Record<string, unknown>,
    };
    material.onBeforeCompile(shader as never, {} as never);
    // Leaf drop happens before the wind and placement read `transformed`.
    const v = shader.vertexShader;
    expect(v.indexOf('transformed = mix( aClump.xyz')).toBeGreaterThan(-1);
    expect(v.indexOf('transformed = mix( aClump.xyz')).toBeLessThan(v.indexOf('uGrow * risen'));
    expect(v).toContain('attribute vec4 aClump');
    expect(v).toContain('attribute float aLeaf');
    expect(shader.fragmentShader).toContain('uniform vec3 uAutumn[5]');
    expect(shader.fragmentShader).toContain('uSnowColor, vSnow');
    expect(shader.uniforms.uSeason).toBe(uniforms.uSeason);
    expect(shader.uniforms.uSnow).toBe(uniforms.uSnow);
    expect(uniforms.uAutumn.value).toHaveLength(5);
  });

  it('scales seasonal colours by the theme against the day foliage', () => {
    const { uniforms, setTheme } = createTreeMaterial();
    expect(uniforms.uThemeRatio.value.toArray()).toEqual([1, 1, 1]);
    setTheme('dusk');
    const dusk = new Color(THEMES.dusk.palette.foliage);
    const day = new Color(THEMES.day.palette.foliage);
    expect(uniforms.uThemeRatio.value.x).toBeCloseTo(dusk.r / day.r, 6);
    expect(uniforms.uThemeRatio.value.z).toBeCloseTo(dusk.b / day.b, 6);
  });

  it('applies theme palettes and wind', () => {
    const { uniforms, setTheme, setWind } = createTreeMaterial();
    setTheme('night');
    expect(uniforms.uFoliage.value.equals(new Color(THEMES.night.palette.foliage))).toBe(true);
    expect(uniforms.uTrunk.value.equals(new Color(THEMES.night.palette.trunk))).toBe(true);
    expect(uniforms.uFoliageJitter.value).toBe(THEMES.night.palette.foliageJitter);
    setWind(1.5, 270);
    expect(uniforms.uWindStrength.value).toBe(1.5);
    expect(uniforms.uWindDir.value.x).toBeCloseTo(1, 6);
  });
});
