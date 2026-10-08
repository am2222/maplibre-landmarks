import { describe, expect, it } from 'vitest';
import { pointInPolygons, pointInRing, polygonsOf } from '../../src/core/geometry';

const SQUARE = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
  [0, 0],
];
const HOLE = [
  [4, 4],
  [6, 4],
  [6, 6],
  [4, 6],
  [4, 4],
];

describe('geometry', () => {
  it('tests points against rings and polygons with holes', () => {
    expect(pointInRing([5, 5], SQUARE)).toBe(true);
    expect(pointInRing([15, 5], SQUARE)).toBe(false);
    expect(pointInPolygons([2, 2], [[SQUARE, HOLE]])).toBe(true);
    expect(pointInPolygons([5, 5], [[SQUARE, HOLE]])).toBe(false);
    expect(pointInPolygons([5, 5], [])).toBe(false);
  });

  it('normalises GeoJSON polygons', () => {
    expect(polygonsOf({ type: 'Polygon', coordinates: [SQUARE] })).toEqual([[SQUARE]]);
    expect(polygonsOf({ type: 'MultiPolygon', coordinates: [[SQUARE]] })).toEqual([[SQUARE]]);
    expect(polygonsOf({ type: 'Point', coordinates: [1, 2] })).toEqual([]);
    expect(polygonsOf(undefined)).toEqual([]);
  });
});
