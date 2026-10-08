import { describe, expect, it, vi } from 'vitest';
import { LABEL_STATE, LabelOpacity, type OpacityTarget } from '../../src/labels/opacity';

const VISIBILITY = ['coalesce', ['feature-state', LABEL_STATE], 1];

function fakeMap(paint: Record<string, Record<string, unknown>>) {
  return {
    paint,
    getLayer: (id: string) => (id in paint ? { id } : undefined),
    getPaintProperty: (id: string, p: string) => paint[id]![p],
    setPaintProperty: vi.fn((id: string, p: string, v: unknown) => {
      paint[id]![p] = v;
    }),
  };
}

describe('LabelOpacity', () => {
  it('multiplies text and icon opacity by the label visibility, once', () => {
    const map = fakeMap({ pois: { 'text-opacity': 0.8 } });
    const o = new LabelOpacity(map as unknown as OpacityTarget, vi.fn());
    o.wrap(['pois', 'missing']);
    o.wrap(['pois']);
    expect(map.paint.pois!['text-opacity']).toEqual(['*', 0.8, VISIBILITY]);
    expect(map.paint.pois!['icon-opacity']).toEqual(['*', 1, VISIBILITY]); // unset → default 1
    expect(map.setPaintProperty).toHaveBeenCalledTimes(2);
  });

  it('keeps zoom curves top-level', () => {
    const curve = ['interpolate', ['linear'], ['zoom'], 14, 0, 15, 1];
    const map = fakeMap({ pois: { 'text-opacity': curve } });
    new LabelOpacity(map as unknown as OpacityTarget, vi.fn()).wrap(['pois']);
    expect(map.paint.pois!['text-opacity']).toEqual([
      'interpolate',
      ['linear'],
      ['zoom'],
      14,
      ['*', 0, VISIBILITY],
      15,
      ['*', 1, VISIBILITY],
    ]);
  });

  it('skips legacy functions with a warning', () => {
    const warn = vi.fn();
    const map = fakeMap({ pois: { 'text-opacity': { stops: [[14, 0]] } } });
    new LabelOpacity(map as unknown as OpacityTarget, warn).wrap(['pois']);
    expect(map.paint.pois!['text-opacity']).toEqual({ stops: [[14, 0]] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('pois/text-opacity'));
  });

  it('never double-wraps a value it wrapped before (e.g. restored after context loss)', () => {
    const map = fakeMap({ pois: { 'text-opacity': ['*', 0.8, VISIBILITY] } });
    const o = new LabelOpacity(map as unknown as OpacityTarget, vi.fn());
    o.wrap(['pois']);
    expect(map.paint.pois!['text-opacity']).toEqual(['*', 0.8, VISIBILITY]);
    o.restore();
    expect(map.paint.pois!['text-opacity']).toBe(0.8);
  });

  it('follows the app changing the paint, and never restores over the app', () => {
    const map = fakeMap({ pois: { 'text-opacity': 0.8 } });
    const o = new LabelOpacity(map as unknown as OpacityTarget, vi.fn());
    o.wrap(['pois']);
    map.paint.pois!['text-opacity'] = 0.5; // app's own setPaintProperty
    o.wrap(['pois']);
    expect(map.paint.pois!['text-opacity']).toEqual(['*', 0.5, VISIBILITY]);
    map.paint.pois!['text-opacity'] = 0.3; // changed again, no re-wrap before removal
    o.restore();
    expect(map.paint.pois!['text-opacity']).toBe(0.3);
    expect(map.paint.pois!['icon-opacity']).toBeUndefined();
  });

  it('releases layers dropped from the list and warns about legacy functions once', () => {
    const warn = vi.fn();
    const map = fakeMap({ pois: { 'text-opacity': 0.8 }, old: { 'text-opacity': { stops: [] } } });
    const o = new LabelOpacity(map as unknown as OpacityTarget, warn);
    o.wrap(['pois', 'old']);
    o.wrap(['pois', 'old']);
    expect(warn).toHaveBeenCalledTimes(1);
    o.wrap(['old']);
    expect(map.paint.pois!['text-opacity']).toBe(0.8);
  });

  it('restores originals; reset forgets them without touching the map', () => {
    const map = fakeMap({ pois: { 'text-opacity': 0.8 } });
    const o = new LabelOpacity(map as unknown as OpacityTarget, vi.fn());
    o.wrap(['pois']);
    o.restore();
    expect(map.paint.pois!['text-opacity']).toBe(0.8);
    expect(map.paint.pois!['icon-opacity']).toBeUndefined();
    o.wrap(['pois']);
    map.setPaintProperty.mockClear();
    o.reset();
    o.restore();
    expect(map.setPaintProperty).not.toHaveBeenCalled();
  });
});
