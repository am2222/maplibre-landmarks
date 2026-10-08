import { describe, expect, it } from 'vitest';
import { scaleBy, unscaleBy } from '../../src/core/expressions';

describe('scaleBy', () => {
  const k = ['k'];

  it('scales zoom curves per stop, keeping the curve top-level', () => {
    expect(scaleBy(['interpolate', ['linear'], ['zoom'], 15, 0, 16, ['get', 'h']], k)).toEqual([
      'interpolate',
      ['linear'],
      ['zoom'],
      15,
      ['*', 0, k],
      16,
      ['*', ['get', 'h'], k],
    ]);
    expect(scaleBy(['step', ['zoom'], 0, 14, ['get', 'h']], k)).toEqual([
      'step',
      ['zoom'],
      ['*', 0, k],
      14,
      ['*', ['get', 'h'], k],
    ]);
  });

  it('multiplies numbers and ordinary expressions', () => {
    expect(scaleBy(0.5, k)).toEqual(['*', 0.5, k]);
    expect(scaleBy(['interpolate', ['linear'], ['get', 'x'], 0, 1], k)).toEqual([
      '*',
      ['interpolate', ['linear'], ['get', 'x'], 0, 1],
      k,
    ]);
  });

  it('unscaleBy recovers what scaleBy wrapped, and nothing else', () => {
    const values = [
      0.5,
      ['get', 'o'],
      ['interpolate', ['linear'], ['zoom'], 14, 0, 15, ['get', 'o']],
      ['step', ['zoom'], 0, 14, 1],
    ];
    for (const v of values) expect(unscaleBy(scaleBy(v, k), k)).toEqual(v);
    expect(unscaleBy(0.5, k)).toBeUndefined();
    expect(unscaleBy(['*', 0.5, ['other']], k)).toBeUndefined();
    expect(unscaleBy(['interpolate', ['linear'], ['zoom'], 14, 0, 15, 1], k)).toBeUndefined();
  });

  it('cannot wrap legacy function objects', () => {
    expect(scaleBy({ stops: [[15, 0]] }, k)).toBeUndefined();
  });
});
