import { describe, expect, it } from 'vitest';
import { contactPoints } from '../../src/roofs/attached';

const M = 111_320;
const KX = M * Math.cos((48.85 * Math.PI) / 180);
/** w × d metre rectangle (one polygon), south-west corner (east, north) metres from 2.29, 48.85. */
const rect = (east: number, north: number, w: number, d: number) => {
  const [x0, y0] = [2.29 + east / KX, 48.85 + north / M];
  const [x1, y1] = [x0 + w / KX, y0 + d / M];
  return [
    [
      [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
        [x0, y0],
      ],
    ],
  ];
};

describe('contactPoints', () => {
  it("finds the other parts' corners on the outline, and nothing from parts apart", () => {
    const wing = rect(0, 0, 20, 10);
    const touching = contactPoints(wing, [rect(20, 0, 10, 10), rect(40, 0, 10, 10)]);
    expect(touching).toHaveLength(2); // the east neighbour's west corners
    for (const [x] of touching) expect((x - 2.29) * KX).toBeCloseTo(20, 3);
    expect(contactPoints(wing, [rect(21, 0, 10, 10)])).toEqual([]); // 1 m gap
    expect(contactPoints(wing, [rect(20.5, 0, 10, 10)])).toHaveLength(2); // within 0.75 m
  });
});
