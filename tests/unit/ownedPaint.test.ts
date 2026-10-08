import { describe, expect, it, vi } from 'vitest';
import { scaleBy, unscaleBy } from '../../src/core/expressions';
import { OwnedPaint, type PaintRule, type PaintTarget } from '../../src/core/ownedPaint';

const K = ['k'];
const rule: PaintRule = {
  property: 'fill-extrusion-height',
  wrap: (o) => scaleBy(o, K),
  unwrap: (v) => unscaleBy(v, K),
  fallback: 0,
};

function fakeMap(paint: Record<string, unknown> | null) {
  return {
    paint,
    getLayer: (id: string) => (paint && id === 'b' ? { id } : undefined),
    getPaintProperty: (_id: string, p: string) => paint?.[p],
    setPaintProperty: vi.fn((_id: string, p: string, v: unknown) => {
      paint![p] = v;
    }),
  };
}
const owned = (m: ReturnType<typeof fakeMap>, warn = vi.fn()) =>
  new OwnedPaint(m as unknown as PaintTarget, 'b', [rule], warn);

describe('OwnedPaint', () => {
  it('wraps once and restores the original', () => {
    const map = fakeMap({ 'fill-extrusion-height': ['get', 'h'] });
    const o = owned(map);
    expect(o.wrap()).toBe(true);
    o.wrap();
    expect(map.setPaintProperty).toHaveBeenCalledTimes(1);
    expect(map.paint!['fill-extrusion-height']).toEqual(['*', ['get', 'h'], K]);
    o.restore();
    expect(map.paint!['fill-extrusion-height']).toEqual(['get', 'h']);
  });

  it('uses the fallback for an unset property and peels a wrapper already present', () => {
    const unset = fakeMap({});
    owned(unset).wrap();
    expect(unset.paint!['fill-extrusion-height']).toEqual(['*', 0, K]);
    const wrapped = fakeMap({ 'fill-extrusion-height': ['*', 7, K] });
    const o = owned(wrapped);
    o.wrap();
    expect(wrapped.paint!['fill-extrusion-height']).toEqual(['*', 7, K]);
    o.restore();
    expect(wrapped.paint!['fill-extrusion-height']).toBe(7);
  });

  it('follows the app replacing the value and never restores over it', () => {
    const map = fakeMap({ 'fill-extrusion-height': 5 });
    const o = owned(map);
    o.wrap();
    map.paint!['fill-extrusion-height'] = 9;
    o.wrap();
    expect(map.paint!['fill-extrusion-height']).toEqual(['*', 9, K]);
    map.paint!['fill-extrusion-height'] = 3;
    o.restore();
    expect(map.paint!['fill-extrusion-height']).toBe(3);
  });

  it('reports a missing layer and warns once about legacy functions', () => {
    expect(owned(fakeMap(null)).wrap()).toBe(false);
    const warn = vi.fn();
    const legacy = fakeMap({ 'fill-extrusion-height': { stops: [[15, 0]] } });
    const o = owned(legacy, warn);
    o.wrap();
    o.wrap();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(legacy.setPaintProperty).not.toHaveBeenCalled();
    expect(o.isApplied('fill-extrusion-height')).toBe(false);
  });

  it('reset forgets without touching the map', () => {
    const map = fakeMap({ 'fill-extrusion-height': 5 });
    const o = owned(map);
    o.wrap();
    map.setPaintProperty.mockClear();
    o.reset();
    o.restore();
    expect(map.setPaintProperty).not.toHaveBeenCalled();
  });
});
