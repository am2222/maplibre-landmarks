import { describe, expect, it } from 'vitest';
import { attachments, sagCurve, supportGeometry } from '../../src/power/geometry';

describe('power geometry', () => {
  it('builds a pylon and a pole of unit height, standing on the ground', () => {
    for (const kind of ['tower', 'pole'] as const) {
      const g = supportGeometry(kind);
      g.computeBoundingBox();
      expect(g.boundingBox!.min.y).toBeCloseTo(0, 6);
      expect(g.boundingBox!.max.y).toBeCloseTo(1, 1);
    }
  });

  it('hangs three wires across the line: arm tips and a top wire', () => {
    const tower = attachments('tower');
    expect(tower).toHaveLength(3);
    expect(tower.map(([x]) => Math.sign(x))).toEqual([-1, 1, 0]);
    for (const [, y] of tower) expect(y).toBeLessThanOrEqual(1);
    expect(attachments('pole')).toHaveLength(3);
  });

  it('sags a wire by 3% of its span at the middle, ends fixed', () => {
    const pts = sagCurve([0, 10, 0], [100, 20, 0], 12);
    expect(pts).toHaveLength(13);
    expect(pts[0]).toEqual([0, 10, 0]);
    expect(pts[12]).toEqual([100, 20, 0]);
    const mid = pts[6]!;
    expect(mid[0]).toBeCloseTo(50, 6);
    expect(mid[1]).toBeCloseTo(15 - 0.03 * Math.hypot(100, 10), 6);
  });
});
