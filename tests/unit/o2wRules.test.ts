import { describe, expect, it } from 'vitest';
import { measure, o2wHeights } from '../../demo/o2wRules';

describe('OSM2World height rules', () => {
  it('reads OSM measures', () => {
    expect(measure('12')).toBe(12);
    expect(measure('3,5')).toBe(3.5);
    expect(measure('12.5 m')).toBe(12.5);
    expect(measure("10'")).toBeCloseTo(3.048);
    expect(measure('tall')).toBeUndefined();
  });

  it('keeps a tagged roof inside a tagged height', () => {
    const h = o2wHeights(
      { building: 'yes', height: '20', 'roof:shape': 'gabled', 'roof:height': '4' },
      undefined,
      30,
    );
    expect(h).toMatchObject({ height: 20, wallTop: 16, roofHeight: 4 });
  });

  it('stacks levels at 2.5 m with roof levels on top', () => {
    const h = o2wHeights(
      {
        building: 'apartments',
        'building:levels': '6',
        'roof:levels': '1',
        'roof:shape': 'mansard',
      },
      undefined,
      30,
    );
    expect(h).toMatchObject({ levels: 6, roofHeight: 2.5, wallTop: 15, height: 17.5 });
  });

  it('defaults a pitched roof to a 5 m ridge, 1 m on one level, half the span for domes', () => {
    expect(o2wHeights({ building: 'yes', 'roof:shape': 'hipped' }, undefined, 20)).toMatchObject({
      levels: 3,
      roofHeight: 5,
      height: 12.5,
    });
    expect(o2wHeights({ building: 'shed', 'roof:shape': 'gabled' }, undefined, 8).roofHeight).toBe(
      1,
    );
    expect(o2wHeights({ building: 'yes', 'roof:shape': 'dome' }, undefined, 16).roofHeight).toBe(8);
  });

  it('lets a part without heights take its building’s', () => {
    const h = o2wHeights(
      { 'building:part': 'yes', 'roof:shape': 'flat' },
      { building: 'yes', 'building:levels': '4' },
      10,
    );
    expect(h).toMatchObject({ levels: 4, height: 10, roofHeight: 0 });
  });

  it('raises the base by building:min_level', () => {
    const h = o2wHeights(
      { 'building:part': 'yes', height: '20', 'building:levels': '5', 'building:min_level': '2' },
      undefined,
      10,
    );
    expect(h.minHeight).toBe(8);
  });
});
