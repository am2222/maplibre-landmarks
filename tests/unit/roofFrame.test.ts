import { describe, expect, it } from 'vitest';
import {
  convexHull,
  fromFrame,
  roofFrame,
  toFrame,
  type Vec2,
} from '../../src/roofs/geometry/frame';
import { MeshBuilder } from '../../src/roofs/geometry/mesh';

/** w × d rectangle centred at (cx, cz), rotated by `deg` (open ring). */
export function rect(w: number, d: number, deg = 0, cx = 0, cz = 0): Vec2[] {
  const r = (deg * Math.PI) / 180;
  return [
    [-w / 2, -d / 2],
    [w / 2, -d / 2],
    [w / 2, d / 2],
    [-w / 2, d / 2],
  ].map(([x, z]) => [
    cx + x! * Math.cos(r) - z! * Math.sin(r),
    cz + x! * Math.sin(r) + z! * Math.cos(r),
  ]) as Vec2[];
}

describe('roof frame', () => {
  it('builds a convex hull', () => {
    expect(
      convexHull([
        [0, 0],
        [2, 0],
        [1, 1],
        [2, 2],
        [0, 2],
      ]),
    ).toHaveLength(4);
  });

  it('puts the ridge axis on the long side of the oriented box', () => {
    const f = roofFrame(rect(40, 20, 30, 5, -3));
    expect(f.L).toBeCloseTo(20, 6);
    expect(f.W).toBeCloseTo(10, 6);
    const long: Vec2 = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)];
    expect(Math.abs(f.u[0] * long[0] + f.u[1] * long[1])).toBeCloseTo(1, 6);
    expect(f.origin[0]).toBeCloseTo(5, 6);
    expect(f.origin[1]).toBeCloseTo(-3, 6);
  });

  it('turns the ridge across with orientation, and faces v toward a direction', () => {
    const across = roofFrame(rect(40, 20), undefined, 'across');
    expect(across.L).toBeCloseTo(10, 6);
    expect(across.W).toBeCloseTo(20, 6);
    const east = roofFrame(rect(40, 20), 90);
    expect(east.v[0]).toBeCloseTo(1, 9);
    expect(east.v[1]).toBeCloseTo(0, 9);
    expect(east.W).toBeCloseTo(20, 6);
    const south = roofFrame(rect(40, 20), 180);
    expect(south.v[1]).toBeCloseTo(1, 9); // +z is south
  });

  it('round-trips frame coordinates', () => {
    const f = roofFrame(rect(30, 12, 17, 3, 4));
    const p: Vec2 = [7.5, -2.25];
    const back = fromFrame(f, toFrame(f, p));
    expect(back[0]).toBeCloseTo(p[0], 9);
    expect(back[1]).toBeCloseTo(p[1], 9);
  });
});

describe('MeshBuilder', () => {
  it('turns roof triangles to face up and skips degenerate ones', () => {
    const b = new MeshBuilder();
    b.triangle([0, 0, 0], [1, 0, 0], [0, 0, 1], [1, 0, 0], true); // clockwise from above
    b.triangle([0, 0, 0], [1, 0, 0], [2, 0, 0], [1, 0, 0]); // collinear
    const m = b.build();
    expect(m.positions).toHaveLength(9);
    expect(m.normals[1]).toBeCloseTo(1, 9);
    expect(m.colors.slice(0, 3)).toEqual([1, 0, 0]);
  });
});
