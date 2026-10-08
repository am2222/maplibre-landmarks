import { describe, expect, it } from 'vitest';
import { FLOW_CYCLE_S, TIME_PERIOD_S, WATER_FRAGMENT, WATER_VERTEX } from '../../src/water/shaders';

describe('water shaders', () => {
  it('declares the attributes and uniforms the module sets', () => {
    for (const a of ['float aShore', 'float aStyle', 'vec2 aFlow'])
      expect(WATER_VERTEX).toContain(a);
    for (const u of [
      'vec3 uDeep[4]',
      'vec3 uShallow[4]',
      'vec4 uWave[4]',
      'vec3 uSky',
      'vec3 uSunColor',
      'vec3 uSunDir',
      'vec2 uOrigin',
      'float uNoiseScale',
      'float uTime',
      'float uWaves',
      'float uRibbon',
    ])
      expect(WATER_FRAGMENT).toContain(`uniform ${u};`);
    expect(WATER_FRAGMENT).toContain('#include <colorspace_fragment>');
  });

  it('pulls depth toward the camera along the line of sight (terrain mesh error), not the screen position', () => {
    expect(WATER_VERTEX).toContain('normalize(cameraPosition - w.xyz)');
    expect(WATER_VERTEX).toContain('DEPTH_BIAS_M + DEPTH_BIAS_SHARE * d');
    // Shading still uses the true surface point.
    expect(WATER_VERTEX).toContain('vWorld = w.xyz;');
  });

  it('drifts rivers with two cross-faded phases, so the drift stays bounded (no shear over time)', () => {
    expect(TIME_PERIOD_S % FLOW_CYCLE_S).toBe(0); // phases restart cleanly at the time wrap
    expect(WATER_FRAGMENT).toContain('fract(uTime / FLOW_CYCLE)');
    expect(WATER_FRAGMENT).toContain('fract(uTime / FLOW_CYCLE + 0.5)');
    // No drift term that grows with the absolute time.
    expect(WATER_FRAGMENT).not.toContain('uTime * uNoiseScale');
  });

  it('calms waves far away (sub-pixel waves alias into moiré)', () => {
    expect(WATER_FRAGMENT).toContain('smoothstep(30.0 * w.x, 150.0 * w.x, dist)');
  });

  it('tiles with the noise frame and wraps time on whole wave cycles', () => {
    expect(TIME_PERIOD_S).toBe(2048);
    expect(WATER_FRAGMENT).toContain('const float PERIOD = 4096.0;');
    expect(WATER_FRAGMENT).toContain('const float TIME_PERIOD = 2048.0;');
  });
});
