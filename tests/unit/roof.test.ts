import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../../src/roofs/geometry/frame';
import { buildRoof, resolveRoofHeight } from '../../src/roofs/geometry/roof';
import type { RoofProps } from '../../src/roofs/schema';

const rect = (w: number, d: number, cz = 0): Vec2[] => [
  [-w / 2, cz - d / 2],
  [w / 2, cz - d / 2],
  [w / 2, cz + d / 2],
  [-w / 2, cz + d / 2],
];
const props = (over: Partial<RoofProps> = {}): RoofProps => ({
  shape: 'gabled',
  height: 20,
  minHeight: 0,
  roofColor: '#ff0000',
  wallColor: '#cccccc',
  ...over,
});
const ys = (p: number[]) => p.filter((_, i) => i % 3 === 1);
const TAN_30 = Math.tan(Math.PI / 6);

describe('resolveRoofHeight', () => {
  const frame = { L: 20, W: 10 };
  it('keeps an explicit height up to the whole span (parts that are all roof)', () => {
    expect(resolveRoofHeight(props({ roofHeight: 6 }), frame)).toBe(6);
    expect(
      resolveRoofHeight(props({ shape: 'dome', minHeight: 40, height: 60, roofHeight: 30 }), frame),
    ).toBe(20);
  });

  it('defaults to a 30° pitch, or the radius for rounded roofs, capped at half the span', () => {
    expect(resolveRoofHeight(props(), frame)).toBeCloseTo(10 * TAN_30, 9);
    expect(resolveRoofHeight(props({ shape: 'dome' }), frame)).toBe(10);
    expect(resolveRoofHeight(props({ height: 4 }), frame)).toBe(2);
    expect(resolveRoofHeight(props({ height: 0.8 }), frame)).toBeNull();
  });

  it("derives the height from roof_angle over each shape's run; roof_height wins", () => {
    const tan = (deg: number) => Math.tan((deg * Math.PI) / 180);
    expect(resolveRoofHeight(props({ roofAngle: 45 }), frame)).toBeCloseTo(10, 9);
    expect(resolveRoofHeight(props({ shape: 'skillion', roofAngle: 20 }), frame)).toBeCloseTo(
      20 * tan(20),
      9,
    );
    expect(resolveRoofHeight(props({ roofAngle: 45, roofHeight: 3 }), frame)).toBe(3);
    expect(resolveRoofHeight(props({ roofAngle: 80 }), frame)).toBe(20);
    expect(resolveRoofHeight(props({ shape: 'dome', roofAngle: 10 }), frame)).toBe(10);
  });
});

