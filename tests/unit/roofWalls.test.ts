import { describe, expect, it, vi } from 'vitest';
import { scaleBy } from '../../src/core/expressions';
import { OwnedPaint, type PaintTarget } from '../../src/core/ownedPaint';
import { DEFAULT_FIELDS } from '../../src/roofs/schema';
import { ROOF_STATE, wallRules } from '../../src/roofs/walls';

const ROOF = ['coalesce', ['feature-state', ROOF_STATE], 0];
const KEEP = ['k'];
const H = ['get', 'height'];

function fakeMap() {
  const paint: Record<string, unknown> = { 'fill-extrusion-height': H };
  return {
    paint,
    getLayer: () => ({ id: 'b' }),
    getPaintProperty: (_id: string, p: string) => paint[p],
    setPaintProperty: vi.fn((_id: string, p: string, v: unknown) => (paint[p] = v)),
  };
}

describe('wall wrappers on a shared extrusion layer', () => {
  it('subtracts the roof once when another wrapper lands on top of ours', () => {
    const map = fakeMap();
    const walls = new OwnedPaint(
      map as unknown as PaintTarget,
      'b',
      wallRules(DEFAULT_FIELDS, false),
      vi.fn(),
    );
    walls.wrap();
    // Landmark replacement wraps whatever is there (as BuildingReplacement does).
    map.paint['fill-extrusion-height'] = scaleBy(map.paint['fill-extrusion-height'], KEEP);
    walls.wrap();
    expect(map.paint['fill-extrusion-height']).toEqual(['max', 0, ['-', ['*', H, KEEP], ROOF]]);
  });

  it('wraps once when the other wrapper was there first', () => {
    const map = fakeMap();
    map.paint['fill-extrusion-height'] = scaleBy(H, KEEP);
    const walls = new OwnedPaint(
      map as unknown as PaintTarget,
      'b',
      wallRules(DEFAULT_FIELDS, false),
      vi.fn(),
    );
    walls.wrap();
    walls.wrap();
    expect(map.paint['fill-extrusion-height']).toEqual(['max', 0, ['-', ['*', H, KEEP], ROOF]]);
  });
});
