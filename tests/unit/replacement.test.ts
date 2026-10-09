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
import { onExemptionsChanged } from '../../src/labels/exemptions';

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
  const listeners = new Map<string, ((e: unknown) => void)[]>();
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
    // Several listeners per event (replacement and its tile feeds); handlers.get(t) calls them all.
    on: vi.fn((t: string, fn: (e: unknown) => void) => {
      listeners.set(t, [...(listeners.get(t) ?? []), fn]);
      handlers.set(t, (e: unknown) => [...(listeners.get(t) ?? [])].forEach((f) => f(e)));
    }),
    off: vi.fn((t: string, fn?: (e: unknown) => void) => {
      const list = (listeners.get(t) ?? []).filter((f) => f !== fn);
      listeners.set(t, list);
      if (!list.length) handlers.delete(t);
    }),
  };
  return { map, target: map as unknown as ReplacementTarget };
}

/** z16 tile key holding a lng/lat. */
function tileAt(lng: number, lat: number, z = 16): string {
  const r = (lat * Math.PI) / 180;
  const x = Math.floor(((lng + 180) / 360) * 2 ** z);
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
  return `${z}/${x}/${y}`;
}

/** MapLibre's tile manager for 'protomaps': the tiles it renders now, each with its features. */
function renderTiles(map: ReturnType<typeof fakeStyle>['map'], tiles: Record<string, unknown[]>) {
  const list = Object.entries(tiles).map(([key, features]) => {
    const [z, x, y] = key.split('/').map(Number);
    return {
      key,
      tileID: { canonical: { z, x, y } },
      querySourceFeatures: vi.fn((result: unknown[]) => result.push(...features)),
    };
  });
  // One manager per source (MapLibre keeps it while the source lives): only its tiles change.
  const style = ((map as { style?: { tileManagers: Record<string, object> } }).style ??= {
    tileManagers: {},
  });
  style.tileManagers.protomaps = Object.assign(style.tileManagers.protomaps ?? {}, {
    getRenderableIds: () => list.map((_, i) => i),
    getTileByID: (i: number) => list[i],
  });
  return Object.fromEntries(list.map((t) => [t.key, t]));
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

  it('also hides buildings mostly inside the footprint whose centre lies just outside it', () => {
    const { map, target } = fakeStyle();
    // The inset footprint's east edge is ~2.29518. A part from 2.29500 to 2.29540 is 45% inside
    // with its centre (2.29520) just outside; its neighbour starts at the original edge.
    const box = (id: number, w: number, e: number) => ({
      id,
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [w, 48.8583],
            [e, 48.8583],
            [e, 48.8586],
            [w, 48.8586],
            [w, 48.8583],
          ],
        ],
      },
    });
    map.features.splice(0, map.features.length, box(5, 2.295, 2.2954), box(6, 2.2952, 2.2956));
    new BuildingReplacement(target, ['buildings'], 1.5).update([full(landmark())]);
    expect(map.states.get(5)?.[FADE_STATE]).toBe(1);
    expect(map.states.has(6)).toBe(false);
  });

  it('rescans thousands of far-away buildings quickly (dense tiles, detailed footprints)', () => {
    const { map, target } = fakeStyle();
    // 40,000 buildings across a few kilometres, none near the landmark; a 2,000-point outline.
    const far = Array.from({ length: 40_000 }, (_, i) =>
      building(100 + i, 2.31 + (i % 200) * 0.0004, 48.87 + Math.floor(i / 200) * 0.0004),
    );
    const outline = Array.from({ length: 2000 }, (_, k) => {
      const a = (k / 2000) * 2 * Math.PI;
      return [2.2945 + 0.0006 * Math.cos(a), 48.8584 + 0.0004 * Math.sin(a)];
    });
    outline.push(outline[0]!);
    const detailed = (id: string) =>
      entry(id, { replacementFootprint: { type: 'Polygon', coordinates: [outline] } });
    map.features.splice(0, map.features.length, ...far);
    const t0 = performance.now();
    new BuildingReplacement(target, ['buildings'], 1.5).update(
      ['a', 'b', 'c', 'd', 'e'].map((id) => full(detailed(id))),
    );
    // Before the bounds check this ran every centre through every outline (~2 s).
    expect(performance.now() - t0).toBeLessThan(250);
    expect(map.states.size).toBe(0);
  });

  it('skips whole tiles far from every landmark without decoding their buildings', () => {
    const { map, target } = fakeStyle();
    // MapLibre's features know their tile (_x, _y, _z) and decode geometry lazily on access.
    const tileOf = (lng: number, lat: number, z = 16) => {
      const r = (lat * Math.PI) / 180;
      return {
        _z: z,
        _x: Math.floor(((lng + 180) / 360) * 2 ** z),
        _y: Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z),
      };
    };
    let decoded = 0;
    const lazy = (b: ReturnType<typeof building>, tile: object) => ({
      ...tile,
      id: b.id,
      get geometry() {
        decoded++;
        return b.geometry;
      },
    });
    const far = Array.from({ length: 500 }, (_, i) =>
      lazy(building(100 + i, 2.33, 48.87), tileOf(2.33, 48.87)),
    );
    const near = lazy(building(1, 2.2945, 48.85845), tileOf(2.2945, 48.85845));
    map.features.splice(0, map.features.length, ...far, near);
    new BuildingReplacement(target, ['buildings'], 1.5).update([full(landmark())]);
    expect(map.states.get(1)?.[FADE_STATE]).toBe(1);
    expect(decoded).toBeLessThanOrEqual(1);
  });

  it('tells exemption listeners (roofs) when the set of hidden buildings changes', () => {
    const { map, target } = fakeStyle();
    const listener = vi.fn();
    onExemptionsChanged(map, listener);
    const replacement = new BuildingReplacement(target, ['buildings'], 1.5);
    replacement.update([full(landmark())]);
    expect(listener).toHaveBeenCalledTimes(1);
    replacement.update([{ entry: landmark(), fade: 0.5 }]); // same buildings, new fade
    expect(listener).toHaveBeenCalledTimes(1);
    replacement.update([]);
    expect(listener).toHaveBeenCalledTimes(2);
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

  it('checks only an arriving tile against the landmarks, not the tiles already held', () => {
    vi.useFakeTimers();
    const { map, target } = fakeStyle();
    const here = tileAt(2.2945, 48.85845, 18);
    const tiles = renderTiles(map, { [here]: [building(1, 2.2945, 48.85845)] });
    new BuildingReplacement(target, ['buildings'], 1.5).update([full(landmark())]);
    expect(map.states.get(1)?.[FADE_STATE]).toBe(1);
    const next = tileAt(2.29515, 48.8585, 18); // the next tile east, still under the footprint
    expect(next).not.toBe(here);
    const more = renderTiles(map, {
      [here]: [building(1, 2.2945, 48.85845)],
      [next]: [building(3, 2.29515, 48.8585)],
    });
    more[here] = Object.assign(more[here]!, tiles[here]); // the same tile object
    map.handlers.get('sourcedata')!({ sourceId: 'protomaps', tile: more[next] });
    vi.advanceTimersByTime(200);
    expect(map.states.get(3)?.[FADE_STATE]).toBe(1);
    expect(tiles[here]!.querySourceFeatures).toHaveBeenCalledTimes(1);
    expect(map.querySourceFeatures).not.toHaveBeenCalled();
  });

  it('a landmark arriving later re-checks only the held tiles under it', () => {
    const { map, target } = fakeStyle();
    const here = tileAt(2.2945, 48.85845);
    const far = tileAt(2.33, 48.87);
    const tiles = renderTiles(map, {
      [here]: [building(1, 2.2945, 48.85845)],
      [far]: [building(9, 2.33, 48.87)],
    });
    const r = new BuildingReplacement(target, ['buildings'], 1.5);
    const elsewhere = entry('z', {
      replacementFootprint: {
        type: 'Polygon',
        coordinates: [
          [
            [2.3299, 48.8699],
            [2.3301, 48.8699],
            [2.3301, 48.8701],
            [2.3299, 48.8701],
            [2.3299, 48.8699],
          ],
        ],
      },
    });
    r.update([full(elsewhere)]); // both tiles arrive; only the one under a landmark is read
    expect(tiles[here]!.querySourceFeatures).not.toHaveBeenCalled();
    r.update([full(elsewhere), full(landmark())]);
    expect(map.states.get(1)?.[FADE_STATE]).toBe(1);
    expect(tiles[here]!.querySourceFeatures).toHaveBeenCalledTimes(1);
    expect(tiles[far]!.querySourceFeatures).toHaveBeenCalledTimes(1);
  });

  it('keeps hiding a building when its tile reloads', () => {
    vi.useFakeTimers();
    const { map, target } = fakeStyle();
    const here = tileAt(2.2945, 48.85845);
    const tiles = renderTiles(map, { [here]: [building(1, 2.2945, 48.85845)] });
    new BuildingReplacement(target, ['buildings'], 1.5).update([full(landmark())]);
    map.handlers.get('sourcedata')!({ sourceId: 'protomaps', tile: tiles[here] }); // reload
    vi.advanceTimersByTime(200);
    expect(map.states.get(1)?.[FADE_STATE]).toBe(1);
  });

  it('still follows new tiles after a tile failed to read during a rescan', () => {
    vi.useFakeTimers();
    const { map, target } = fakeStyle();
    const here = tileAt(2.2945, 48.85845, 18);
    const tiles = renderTiles(map, { [here]: [] });
    tiles[here]!.querySourceFeatures.mockImplementationOnce(() => {
      throw new Error('torn tile');
    });
    const r = new BuildingReplacement(target, ['buildings'], 1.5);
    expect(() => r.update([full(landmark())])).toThrow('torn tile');
    const next = tileAt(2.29515, 48.8585, 18);
    const more = renderTiles(map, { [next]: [building(3, 2.29515, 48.8585)] });
    map.handlers.get('sourcedata')!({ sourceId: 'protomaps', tile: more[next] });
    vi.advanceTimersByTime(200);
    expect(map.states.get(3)?.[FADE_STATE]).toBe(1);
  });

  it('does not read arriving tiles far from every landmark', () => {
    vi.useFakeTimers();
    const { map, target } = fakeStyle();
    renderTiles(map, {});
    new BuildingReplacement(target, ['buildings'], 1.5).update([full(landmark())]);
    const far = tileAt(2.33, 48.87);
    const tiles = renderTiles(map, { [far]: [building(9, 2.33, 48.87)] });
    map.handlers.get('sourcedata')!({ sourceId: 'protomaps', tile: tiles[far] });
    vi.advanceTimersByTime(200);
    expect(tiles[far]!.querySourceFeatures).not.toHaveBeenCalled();
  });

  it('keeps a claim while another held tile still holds the building', () => {
    vi.useFakeTimers();
    const { map, target } = fakeStyle();
    const a = tileAt(2.2945, 48.85845);
    const b = tileAt(2.2952, 48.85845);
    const shared = building(1, 2.2945, 48.85845);
    renderTiles(map, { [a]: [shared], [b]: [shared] });
    const r = new BuildingReplacement(target, ['buildings'], 1.5);
    r.update([full(landmark())]);
    renderTiles(map, { [b]: [shared] });
    map.handlers.get('sourcedata')!({ sourceId: 'protomaps' });
    vi.advanceTimersByTime(200);
    expect(map.states.get(1)?.[FADE_STATE]).toBe(1);
    renderTiles(map, {});
    map.handlers.get('sourcedata')!({ sourceId: 'protomaps' });
    vi.advanceTimersByTime(200);
    expect(map.states.get(1)?.[FADE_STATE]).toBeUndefined();
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
