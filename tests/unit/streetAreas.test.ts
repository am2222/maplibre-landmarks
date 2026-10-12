import { describe, expect, it } from 'vitest';
import { MeshBuilder } from '../../src/roofs/geometry/mesh';
import { basin, slab, strip, type Vec2 } from '../../src/street/areas';

const square = (s: number, x = 0, z = 0): Vec2[] => [
  [x, z],
  [x + s, z],
  [x + s, z + s],
  [x, z + s],
];
const ys = (p: number[]) => p.filter((_, i) => i % 3 === 1);
/** Area of the triangles lying flat at height `y`. */
const flatArea = (p: number[], y: number) => {
  let area = 0;
  for (let i = 0; i < p.length; i += 9) {
    if ([p[i + 1], p[i + 4], p[i + 7]].some((v) => Math.abs(v! - y) > 1e-9)) continue;
    const [ax, az, bx, bz, cx, cz] = [p[i]!, p[i + 2]!, p[i + 3]!, p[i + 5]!, p[i + 6]!, p[i + 8]!];
    area += Math.abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) / 2;
  }
  return area;
};

describe('street areas', () => {
  it('raises a slab from the ground to its top, holes left open', () => {
    const b = new MeshBuilder();
    slab(b, [square(10), square(2, 4, 4)], 0.9, [0.5, 0.5, 0.5]);
    const p = b.build().positions;
    expect(Math.min(...ys(p))).toBe(0);
    expect(Math.max(...ys(p))).toBeCloseTo(0.9, 9);
    expect(flatArea(p, 0.9)).toBeCloseTo(100 - 4, 6);
  });

  it('builds a basin: a rim of its height around water a little below it', () => {
    const b = new MeshBuilder();
    basin(b, [square(6)], 0.5, 0.4, [0.6, 0.6, 0.6], [0.2, 0.4, 0.6]);
    const p = b.build().positions;
    expect(Math.max(...ys(p))).toBeCloseTo(0.5, 9);
    expect(flatArea(p, 0.4)).toBeCloseTo(36, 6);
  });

  it('widens a line into a deck of the given width', () => {
    const b = new MeshBuilder();
    strip(
      b,
      [
        [0, 0],
        [10, 0],
        [10, 10],
      ],
      3,
      0.6,
      [0.4, 0.3, 0.2],
    );
    const p = b.build().positions;
    expect(Math.max(...ys(p))).toBeCloseTo(0.6, 9);
    expect(flatArea(p, 0.6)).toBeCloseTo(2 * 10 * 3, 6);
    // Widened across each segment (1.5 m each side), not along it.
    const xs = p.filter((_, i) => i % 3 === 0);
    const zs = p.filter((_, i) => i % 3 === 2);
    expect(Math.min(...zs)).toBeCloseTo(-1.5, 6);
    expect(Math.min(...xs)).toBeCloseTo(0, 6);
    expect(Math.max(...xs)).toBeCloseTo(11.5, 6);
  });
});
