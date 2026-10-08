import { describe, expect, it } from 'vitest';
import { FootprintIndex, type SourceFeatureLike } from '../../src/roofs/footprints';

const box = (w: number, s: number, e: number, n: number) => [
  [
    [w, s],
    [e, s],
    [e, n],
    [w, n],
    [w, s],
  ],
];
const piece = (id: number | undefined, coords: number[][][], props = { roof_shape: 'gabled' }) =>
  ({
    id,
    geometry: { type: 'Polygon', coordinates: coords },
    properties: props,
  }) as SourceFeatureLike;
const keepTagged = (p: Record<string, unknown>) => p.roof_shape !== undefined;

function area(rings: number[][][]): number {
  let a = 0;
  const r = rings[0]!;
  for (let i = 0; i + 1 < r.length; i++) a += r[i]![0]! * r[i + 1]![1]! - r[i + 1]![0]! * r[i]![1]!;
  return Math.abs(a) / 2;
}

describe('FootprintIndex', () => {
  it('unions the tile pieces of one building (they overlap in the tile buffer)', () => {
    const idx = new FootprintIndex();
    const fps = idx.update(
      [piece(7, box(0, 0, 0.0021, 0.001)), piece(7, box(0.0019, 0, 0.004, 0.001))],
      keepTagged,
    );
    expect(fps.size).toBe(1);
    const fp = fps.get('7')!;
    expect(fp.polygons).toHaveLength(1);
    expect(area(fp.polygons[0]!)).toBeCloseTo(0.004 * 0.001, 12);
    expect(fp.centroid[0]).toBeCloseTo(0.002, 9);
    expect(fp.centroid[1]).toBeCloseTo(0.0005, 9);
  });

  it('skips untagged features, counts id-less ones, and keeps buildings apart', () => {
    const idx = new FootprintIndex();
    const fps = idx.update(
      [
        piece(1, box(0, 0, 1e-3, 1e-3)),
        piece(2, box(1, 1, 1.001, 1.001)),
        piece(3, box(2, 2, 2.001, 2.001), {} as never),
        piece(undefined, box(3, 3, 3.001, 3.001)),
      ],
      keepTagged,
    );
    expect([...fps.keys()]).toEqual(['1', '2']);
    expect(idx.missingIds).toBe(1);
  });

  it('reuses the cached footprint while its pieces are unchanged', () => {
    const idx = new FootprintIndex();
    const features = [piece(1, box(0, 0, 1e-3, 1e-3)), piece(1, box(1e-3, 0, 2e-3, 1e-3))];
    const first = idx.update(features, keepTagged).get('1');
    expect(idx.update(features, keepTagged).get('1')).toBe(first);
    expect(idx.update(features.slice(0, 1), keepTagged).get('1')).not.toBe(first);
  });
});
