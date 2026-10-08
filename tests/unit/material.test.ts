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
    expect(shader.fragmentShader).toContain('mix(uTrunk, foliageCol, vPart)');
    expect(shader.uniforms.uTime).toBe(uniforms.uTime);
    expect(material.customProgramCacheKey()).toBe('trees-v1');
    expect(material.userData.treeUniforms).toBe(uniforms);
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
