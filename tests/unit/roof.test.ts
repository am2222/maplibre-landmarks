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

  it('builds radial roofs within the footprint radius', () => {
    for (const shape of ['dome', 'onion'] as const) {
      const { mesh, roofHeight } = buildRoof(props({ shape, roofHeight: 8 }), [[rect(20, 20)]])!;
      expect(Math.max(...ys(mesh.positions))).toBeCloseTo(roofHeight, 6);
      for (let i = 0; i < mesh.positions.length; i += 3) {
        expect(Math.hypot(mesh.positions[i]!, mesh.positions[i + 2]!)).toBeLessThanOrEqual(
          10 + 1e-6,
        );
      }
    }
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
