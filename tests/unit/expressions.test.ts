import { describe, expect, it } from 'vitest';
import { mapOutputs, scaleBy, unmapOutputs, unscaleBy } from '../../src/core/expressions';

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

  it('mapOutputs applies to each zoom-curve output, or to the value itself', () => {
    const f = (o: unknown) => ['f', o];
    expect(mapOutputs(['step', ['zoom'], 1, 15, 2], f)).toEqual([
      'step',
      ['zoom'],
      ['f', 1],
      15,
      ['f', 2],
    ]);
    expect(mapOutputs(['interpolate', ['linear'], ['zoom'], 14, 0, 15, 3], f)).toEqual([
      'interpolate',
      ['linear'],
      ['zoom'],
      14,
      ['f', 0],
      15,
      ['f', 3],
    ]);
    expect(mapOutputs(5, f)).toEqual(['f', 5]);
  });

  it('unmapOutputs inverts recognised wrappers only', () => {
    const unf = (o: unknown) => (Array.isArray(o) && o[0] === 'f' ? o[1] : undefined);
    expect(unmapOutputs(['f', 5], unf)).toBe(5);
    expect(unmapOutputs(['step', ['zoom'], ['f', 1], 15, ['f', 2]], unf)).toEqual([
      'step',
      ['zoom'],
      1,
      15,
      2,
    ]);
    expect(unmapOutputs(['step', ['zoom'], ['f', 1], 15, 2], unf)).toBeUndefined();
    expect(unmapOutputs(5, unf)).toBeUndefined();
  });
});
