import { describe, expect, it } from 'vitest';
import { farCutoffM, tileNearestM } from '../../src/core/cutoff';
import { view } from './helpers';

describe('farCutoffM', () => {
  const at = (zoom: number, pitch: number) => farCutoffM(view({ zoom, pitch, heightPx: 900 }));

  it('cuts nothing until the view is pitched past 45°', () => {
    expect(at(16, 0)).toBe(Infinity);
    expect(at(16, 45)).toBe(Infinity);
  });

  it('is about three screen heights of ground once pitched, halving per zoom in', () => {
    // 900 px at zoom 16, latitude 48.86 (512 px tiles): ~0.786 m per pixel.
    expect(at(16, 60)).toBeCloseTo(3 * 900 * 0.786, -1);
    expect(at(17, 70)).toBeCloseTo(at(16, 70) / 2, 6);
  });

  it('eases in between 45° and 60°', () => {
    expect(at(16, 50)).toBeGreaterThan(at(16, 60));
    expect(at(16, 55)).toBeLessThan(at(16, 50));
  });

  it('cuts nothing without a known screen height', () => {
    expect(farCutoffM(view({ zoom: 16, pitch: 70 }))).toBe(Infinity);
  });
});

describe('tileNearestM', () => {
  it('is 0 inside the tile and grows with distance outside it', () => {
    expect(tileNearestM('15/16592/11272', [2.2945, 48.8584])).toBe(0);
    // The view centre sits 0.82 into its tile, so 9.18 tiles (~804 m each) from this one.
    const far = tileNearestM('15/16602/11272', [2.2945, 48.8584]);
    expect(far).toBeGreaterThan(9.1 * 804);
    expect(far).toBeLessThan(9.3 * 804);
  });
});
