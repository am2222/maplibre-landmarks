import { describe, expect, it, vi } from 'vitest';
import { Haze, type SkyMap } from '../../src/fog/haze';

function fakeMap(sky?: object) {
  const map = {
    sky: sky as object | undefined,
    getSky: () => map.sky,
    setSky: vi.fn((s?: object) => (map.sky = s)),
  };
  return map;
}
const asSky = (m: ReturnType<typeof fakeMap>) => m as unknown as SkyMap;

describe('Haze', () => {
  it('tints the sky fog and restores the previous sky', () => {
    const map = fakeMap({ 'sky-color': '#88aaff' });
    const haze = new Haze(asSky(map));
    haze.apply('#dfe5ea');
    expect(map.sky).toEqual({
      'sky-color': '#88aaff',
      'fog-color': '#dfe5ea',
      'fog-ground-blend': 0.4,
      'horizon-fog-blend': 0.6,
    });
    haze.apply('#4e5873'); // theme change
    expect(map.sky).toMatchObject({ 'sky-color': '#88aaff', 'fog-color': '#4e5873' });
    haze.restore();
    // MapLibre's setSky only updates keys it is given: fog keys the original lacked are reset
    // to the style-spec defaults explicitly, or our tint would stay.
    expect(map.sky).toEqual({
      'fog-color': '#ffffff',
      'fog-ground-blend': 0.5,
      'horizon-fog-blend': 0.8,
      'sky-color': '#88aaff',
    });
  });

  it('leaves a sky the app changed meanwhile', () => {
    const map = fakeMap();
    const haze = new Haze(asSky(map));
    haze.apply('#dfe5ea');
    map.sky = { 'fog-color': '#000000' };
    map.setSky.mockClear();
    haze.restore();
    expect(map.setSky).not.toHaveBeenCalled();
  });

  it('builds on a sky the app changed before the next tint, and reset forgets', () => {
    const map = fakeMap();
    const haze = new Haze(asSky(map));
    haze.apply('#dfe5ea');
    map.sky = { 'sky-color': '#123456' };
    haze.apply('#efd4c4');
    expect(map.sky).toMatchObject({ 'sky-color': '#123456', 'fog-color': '#efd4c4' });
    map.setSky.mockClear();
    haze.reset();
    haze.restore();
    expect(map.setSky).not.toHaveBeenCalled();
  });
});
