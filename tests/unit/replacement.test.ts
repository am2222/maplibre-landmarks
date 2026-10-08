import { afterEach, describe, expect, it, vi } from 'vitest';
import { distanceM } from '../../src/landmarks/discovery';
import {
  BuildingReplacement,
  footprintOf,
  FADE_STATE,
  insetRing,
  type ReplacementTarget,
} from '../../src/landmarks/replacement';
import type { LandmarkEntry } from '../../src/landmarks/catalogue';
import { entry } from './fixtures';

// ~100 m square around the Eiffel Tower anchor.
const SQUARE = [
  [2.2938, 48.858],
  [2.2952, 48.858],
  [2.2952, 48.8589],
  [2.2938, 48.8589],
  [2.2938, 48.858],
];

describe('insetRing', () => {
  it('moves every vertex ~insetM metres toward the centroid and keeps the ring closed', () => {
    const inset = insetRing(SQUARE, 1.5);
    expect(inset).toHaveLength(5);
    expect(inset[0]).toEqual(inset[4]);
    for (let i = 0; i < 4; i++) {
      const moved = distanceM(SQUARE[i] as [number, number], inset[i] as [number, number]);
      expect(moved).toBeCloseTo(1.5, 1);
    }
  });

  it('collapses rings smaller than the inset onto their centroid', () => {
    const tiny = [
      [0, 0],
      [0.000001, 0],
      [0.000001, 0.000001],
      [0, 0],
    ];
    const inset = insetRing(tiny, 5);
    expect(new Set(inset.map((p) => p.join(','))).size).toBe(1);
  });
});

describe('footprintOf', () => {
  it('uses the replacement footprint and grows courtyard holes by the inset', () => {
    const hole = [
      [2.2944, 48.8583],
      [2.2946, 48.8583],
      [2.2946, 48.8585],
      [2.2944, 48.8583],
    ];
    const e = entry('a', {
      replacementFootprint: { type: 'Polygon', coordinates: [SQUARE, hole] },
    });
    const multi = footprintOf(e, 1.5);
    expect(multi).toHaveLength(1);
    expect(multi[0]![0]).not.toEqual(SQUARE);
    // Courtyard buildings sharing the courtyard wall must stay visible: the hole grows outward.
    const grown = multi[0]![1]!;
    const cx = (hole[0]![0]! + hole[1]![0]! + hole[2]![0]!) / 3;
    const cy = (hole[0]![1]! + hole[1]![1]! + hole[2]![1]!) / 3;
    for (let i = 0; i < 3; i++) {
      const moved = distanceM(hole[i] as [number, number], grown[i] as [number, number]);
      expect(moved).toBeCloseTo(1.5, 1);
      expect(distanceM([cx, cy], grown[i] as [number, number])).toBeGreaterThan(
        distanceM([cx, cy], hole[i] as [number, number]),
      );
    }
  });

  it('insets every polygon of a MultiPolygon', () => {
    const e = entry('a', {
      replacementFootprint: { type: 'MultiPolygon', coordinates: [[SQUARE], [SQUARE]] },
    });
    expect(footprintOf(e, 1.5)).toHaveLength(2);
  });

  it('falls back to the entry bounds rectangle', () => {
    const multi = footprintOf(entry('a'), 0);
    expect(multi[0]![0]).toEqual([
      [2.2935, 48.8574],
      [2.2955, 48.8574],
      [2.2955, 48.8594],
      [2.2935, 48.8594],
      [2.2935, 48.8574],
    ]);
  });
});

const KEEP = ['-', 1, ['coalesce', ['feature-state', FADE_STATE], 0]];
const full = (e: LandmarkEntry) => ({ entry: e, fade: 1 });

/** Small square building (≈10 m) centred at lng/lat. */
function building(id: number | undefined, lng: number, lat: number) {
  const d = 0.00005;
  return {
    id,
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [lng - d, lat - d],
          [lng + d, lat - d],
          [lng + d, lat + d],
          [lng - d, lat + d],
          [lng - d, lat - d],
        ],
      ],
    },
  };
}

