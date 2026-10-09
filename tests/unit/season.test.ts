import { describe, expect, it } from 'vitest';
import { seasonAt, seasonValue, wrapSeason } from '../../src/trees/season';

describe('seasonValue', () => {
  it('maps names to 0 spring … 3 winter and wraps numbers', () => {
    expect(['spring', 'summer', 'autumn', 'winter'].map((s) => seasonValue(s as never))).toEqual([
      0, 1, 2, 3,
    ]);
    expect(seasonValue(5.5)).toBe(1.5);
    expect(seasonValue(-1)).toBe(3);
    expect(seasonValue(Number.NaN)).toBe(1);
    expect(seasonValue('auto')).toBeUndefined();
  });

  it('wraps into [0, 4)', () => {
    expect(wrapSeason(4)).toBe(0);
    expect(wrapSeason(-0.5)).toBe(3.5);
  });
});

describe('seasonAt', () => {
  const PARIS = 48.86;
  const at = (iso: string, lat = PARIS) => seasonAt(new Date(iso), lat);

  it('peaks mid-season in the north', () => {
    expect(at('2026-04-15T00:00:00Z')).toBeCloseTo(0, 1);
    expect(at('2026-07-15T00:00:00Z')).toBeCloseTo(1, 1);
    expect(at('2026-10-15T00:00:00Z')).toBeCloseTo(2, 1);
    expect(at('2027-01-15T00:00:00Z')).toBeCloseTo(3, 1);
  });

  it('is half a year on south of the equator', () => {
    expect(at('2026-07-15T00:00:00Z', -33.9)).toBeCloseTo(3, 1); // Sydney, July: winter
    expect(at('2026-01-15T00:00:00Z', -33.9)).toBeCloseTo(1, 1);
  });

  it('stays summer in the tropics', () => {
    expect(at('2026-01-15T00:00:00Z', 1.35)).toBe(1); // Singapore
  });
});
