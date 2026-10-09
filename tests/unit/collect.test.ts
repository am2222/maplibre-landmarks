import { describe, expect, it } from 'vitest';
import { PointIndex } from '../../src/trees/collect';

const ring = (x: number, y: number, d = 0.001) => [
  [x, y],
  [x + d, y],
  [x + d, y + d],
  [x, y + d],
  [x, y],
];

describe('PointIndex', () => {
  it('counts only points inside the pieces', () => {
    const index = new PointIndex([
      { key: 'a', lngLat: [2.2905, 48.8505] },
      { key: 'b', lngLat: [2.2915, 48.8505] },
      { key: 'c', lngLat: [2.2995, 48.8595] },
    ]);
    expect(index.countInside([[ring(2.29, 48.85)]])).toBe(1);
    expect(index.countInside([[ring(2.29, 48.85)], [ring(2.291, 48.85)]])).toBe(2);
  });
});
