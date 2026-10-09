import { describe, expect, it, vi } from 'vitest';
import type { Map as MlMap, SkySpecification } from 'maplibre-gl';
import { THEME_NAMES, themeSky } from '../../src/core/theme';
import { acquireCore, releaseCore, setTheme, type RendererLike } from '../../src/core/ThreeCore';

const gl = {} as WebGL2RenderingContext;
const renderer = () =>
  ({ resetState: vi.fn(), render: vi.fn(), dispose: vi.fn() }) satisfies RendererLike;

function skyMap() {
  const map = {
    sky: undefined as SkySpecification | undefined,
    getSky: () => map.sky,
    setSky: vi.fn((s: SkySpecification) => (map.sky = s)),
    getCanvas: () => ({}) as HTMLCanvasElement,
    on: vi.fn(),
    off: vi.fn(),
    triggerRepaint: vi.fn(),
  };
  return map;
}
const asMap = (m: object) => m as unknown as MlMap;

describe('theme sky', () => {
  it('gives every theme sky, horizon and fog colours and a globe atmosphere', () => {
    for (const t of THEME_NAMES) {
      const sky = themeSky(t);
      expect(sky['sky-color']).toMatch(/^#[0-9a-f]{6}$/);
      expect(sky['horizon-color']).toMatch(/^#[0-9a-f]{6}$/);
      expect(sky['fog-color']).toMatch(/^#[0-9a-f]{6}$/);
      expect(sky['atmosphere-blend']).toBeDefined();
    }
    expect(themeSky('night')['sky-color']).not.toBe(themeSky('day')['sky-color']);
  });

  it('leaves the sky alone unless asked', () => {
    const map = skyMap();
    setTheme(asMap(map), 'dusk');
    expect(map.setSky).not.toHaveBeenCalled();
  });

  it('applies the theme sky before layers hear about the theme (the fog haze builds on it)', () => {
    const map = skyMap();
    const core = acquireCore(asMap(map), gl, renderer);
    const seen: (SkySpecification | undefined)[] = [];
    core.register({ themeChanged: () => seen.push(map.getSky()) });
    setTheme(asMap(map), 'night', { sky: true });
    expect(map.setSky).toHaveBeenCalledWith(themeSky('night'));
    expect(seen).toEqual([themeSky('night')]);
    releaseCore(asMap(map));
  });

  it('applies the sky even before any layer created the 3D core', () => {
    const map = skyMap();
    setTheme(asMap(map), 'dawn', { sky: true });
    expect(map.sky).toEqual(themeSky('dawn'));
  });
});