function fakeStyle(type: 'fill' | 'fill-extrusion' = 'fill') {
  const paint: Record<string, unknown> =
    type === 'fill'
      ? { 'fill-opacity': 0.5 }
      : {
          'fill-extrusion-height': ['get', 'height'],
          'fill-extrusion-base': ['get', 'min_height'],
        };
  const states = new Map<number, Record<string, unknown>>();
  const handlers = new Map<string, (e: unknown) => void>();
  const features = [
    building(1, 2.2945, 48.85845), // inside the landmark footprint
    building(1, 2.2945, 48.85845), // same building repeated in a neighbouring tile
    building(2, 2.296, 48.8585), // neighbour outside
    building(undefined, 2.2944, 48.8584), // no id: cannot be hidden
  ];
  const map = {
    paint,
    states,
    handlers,
    features,
    getLayer: (id: string) =>
      id === 'buildings' ? { id, type, source: 'protomaps', sourceLayer: 'buildings' } : undefined,
    getPaintProperty: (_id: string, p: string) => paint[p],
    setPaintProperty: vi.fn((_id: string, p: string, v: unknown) => {
      paint[p] = v;
    }),
    querySourceFeatures: vi.fn(() => features),
    setFeatureState: vi.fn((f: { id: number }, st: Record<string, unknown>) => {
      states.set(f.id, { ...states.get(f.id), ...st });
    }),
    removeFeatureState: vi.fn((f: { id: number }, key: string) => {
      const st = states.get(f.id);
      if (st) delete st[key];
    }),
    on: vi.fn((t: string, fn: (e: unknown) => void) => handlers.set(t, fn)),
    off: vi.fn((t: string) => handlers.delete(t)),
  };
  return { map, target: map as unknown as ReplacementTarget };
}

const landmark = () =>
  entry('a', { replacementFootprint: { type: 'Polygon', coordinates: [SQUARE] } });

afterEach(() => vi.useRealTimers());

