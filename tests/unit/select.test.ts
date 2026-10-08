import { describe, expect, it } from 'vitest';
import { pickModel, selectTrees, type Candidate } from '../../src/trees/select';

const C: [number, number] = [2.29, 48.85];
const M = 111_195;
const kx = M * Math.cos((C[1] * Math.PI) / 180);
const east = (key: string, m: number): Candidate => ({ key, lngLat: [C[0] + m / kx, C[1]] });
const opts = { maxTrees: 3, lodDistanceM: 100, weights: [1], variants: [4] };

describe('pickModel', () => {
  it('follows cumulative weights and treats zero weights as uniform', () => {
    expect(pickModel([0.6, 0.2, 0.2], 0.1)).toBe(0);
    expect(pickModel([0.6, 0.2, 0.2], 0.7)).toBe(1);
    expect(pickModel([0.6, 0.2, 0.2], 0.95)).toBe(2);
    expect(pickModel([0, 0], 0.7)).toBe(1);
  });
});

describe('selectTrees', () => {
  it('keeps the nearest trees and marks far ones', () => {
    const trees = selectTrees(
      [east('d', 300), east('a', 10), east('c', 150), east('b', 90)],
      C,
      opts,
    );
    expect(trees.map((t) => t.key)).toEqual(['a', 'b', 'c']);
    expect(trees.map((t) => t.far)).toEqual([false, false, true]);
    expect(trees[1]!.distanceM).toBeCloseTo(90, 0);
  });

  it('gives a tree the same look regardless of order or neighbours', () => {
    const one = selectTrees([east('x', 20)], C, { ...opts, weights: [1, 1], variants: [4, 2] })[0]!;
    const two = selectTrees([east('y', 5), east('x', 20)], C, {
      ...opts,
      weights: [1, 1],
      variants: [4, 2],
    }).find((t) => t.key === 'x')!;
    expect({ ...two, distanceM: 0 }).toEqual({ ...one, distanceM: 0 });
  });

  it('keeps attributes in range', () => {
    const trees = selectTrees(
      Array.from({ length: 200 }, (_, i) => east(`k${i}`, i)),
      C,
      { maxTrees: 200, lodDistanceM: 1000, weights: [1, 1], variants: [4, 2] },
    );
    for (const t of trees) {
      expect(t.variant).toBeLessThan(t.model === 0 ? 4 : 2);
      expect(t.scale).toBeGreaterThanOrEqual(0.8);
      expect(t.scale).toBeLessThan(1.2);
      expect(t.rotation).toBeGreaterThanOrEqual(0);
      expect(t.rotation).toBeLessThan(2 * Math.PI);
      expect(t.tint).toBeGreaterThanOrEqual(0);
      expect(t.tint).toBeLessThan(1);
    }
  });

  it('distributes models by weight', () => {
    const trees = selectTrees(
      Array.from({ length: 10_000 }, (_, i) => east(`t:${i}`, 1)),
      C,
      { maxTrees: 10_000, lodDistanceM: 1000, weights: [0.6, 0.2, 0.2], variants: [1, 1, 1] },
    );
    const share = (m: number) => trees.filter((t) => t.model === m).length / trees.length;
    expect(Math.abs(share(0) - 0.6)).toBeLessThan(0.05);
    expect(Math.abs(share(1) - 0.2)).toBeLessThan(0.05);
  });
});
