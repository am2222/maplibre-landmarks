import { describe, expect, it } from 'vitest';
import { mercatorUnitsPerMetre, mercatorX, mercatorY } from '../../src/core/mercator';
import { FlowIndex, segmentsOf } from '../../src/water/flow';

const LNG = 2.2945;
const LAT = 48.8584;
const R = 300 * mercatorUnitsPerMetre(LAT);
const x = mercatorX(LNG);
const y = mercatorY(LAT);
const line = (coordinates: number[][], kind = 'river') => ({
  geometry: { type: 'LineString', coordinates },
  properties: { kind },
});

describe('river flow', () => {
  it('keeps river and canal lines, split into segments', () => {
    const segs = segmentsOf([
      line([
        [LNG, LAT],
        [LNG + 0.001, LAT],
        [LNG + 0.002, LAT],
      ]),
      line(
        [
          [LNG, LAT],
          [LNG, LAT + 0.001],
        ],
        'canal',
      ),
      line(
        [
          [LNG, LAT],
          [LNG, LAT + 0.001],
        ],
        'stream',
      ),
      {
        geometry: {
          type: 'MultiLineString',
          coordinates: [
            [
              [LNG, LAT],
              [LNG + 0.001, LAT],
            ],
          ],
        },
        properties: { kind: 'river' },
      },
      { geometry: { type: 'Polygon', coordinates: [] }, properties: { kind: 'river' } },
    ]);
    expect(segs).toHaveLength(4);
    expect(segs[0]![0]).toBeCloseTo(x, 12);
  });

  it('gives the direction of the nearest segment in local axes (x east, z south)', () => {
    const east = segmentsOf([
      line([
        [LNG - 0.001, LAT],
        [LNG + 0.001, LAT],
      ]),
    ]);
    const [fx, fz] = new FlowIndex(east, R).at(x, y + 100 * mercatorUnitsPerMetre(LAT));
    expect(fx).toBeCloseTo(1, 6);
    expect(fz).toBeCloseTo(0, 6);
    const south = segmentsOf([
      line([
        [LNG, LAT + 0.001],
        [LNG, LAT - 0.001],
      ]),
    ]);
    const [sx, sz] = new FlowIndex(south, R).at(x, y);
    expect(sx).toBeCloseTo(0, 6);
    expect(sz).toBeCloseTo(1, 6); // mercator y grows south
  });

  it('picks the nearer of two segments and ignores segments beyond the radius', () => {
    const segs = segmentsOf([
      line([
        [LNG - 0.001, LAT],
        [LNG + 0.001, LAT],
      ]), // east, through the point
      line([
        [LNG + 0.001, LAT + 0.001],
        [LNG - 0.001, LAT + 0.001],
      ]), // west, 111 m north
    ]);
    expect(new FlowIndex(segs, R).at(x, y)[0]).toBeCloseTo(1, 6);
    const far = segmentsOf([
      line([
        [LNG - 0.001, LAT + 0.01],
        [LNG + 0.001, LAT + 0.01],
      ]),
    ]); // 1.1 km
    expect(new FlowIndex(far, R).at(x, y)).toEqual([0, 0]);
  });
});