describe('BuildingReplacement (feature-state)', () => {
  it('hides only buildings whose centre is inside the inset footprint', () => {
    const { map, target } = fakeStyle();
    new BuildingReplacement(target, ['buildings'], 1.5).update([full(landmark())]);
    expect(map.states.get(1)?.[FADE_STATE]).toBe(1);
    expect(map.states.has(2)).toBe(false);
    expect(map.setFeatureState).toHaveBeenCalledTimes(1);
    expect(map.setFeatureState).toHaveBeenCalledWith(
      { source: 'protomaps', sourceLayer: 'buildings', id: 1 },
      { [FADE_STATE]: 1 },
    );
  });

  it("also hides the model's listed basemap feature ids, even outside the footprint", () => {
    const { map, target } = fakeStyle();
    const e = entry('a', {
      replacementFootprint: { type: 'Polygon', coordinates: [SQUARE] },
      basemapReplacement: { tileset: 'protomaps-20260911', featureIds: [2] },
    });
    new BuildingReplacement(target, ['buildings'], 1.5).update([full(e)]);
    expect(map.states.get(1)?.[FADE_STATE]).toBe(1);
    expect(map.states.get(2)?.[FADE_STATE]).toBe(1);
  });

  it('wraps fill-opacity once so hidden buildings disappear without re-filtering', () => {
    const { map, target } = fakeStyle('fill');
    const r = new BuildingReplacement(target, ['buildings'], 1.5);
    r.update([full(landmark())]);
    r.update([
      full(landmark()),
      full(entry('b', { anchor: [2.3, 48.86], bounds: [2.299, 48.859, 2.301, 48.861] })),
    ]);
    expect(map.paint['fill-opacity']).toEqual(['*', 0.5, KEEP]);
    expect(map.setPaintProperty).toHaveBeenCalledTimes(1);
  });

  it('flattens hidden extrusions via height and base', () => {
    const { map, target } = fakeStyle('fill-extrusion');
    new BuildingReplacement(target, ['buildings'], 1.5).update([full(landmark())]);
    expect(map.paint['fill-extrusion-height']).toEqual(['*', ['get', 'height'], KEEP]);
    expect(map.paint['fill-extrusion-base']).toEqual(['*', ['get', 'min_height'], KEEP]);
  });

  it('writes partial fades and only touches features whose fade changed', () => {
    const { map, target } = fakeStyle('fill-extrusion');
    const r = new BuildingReplacement(target, ['buildings'], 1.5);
    r.update([{ entry: landmark(), fade: 0.25 }]);
    expect(map.states.get(1)?.[FADE_STATE]).toBe(0.25);
    r.update([{ entry: landmark(), fade: 0.25 }]);
    expect(map.setFeatureState).toHaveBeenCalledTimes(1);
    r.update([{ entry: landmark(), fade: 0.75 }]);
    expect(map.states.get(1)?.[FADE_STATE]).toBe(0.75);
    // Fade changes alone never rescan tiles.
    expect(map.querySourceFeatures).toHaveBeenCalledTimes(1);
  });

  it('uses the strongest fade when two landmarks claim the same building', () => {
    const { map, target } = fakeStyle();
    const other = entry('b', { replacementFootprint: { type: 'Polygon', coordinates: [SQUARE] } });
    new BuildingReplacement(target, ['buildings'], 1.5).update([
      { entry: landmark(), fade: 0.2 },
      { entry: other, fade: 0.9 },
    ]);
    expect(map.states.get(1)?.[FADE_STATE]).toBe(0.9);
  });

  it('reports the zoom where replaced extrusions start', () => {
    const { map, target } = fakeStyle('fill-extrusion');
    const r = new BuildingReplacement(target, ['buildings', 'missing'], 1.5);
    expect(r.extrusionMinZoom()).toBe(0);
    const getLayer = map.getLayer;
    map.getLayer = (id: string) => {
      const l = getLayer(id);
      return l && { ...l, minzoom: 14 };
    };
    expect(r.extrusionMinZoom()).toBe(14);
    expect(
      new BuildingReplacement(fakeStyle('fill').target, ['buildings'], 1.5).extrusionMinZoom(),
    ).toBe(0);
  });

  it('does not rescan when the model set is unchanged', () => {
    const { map, target } = fakeStyle();
    const r = new BuildingReplacement(target, ['buildings'], 1.5);
    r.update([full(landmark())]);
    r.update([full(landmark())]);
    expect(map.querySourceFeatures).toHaveBeenCalledTimes(1);
  });

  it('shows buildings again when their model leaves', () => {
    const { map, target } = fakeStyle();
    const r = new BuildingReplacement(target, ['buildings'], 1.5);
    r.update([full(landmark())]);
    r.update([]);
    expect(map.states.get(1)?.[FADE_STATE]).toBeUndefined();
  });

  it('rescans when new tiles of the source load', () => {
    vi.useFakeTimers();
    const { map, target } = fakeStyle();
    new BuildingReplacement(target, ['buildings'], 1.5).update([full(landmark())]);
    map.features.push(building(3, 2.2946, 48.8585));
    map.handlers.get('sourcedata')!({ sourceId: 'other' });
    vi.advanceTimersByTime(200);
    expect(map.states.has(3)).toBe(false);
    map.handlers.get('sourcedata')!({ sourceId: 'protomaps' });
    map.handlers.get('sourcedata')!({ sourceId: 'protomaps' });
    vi.advanceTimersByTime(200);
    expect(map.states.get(3)?.[FADE_STATE]).toBe(1);
    expect(map.querySourceFeatures).toHaveBeenCalledTimes(2);
  });

  it('restore shows every building, restores paint and stops listening', () => {
    const { map, target } = fakeStyle();
    const r = new BuildingReplacement(target, ['buildings'], 1.5);
    r.update([full(landmark())]);
    r.restore();
    expect(map.states.get(1)?.[FADE_STATE]).toBeUndefined();
    expect(map.paint['fill-opacity']).toBe(0.5);
    expect(map.handlers.has('sourcedata')).toBe(false);
  });

  it('ignores layers that do not exist', () => {
    const { map, target } = fakeStyle();
    new BuildingReplacement(target, ['missing'], 1.5).update([full(landmark())]);
    expect(map.setPaintProperty).not.toHaveBeenCalled();
    expect(map.setFeatureState).not.toHaveBeenCalled();
  });

  it('restore survives a torn-down style', () => {
    const { map, target } = fakeStyle();
    const r = new BuildingReplacement(target, ['buildings'], 1.5);
    r.update([full(landmark())]);
    (map as unknown as { getLayer: () => never }).getLayer = () => {
      throw new Error('style is gone');
    };
    map.removeFeatureState.mockImplementation(() => {
      throw new Error('style is gone');
    });
    expect(() => r.restore()).not.toThrow();
  });

  it('restore leaves the paint alone when someone else replaced its wrapper', () => {
    const { map, target } = fakeStyle('fill');
    const r = new BuildingReplacement(target, ['buildings'], 1.5);
    r.update([full(landmark())]);
    map.paint['fill-opacity'] = 0.25;
    r.restore();
    expect(map.paint['fill-opacity']).toBe(0.25);
  });

  it('never stacks its wrapper on a style that still carries it (re-added or reset)', () => {
    const { map, target } = fakeStyle('fill');
    const r = new BuildingReplacement(target, ['buildings'], 1.5);
    r.update([full(landmark())]);
    r.reset(); // style.load / re-add: our wrapper is still in the paint
    r.update([full(landmark())]);
    expect(map.paint['fill-opacity']).toEqual(['*', 0.5, KEEP]);
    const again = new BuildingReplacement(target, ['buildings'], 1.5);
    again.update([full(landmark())]);
    expect(map.paint['fill-opacity']).toEqual(['*', 0.5, KEEP]);
  });
});
