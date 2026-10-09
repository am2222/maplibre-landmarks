import { describe, expect, it, vi } from 'vitest';
import { mergeFootprint, signatureOf } from '../../src/roofs/footprints';

const box = (w: number, s: number, e: number, n: number) => [
  [
    [w, s],
    [e, s],
    [e, n],
    [w, n],
    [w, s],
  ],
];
function area(rings: number[][][]): number {
  let a = 0;
  const r = rings[0]!;
  for (let i = 0; i + 1 < r.length; i++) a += r[i]![0]! * r[i + 1]![1]! - r[i + 1]![0]! * r[i]![1]!;
  return Math.abs(a) / 2;
}

describe('mergeFootprint', () => {
  const merge = (
    pieces: number[][][][],
    union?: Parameters<typeof mergeFootprint>[5],
    onError?: () => void,
  ) => mergeFootprint('7', 7, pieces, {}, signatureOf(pieces), union, onError)!;

  it('unions the tile pieces of one building (they overlap in the tile buffer)', () => {
    const fp = merge([box(0, 0, 0.0021, 0.001), box(0.0019, 0, 0.004, 0.001)]);
    expect(fp.polygons).toHaveLength(1);
    expect(area(fp.polygons[0]!)).toBeCloseTo(0.004 * 0.001, 12);
    expect(fp.centroid[0]).toBeCloseTo(0.002, 9);
    expect(fp.centroid[1]).toBeCloseTo(0.0005, 9);
  });

  it('identifies pieces regardless of their order', () => {
    const [a, b] = [box(0, 0, 1e-3, 1e-3), box(1e-3, 0, 2e-3, 1e-3)];
    expect(signatureOf([a, b])).toBe(signatureOf([b, a]));
    expect(signatureOf([a])).not.toBe(signatureOf([a, b]));
  });

  it('falls back to the largest piece when the union fails, and reports it', () => {
    const onError = vi.fn();
    const fp = merge(
      [box(0, 0, 0.002, 0.001), box(0.0019, 0, 0.0025, 0.001)],
      () => {
        throw new Error('Unable to complete output ring');
      },
      onError,
    );
    expect(fp.polygons).toEqual([box(0, 0, 0.002, 0.001)]);
    expect(onError).toHaveBeenCalledWith('7', expect.any(Error));
  });

  it('samples terrain where MapLibre does: the vertex average of the largest piece', () => {
    // Densely noded west side pulls the vertex average west of the area centroid.
    const ring = [
      [0, 0],
      [0, 0.00025],
      [0, 0.0005],
      [0, 0.00075],
      [0, 0.001],
      [0.004, 0.001],
      [0.004, 0],
      [0, 0],
    ];
    const fp = merge([[ring]]);
    expect(fp.terrainPoint[0]).toBeCloseTo((0.004 * 2) / 7, 9);
    expect(fp.centroid[0]).toBeCloseTo(0.002, 9);
  });
});