describe('buildRoof', () => {
  it('builds a profile roof and reports its height', () => {
    const built = buildRoof(props(), [[rect(40, 20)]])!;
    expect(built.roofHeight).toBeCloseTo(10 * TAN_30, 9);
    expect(Math.max(...ys(built.mesh.positions))).toBeCloseTo(10 * TAN_30, 9);
  });

  it('domes and onions follow the outline: a half-round apse is covered, nothing hangs out', () => {
    const projected = (positions: number[]) => {
      let a = 0;
      for (let i = 0; i < positions.length; i += 9) {
        const [ax, , az, bx, , bz, cx, , cz] = positions.slice(i, i + 9) as number[];
        a += Math.abs((bx! - ax!) * (cz! - az!) - (cx! - ax!) * (bz! - az!)) / 2;
      }
      return a;
    };
    // Half disc of radius 10 (an apse): the flat side on z = 0, the round side to z > 0.
    const apse: Vec2[] = Array.from({ length: 17 }, (_, i) => {
      const a = (i / 16) * Math.PI;
      return [10 * Math.cos(a), 10 * Math.sin(a)];
    });
    const halfArea = (16 * 100 * Math.sin(Math.PI / 16)) / 2;
    for (const shape of ['dome', 'onion'] as const) {
      const { mesh, roofHeight } = buildRoof(props({ shape, roofHeight: 5 }), [[apse]])!;
      expect(Math.max(...ys(mesh.positions))).toBeCloseTo(roofHeight, 6);
      for (let i = 0; i < mesh.positions.length; i += 3) {
        const [x, z] = [mesh.positions[i]!, mesh.positions[i + 2]!];
        expect(Math.hypot(x, z)).toBeLessThanOrEqual(10 + 1e-6);
        expect(z).toBeGreaterThanOrEqual(-1e-6);
      }
      // A dome reaches the walls all round (an onion starts inside them, by design).
      if (shape === 'dome') expect(projected(mesh.positions)).toBeCloseTo(halfArea, 3);
    }
  });

  it('domes and onions on a square start square and round off as they rise', () => {
    for (const shape of ['dome', 'onion'] as const) {
      // A 20 m square with a vertex mid-edge too (corners 14.1 m out, mid-edges 10 m).
      const square: Vec2[] = [
        [-10, -10],
        [0, -10],
        [10, -10],
        [10, 0],
        [10, 10],
        [0, 10],
        [-10, 10],
        [-10, 0],
      ];
      const { mesh, roofHeight } = buildRoof(props({ shape, roofHeight: 8 }), [[square]])!;
      const p = mesh.positions;
      // Radii of the vertices in the top half: round (all about the same distance out).
      const upper = [] as number[];
      for (let i = 0; i < p.length; i += 3)
        if (p[i + 1]! > roofHeight * 0.6 && p[i + 1]! < roofHeight - 1e-6)
          upper.push(Math.hypot(p[i]!, p[i + 2]!));
      const byHeight = new Map<number, number[]>();
      for (let i = 0; i < p.length; i += 3) {
        const h = Math.round(p[i + 1]! * 1000);
        if (p[i + 1]! > roofHeight * 0.6 && p[i + 1]! < roofHeight - 1e-6)
          byHeight.set(h, [...(byHeight.get(h) ?? []), Math.hypot(p[i]!, p[i + 2]!)]);
      }
      for (const radii of byHeight.values())
        expect(Math.max(...radii) / Math.min(...radii)).toBeLessThan(1.15);
      expect(upper.length).toBeGreaterThan(0);
    }
  });

  it('a dome on a round outline is a dome of revolution', () => {
    const circle: Vec2[] = Array.from({ length: 32 }, (_, i) => {
      const a = (i / 32) * 2 * Math.PI;
      return [6 * Math.cos(a), 6 * Math.sin(a)];
    });
    const { mesh } = buildRoof(props({ shape: 'dome', roofHeight: 6 }), [[circle]])!;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const [x, y, z] = [mesh.positions[i]!, mesh.positions[i + 1]!, mesh.positions[i + 2]!];
      expect(Math.hypot(Math.hypot(x, z), y)).toBeCloseTo(6, 1); // on the sphere
    }
  });

  it('a pyramid rises to an apex above the centre', () => {
    const pyramid = buildRoof(props({ shape: 'pyramidal', roofHeight: 8 }), [[rect(20, 10)]])!;
    const apex = pyramid.mesh.positions.findIndex((v, i) => i % 3 === 1 && Math.abs(v - 8) < 1e-9);
    expect(pyramid.mesh.positions[apex - 1]).toBeCloseTo(0, 9);
    expect(pyramid.mesh.positions[apex + 1]).toBeCloseTo(0, 9);
  });

  it('cone: follows the outline up to the apex, leaving no ledge uncovered', () => {
    const area = (positions: number[]) => {
      let a = 0;
      for (let i = 0; i < positions.length; i += 9) {
        const [ax, , az, bx, , bz, cx, , cz] = positions.slice(i, i + 9) as number[];
        a += Math.abs((bx! - ax!) * (cz! - az!) - (cx! - ax!) * (bz! - az!)) / 2;
      }
      return a;
    };
    const box = buildRoof(props({ shape: 'cone', roofHeight: 8 }), [[rect(20, 12)]])!;
    expect(area(box.mesh.positions)).toBeCloseTo(240, 6);
    // On a round outline every base point is one radius from the apex: a true cone.
    const circle: Vec2[] = Array.from({ length: 24 }, (_, i) => {
      const a = (i / 24) * 2 * Math.PI;
      return [6 * Math.cos(a), 6 * Math.sin(a)];
    });
    const { mesh } = buildRoof(props({ shape: 'cone', roofHeight: 8 }), [[circle]])!;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const [x, y, z] = [mesh.positions[i]!, mesh.positions[i + 1]!, mesh.positions[i + 2]!];
      if (y < 1e-9) expect(Math.hypot(x, z)).toBeCloseTo(6, 6);
      else expect(Math.hypot(x, z)).toBeCloseTo(0, 6);
    }
  });

  it('side-hipped: gabled at the end toward the attached part, hipped at the other', () => {
    for (const shape of ['side_hipped', 'side_half_hipped'] as const) {
      const at = (...attached: Vec2[]) => {
        const { mesh } = buildRoof(props({ shape, roofHeight: 4 }), [[rect(20, 10)]], 0, attached)!;
        const p = mesh.positions;
        // Highest point at each end (x = ±10).
        const top = (x: number) =>
          Math.max(...p.filter((_, i) => i % 3 === 1 && Math.abs(p[i - 1]! - x) < 1e-6));
        return [top(-10), top(10)];
      };
      const half = shape === 'side_half_hipped' ? 2 : 0;
      expect(at([10, 1])).toEqual([half, 4].map((v) => expect.closeTo(v, 6)));
      expect(at([-10, 1])).toEqual([4, half].map((v) => expect.closeTo(v, 6)));
      expect(at()).toEqual([half, half].map((v) => expect.closeTo(v, 6))); // unknown: both hipped
      expect(at([10, 0], [-10, 0])).toEqual([half, half].map((v) => expect.closeTo(v, 6))); // both ends
      expect(at([10, 1], [0, 5])).toEqual([half, 4].map((v) => expect.closeTo(v, 6))); // side ignored
    }
  });

  it('a part that is all roof keeps its full dome', () => {
    const built = buildRoof(props({ shape: 'dome', minHeight: 40, height: 60, roofHeight: 20 }), [
      [rect(20, 20)],
    ])!;
    expect(built.roofHeight).toBe(20);
  });

  it('returns null for degenerate or roofless input', () => {
    expect(
      buildRoof(props(), [
        [
          [
            [0, 0],
            [1, 1],
          ],
        ],
      ]),
    ).toBeNull();
    expect(
      buildRoof(props(), [
        [
          [
            [0, 0],
            [1, 0],
            [2, 0],
          ],
        ],
      ]),
    ).toBeNull();
    expect(buildRoof(props({ height: 0.8 }), [[rect(40, 20)]])).toBeNull();
  });

  it('uses the largest polygon for the frame of a multipolygon', () => {
    const built = buildRoof(props(), [[rect(4, 2, 40)], [rect(40, 20)]])!;
    expect(built.roofHeight).toBeCloseTo(10 * TAN_30, 9);
  });

  it('keeps hipped and mansard ridges on the long side so they reach the roof height', () => {
    for (const shape of ['hipped', 'half_hipped', 'mansard'] as const) {
      for (const over of [{ orientation: 'across' as const }, { direction: 90 }]) {
        const built = buildRoof(props({ shape, roofHeight: 6, ...over }), [[rect(40, 20)]])!;
        expect(Math.max(...ys(built.mesh.positions))).toBeCloseTo(6, 9);
      }
    }
  });
});
