# Label Occlusion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An opt-in `LabelOcclusion` MapLibre layer that fades out basemap point labels hidden behind 3D content (landmark models, extruded buildings, terrain), never hiding a landmark's own label.

**Architecture:** A raw-WebGL2 custom layer placed between the 3D layers and the first symbol layer draws one invisible point per label inside an `ANY_SAMPLES_PASSED_CONSERVATIVE` occlusion query against the depth buffer. Answers are read asynchronously and drive a per-label feature-state that multiplies the label layers' `text-opacity`/`icon-opacity`. Labels are found with `queryRenderedFeatures` when the camera settles (and every 250 ms while it moves). Landmarks contribute exempt footprints through a per-map registry.

**Tech Stack:** TypeScript 6, MapLibre GL JS 6.13 (WebGL2), three 0.186 (only the existing `Tweens` helper is reused), vitest 5 (node), Playwright (swiftshader).

**Spec:** `docs/superpowers/specs/2026-10-07-label-occlusion-design.md`

## Global Constraints

- Feature-state key for label visibility: `landmarks:label` (1 shown, 0 hidden, unset = shown).
- Defaults: `id: 'label-occlusion'`, `minZoom: 15`, `fadeMs: 180`, `maxLabels: 256`, probe point 4 CSS px, probe lift 2.5 m, roof fallback `min_height + 9` m, at most 48 new roof lookups per scan, roof cache capped at 2048 entries.
- Auto-detected label layers: `type: 'symbol'`, `symbol-placement` absent or `'point'`, `source-layer` in `pois`, `poi`, `buildings`, `building`.
- Re-scan timing: `move` → 250 ms after the previous scan; `moveend` → 60 ms; `idle` → 60 ms if anything changed; `sourcedata` with content → 150 ms; `terrain` → 100 ms and clear the roof cache.
- GL is touched only inside MapLibre's `render` callback (deleting GL objects on removal is the one exception); every piece of GL state the probe changes is restored.
- No WebGL2 (no `createQuery`) → the layer does nothing and labels are unchanged.
- **No git commits.** The repo has no git and the user commits themselves: every task ends by leaving changes in the working tree. Run `npx prettier --write` on touched files instead of committing.
- Checks used throughout: `npx tsc --noEmit`, `npx vitest run`, `npm run lint`, `npx playwright test`.

## Review Focus

- **Zoom-curve opacity** (OpenFreeMap-style `text-opacity: ['interpolate', ['linear'], ['zoom'], …]`): wrapping must keep the zoom curve top-level or MapLibre rejects the style. Test in Task 2.
- **A label layer removed by the app while occlusion runs:** `queryRenderedFeatures({ layers })` throws for unknown ids, so every scan must filter to existing layers. Test in Task 6.
- **No matching label layers:** `queryRenderedFeatures({ layers: [] })` must never be called (an empty list can mean "all layers"); nothing happens. Test in Task 3.
- **WebGL context lost with queries in flight:** no calls on dead handles, labels shown, rebuilt after restore. Test in Task 6.
- **Full `setStyle` swap:** the layer is dropped without `onRemove`; it must tear down without writing old paint or feature-state into the new style. Test in Task 6.

---

## File Structure

| File                                    | Responsibility                                                            |
| --------------------------------------- | ------------------------------------------------------------------------- |
| `src/core/expressions.ts` (new)         | `scaleBy`: zoom-curve-safe multiply of a paint value (moved)              |
| `src/core/geometry.ts` (new)            | `pointInRing`, `pointInPolygons`, `polygonsOf` (moved/added)              |
| `src/landmarks/replacement.ts` (modify) | Import the two helpers above instead of defining them                    |
| `src/labels/opacity.ts` (new)           | Wrap/restore `text-opacity`/`icon-opacity` of label layers                |
| `src/labels/candidates.ts` (new)        | Label layer detection, candidate collection, roof heights, exemptions    |
| `src/labels/exemptions.ts` (new)        | Per-map registry of exempt footprints (pull-based)                        |
| `src/labels/probe.ts` (new)             | `OcclusionProbe`: WebGL2 program, buffer, query pool, draw, poll          |
| `src/labels/LabelOcclusion.ts` (new)    | The custom layer: placement, scheduling, fades, lifecycle                 |
| `src/landmarks/LandmarksModule.ts` (mod)| Register landmark footprints as exemptions                               |
| `src/index.ts` (modify)                 | Export `LabelOcclusion`, `LabelOcclusionOptions`, `LABEL_STATE`           |
| `tests/unit/fakeGl.ts` (new)            | Fake WebGL2 context for probe/layer tests                                 |
| `demo/e2e.ts`, `demo/main.ts`, `demo/index.html`, `README.md`, `tests/browser/labels.pw.ts` | Browser test, demo toggle, docs |

---

### Task 1: Move shared expression and geometry helpers

**Files:**
- Create: `src/core/expressions.ts`, `src/core/geometry.ts`
- Modify: `src/landmarks/replacement.ts` (remove `scaleBy`, `pointInRing`, `pointInPolygons`, `isZoom`; import them)
- Test: `tests/unit/expressions.test.ts` (new), `tests/unit/geometry.test.ts` (new), `tests/unit/replacement.test.ts` (drop the `scaleBy` test and import)

**Interfaces:**
- Produces: `scaleBy(value: unknown, factor: unknown): unknown` (undefined for legacy function objects); `pointInRing(p: number[], ring: number[][]): boolean`; `pointInPolygons(p: number[], polygons: number[][][][]): boolean`; `polygonsOf(geometry: { type: string; coordinates: unknown } | null | undefined): number[][][][]`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/expressions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { scaleBy } from '../../src/core/expressions';

describe('scaleBy', () => {
  const k = ['k'];

  it('scales zoom curves per stop, keeping the curve top-level', () => {
    expect(scaleBy(['interpolate', ['linear'], ['zoom'], 15, 0, 16, ['get', 'h']], k)).toEqual([
      'interpolate',
      ['linear'],
      ['zoom'],
      15,
      ['*', 0, k],
      16,
      ['*', ['get', 'h'], k],
    ]);
    expect(scaleBy(['step', ['zoom'], 0, 14, ['get', 'h']], k)).toEqual([
      'step',
      ['zoom'],
      ['*', 0, k],
      14,
      ['*', ['get', 'h'], k],
    ]);
  });

  it('multiplies numbers and ordinary expressions', () => {
    expect(scaleBy(0.5, k)).toEqual(['*', 0.5, k]);
    expect(scaleBy(['interpolate', ['linear'], ['get', 'x'], 0, 1], k)).toEqual([
      '*',
      ['interpolate', ['linear'], ['get', 'x'], 0, 1],
      k,
    ]);
  });

  it('cannot wrap legacy function objects', () => {
    expect(scaleBy({ stops: [[15, 0]] }, k)).toBeUndefined();
  });
});
```

`tests/unit/geometry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { pointInPolygons, pointInRing, polygonsOf } from '../../src/core/geometry';

const SQUARE = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
  [0, 0],
];
const HOLE = [
  [4, 4],
  [6, 4],
  [6, 6],
  [4, 6],
  [4, 4],
];

describe('geometry', () => {
  it('tests points against rings and polygons with holes', () => {
    expect(pointInRing([5, 5], SQUARE)).toBe(true);
    expect(pointInRing([15, 5], SQUARE)).toBe(false);
    expect(pointInPolygons([2, 2], [[SQUARE, HOLE]])).toBe(true);
    expect(pointInPolygons([5, 5], [[SQUARE, HOLE]])).toBe(false);
    expect(pointInPolygons([5, 5], [])).toBe(false);
  });

  it('normalises GeoJSON polygons', () => {
    expect(polygonsOf({ type: 'Polygon', coordinates: [SQUARE] })).toEqual([[SQUARE]]);
    expect(polygonsOf({ type: 'MultiPolygon', coordinates: [[SQUARE]] })).toEqual([[SQUARE]]);
    expect(polygonsOf({ type: 'Point', coordinates: [1, 2] })).toEqual([]);
    expect(polygonsOf(undefined)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/unit/expressions.test.ts tests/unit/geometry.test.ts`
Expected: FAIL, cannot resolve `../../src/core/expressions` / `../../src/core/geometry`.

- [ ] **Step 3: Create the modules**

`src/core/expressions.ts`:

```ts
const isZoom = (e: unknown) => Array.isArray(e) && e.length === 1 && e[0] === 'zoom';

/**
 * `value × factor` as a style expression. A zoom curve must stay the top-level expression, so
 * its outputs are scaled instead. Returns undefined for legacy function objects (not wrappable).
 */
export function scaleBy(value: unknown, factor: unknown): unknown {
  if (Array.isArray(value)) {
    const [op] = value as unknown[];
    if (
      (op === 'interpolate' || op === 'interpolate-hcl' || op === 'interpolate-lab') &&
      isZoom(value[2])
    ) {
      const [, interp, input, ...stops] = value as unknown[];
      return [op, interp, input, ...stops.map((v, i) => (i % 2 ? ['*', v, factor] : v))];
    }
    if (op === 'step' && isZoom(value[1])) {
      const [, input, first, ...stops] = value as unknown[];
      return [
        op,
        input,
        ['*', first, factor],
        ...stops.map((v, i) => (i % 2 ? ['*', v, factor] : v)),
      ];
    }
    return ['*', value, factor];
  }
  if (typeof value === 'number') return ['*', value, factor];
  return undefined;
}
```

`src/core/geometry.ts`:

```ts
export type Ring = number[][];

/** Even-odd ray cast; `ring` may be open or closed. */
export function pointInRing([x, y]: number[], ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi! > y! !== yj! > y! && x! < ((xj! - xi!) * (y! - yi!)) / (yj! - yi!) + xi!)
      inside = !inside;
  }
  return inside;
}

/** Inside any polygon's outer ring and none of its holes. */
export function pointInPolygons(p: number[], polygons: number[][][][]): boolean {
  return polygons.some(
    ([outer, ...holes]) => pointInRing(p, outer!) && !holes.some((h) => pointInRing(p, h)),
  );
}

/** Polygon / MultiPolygon coordinates as a list of polygons; anything else is empty. */
export function polygonsOf(
  geometry: { type: string; coordinates: unknown } | null | undefined,
): number[][][][] {
  if (geometry?.type === 'Polygon') return [geometry.coordinates as number[][][]];
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates as number[][][][];
  return [];
}
```

- [ ] **Step 4: Point `replacement.ts` at them**

In `src/landmarks/replacement.ts`:
- Delete the local `isZoom`, `scaleBy`, `pointInRing` and `pointInPolygons` definitions.
- Replace `export type Ring = number[][];` with `export type { Ring } from '../core/geometry';` and add `import type { Ring } from '../core/geometry';` for its own use.
- Add `import { scaleBy } from '../core/expressions';` and `import { pointInPolygons } from '../core/geometry';`.

In `tests/unit/replacement.test.ts`: remove `scaleBy,` from the import list and delete the whole `it('scales zoom curves per stop, keeping the curve top-level', …)` test (it now lives in `expressions.test.ts`).

- [ ] **Step 5: Run everything**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS (no behaviour change; replacement tests still green).

- [ ] **Step 6: Format, leave uncommitted**

Run: `npx prettier --write src/core src/landmarks/replacement.ts tests/unit`

---

### Task 2: Label opacity wrapping

**Files:**
- Create: `src/labels/opacity.ts`
- Test: `tests/unit/labelOpacity.test.ts`

**Interfaces:**
- Consumes: `scaleBy` (Task 1).
- Produces: `LABEL_STATE = 'landmarks:label'`; `class LabelOpacity { constructor(map: OpacityTarget, warn: (message: string) => void); wrap(layerIds: string[]): void; restore(): void; reset(): void }` where `OpacityTarget = Pick<MlMap, 'getLayer' | 'getPaintProperty' | 'setPaintProperty'>`.

- [ ] **Step 1: Write the failing test**

`tests/unit/labelOpacity.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/labelOpacity.test.ts`
Expected: FAIL, cannot resolve `../../src/labels/opacity`.

- [ ] **Step 3: Implement**

`src/labels/opacity.ts`:

```ts
import type { Map as MlMap } from 'maplibre-gl';
import { scaleBy } from '../core/expressions';

/** Feature-state key on label features: 1 shown, 0 hidden; unset means shown. */
export const LABEL_STATE = 'landmarks:label';
const VISIBILITY = ['coalesce', ['feature-state', LABEL_STATE], 1];
const PROPERTIES = ['text-opacity', 'icon-opacity'] as const;

export type OpacityTarget = Pick<MlMap, 'getLayer' | 'getPaintProperty' | 'setPaintProperty'>;
type PaintValue = Parameters<MlMap['setPaintProperty']>[2];

/** Multiplies label layers' opacity by their per-feature visibility; restores on demand. */
export class LabelOpacity {
  private readonly originals = new Map<string, Map<string, unknown>>();

  constructor(
    private readonly map: OpacityTarget,
    private readonly warn: (message: string) => void,
  ) {}

  wrap(layerIds: string[]): void {
    for (const id of layerIds) {
      if (this.originals.has(id) || !this.map.getLayer(id)) continue;
      const props = new Map<string, unknown>();
      for (const prop of PROPERTIES) {
        const original = this.map.getPaintProperty(id, prop);
        const wrapped = scaleBy(original ?? 1, VISIBILITY);
        if (wrapped === undefined) {
          this.warn(`cannot wrap legacy function ${id}/${prop}`);
          continue;
        }
        props.set(prop, original);
        this.map.setPaintProperty(id, prop, wrapped as PaintValue);
      }
      this.originals.set(id, props);
    }
  }

  restore(): void {
    for (const [id, props] of this.originals) {
      for (const [prop, value] of props) {
        try {
          if (this.map.getLayer(id)) this.map.setPaintProperty(id, prop, value as PaintValue);
        } catch {
          // The style was torn down.
        }
      }
    }
    this.originals.clear();
  }

  /** Forget wrapped layers after a style swap without touching the (new) style. */
  reset(): void {
    this.originals.clear();
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/unit/labelOpacity.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Format, leave uncommitted**

Run: `npx prettier --write src/labels tests/unit/labelOpacity.test.ts`

---

### Task 3: Label candidates

**Files:**
- Create: `src/labels/candidates.ts`
- Test: `tests/unit/candidates.test.ts`

**Interfaces:**
- Consumes: `pointInPolygons`, `polygonsOf` (Task 1); `LngLat` from `src/core/types`.
- Produces:
  - `labelLayerIds(layers: StyleLayerLike[], override?: string[]): string[]` with `StyleLayerLike = { id: string; type: string; 'source-layer'?: string; layout?: Record<string, unknown> }`.
  - `roofHeight(properties: Record<string, unknown>): number`.
  - `interface Candidate { key: string; feature: FeatureIdentifier; lngLat: LngLat; elevation: number; exempt: boolean }`.
  - `type ScanMap = Pick<MlMap, 'queryRenderedFeatures' | 'project' | 'getCenter' | 'getStyle' | 'getTerrain' | 'queryTerrainElevation'>`.
  - `class CandidateScanner { constructor(map: ScanMap, maxRoofLookups?: number); setExemptions(polygons: number[][][][]): void; clearRoofs(): void; scan(layerIds: string[], maxLabels: number): Candidate[] }`.

- [ ] **Step 1: Write the failing test**

`tests/unit/candidates.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  CandidateScanner,
  labelLayerIds,
  roofHeight,
  type ScanMap,
} from '../../src/labels/candidates';

describe('labelLayerIds', () => {
  const layers = [
    { id: 'pois', type: 'symbol', 'source-layer': 'pois' },
    { id: 'poi_omt', type: 'symbol', 'source-layer': 'poi', layout: { 'symbol-placement': 'point' } },
    { id: 'building_labels', type: 'symbol', 'source-layer': 'building' },
    { id: 'roads_labels', type: 'symbol', 'source-layer': 'roads', layout: { 'symbol-placement': 'line' } },
    { id: 'pois_line', type: 'symbol', 'source-layer': 'pois', layout: { 'symbol-placement': 'line' } },
    { id: 'places', type: 'symbol', 'source-layer': 'places' },
    { id: 'buildings', type: 'fill-extrusion', 'source-layer': 'buildings' },
  ];

  it('auto-detects point labels of POI and building layers', () => {
    expect(labelLayerIds(layers)).toEqual(['pois', 'poi_omt', 'building_labels']);
  });

  it('uses an override, keeping only layers that exist', () => {
    expect(labelLayerIds(layers, ['places', 'gone'])).toEqual(['places']);
  });
});

describe('roofHeight', () => {
  it('prefers render_height, then height, then min_height + 9, then 0', () => {
    expect(roofHeight({ render_height: 30, height: 20 })).toBe(30);
    expect(roofHeight({ height: '20' })).toBe(20);
    expect(roofHeight({ min_height: 6 })).toBe(15);
    expect(roofHeight({})).toBe(0);
  });
});

const BUILDING = {
  type: 'Polygon',
  coordinates: [
    [
      [2.0, 48.0],
      [2.002, 48.0],
      [2.002, 48.002],
      [2.0, 48.002],
      [2.0, 48.0],
    ],
  ],
};

function label(id: number | undefined, lng: number, lat: number, source = 'protomaps') {
  return { id, source, sourceLayer: 'pois', geometry: { type: 'Point', coordinates: [lng, lat] } };
}

function fakeMap(over: Partial<Record<string, unknown>> = {}) {
  const labels = [
    label(1, 2.001, 48.001), // on the building's roof
    label(1, 2.001, 48.001), // same label from a neighbouring tile
    label(2, 2.01, 48.01), // open ground, further from the centre
    label(undefined, 2.0, 48.0), // no id: cannot be tracked
  ];
  let terrain: object | null = null;
  const map = {
    labels,
    setTerrain: (t: object | null) => (terrain = t),
    getTerrain: () => terrain,
    queryTerrainElevation: vi.fn(() => 100),
    getCenter: () => ({ lng: 2.001, lat: 48.001 }),
    project: (ll: [number, number] | { lng: number; lat: number }) => {
      const [lng, lat] = Array.isArray(ll) ? ll : [ll.lng, ll.lat];
      return { x: (lng - 2) * 1e5, y: (48 - lat) * 1e5 };
    },
    getStyle: () => ({
      layers: [
        { id: 'pois', type: 'symbol' },
        { id: 'buildings', type: 'fill-extrusion' },
      ],
    }),
    queryRenderedFeatures: vi.fn((a: unknown, b?: { layers?: string[] }) => {
      const opts = (b ?? a) as { layers?: string[] };
      if (opts.layers?.includes('buildings')) {
        return [{ geometry: BUILDING, properties: { height: 30 } }];
      }
      return labels;
    }),
    ...over,
  };
  return map;
}
const asScan = (m: ReturnType<typeof fakeMap>) => m as unknown as ScanMap;

describe('CandidateScanner', () => {
  it('de-duplicates, drops id-less labels and orders by distance from the centre', () => {
    const map = fakeMap();
    const found = new CandidateScanner(asScan(map)).scan(['pois'], 10);
    expect(found.map((c) => c.key)).toEqual(['protomaps/pois/1', 'protomaps/pois/2']);
    expect(found[0]!.feature).toEqual({ source: 'protomaps', sourceLayer: 'pois', id: 1 });
  });

  it('caps at maxLabels', () => {
    expect(new CandidateScanner(asScan(fakeMap())).scan(['pois'], 1)).toHaveLength(1);
  });

  it('lifts probes above roofs and terrain', () => {
    const map = fakeMap();
    const s = new CandidateScanner(asScan(map));
    const [onRoof, onGround] = s.scan(['pois'], 10);
    expect(onRoof!.elevation).toBe(30 + 2.5);
    expect(onGround!.elevation).toBe(2.5);
    map.setTerrain({});
    expect(s.scan(['pois'], 10)[0]!.elevation).toBe(100 + 30 + 2.5);
  });

  it('caches roofs and spends at most the lookup budget per scan', () => {
    const map = fakeMap();
    const s = new CandidateScanner(asScan(map), 1);
    s.scan(['pois'], 10); // 1 label scan + 1 roof lookup (budget 1)
    expect(map.queryRenderedFeatures).toHaveBeenCalledTimes(2);
    s.scan(['pois'], 10); // label 1 cached; label 2 gets its lookup now
    expect(map.queryRenderedFeatures).toHaveBeenCalledTimes(4);
    s.scan(['pois'], 10); // both cached
    expect(map.queryRenderedFeatures).toHaveBeenCalledTimes(5);
    s.clearRoofs();
    s.scan(['pois'], 10);
    expect(map.queryRenderedFeatures).toHaveBeenCalledTimes(7);
  });

  it('marks labels inside exempt footprints and skips their roof lookup', () => {
    const map = fakeMap();
    const s = new CandidateScanner(asScan(map));
    s.setExemptions([BUILDING.coordinates]);
    const [exempt, other] = s.scan(['pois'], 10);
    expect(exempt!.exempt).toBe(true);
    expect(other!.exempt).toBe(false);
    expect(map.queryRenderedFeatures).toHaveBeenCalledTimes(2); // labels + label 2's roof
  });

  it('never queries with an empty layer list', () => {
    const map = fakeMap();
    expect(new CandidateScanner(asScan(map)).scan([], 10)).toEqual([]);
    expect(map.queryRenderedFeatures).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/candidates.test.ts`
Expected: FAIL, cannot resolve `../../src/labels/candidates`.

- [ ] **Step 3: Implement**

`src/labels/candidates.ts`:

```ts
import type { FeatureIdentifier, Map as MlMap } from 'maplibre-gl';
import { pointInPolygons, polygonsOf } from '../core/geometry';
import type { LngLat } from '../core/types';

const LABEL_SOURCE_LAYERS = ['pois', 'poi', 'buildings', 'building'];
/** Probes sit this far above the ground or roof so the surface itself never hides them. */
const PROBE_LIFT_M = 2.5;
/** Assumed storey height when a building only has a base height. */
const STOREY_M = 9;
const MAX_ROOF_CACHE = 2048;

export interface StyleLayerLike {
  id: string;
  type: string;
  'source-layer'?: string;
  layout?: Record<string, unknown>;
}

/** Point labels of POI and building layers, or the existing layers of `override`. */
export function labelLayerIds(layers: StyleLayerLike[], override?: string[]): string[] {
  if (override) return override.filter((id) => layers.some((l) => l.id === id));
  return layers
    .filter(
      (l) =>
        l.type === 'symbol' &&
        (l.layout?.['symbol-placement'] ?? 'point') === 'point' &&
        LABEL_SOURCE_LAYERS.includes(l['source-layer'] ?? ''),
    )
    .map((l) => l.id);
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' && v !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};

/** Roof height of an extruded building from its tile properties. */
export function roofHeight(p: Record<string, unknown>): number {
  const min = num(p.min_height);
  return num(p.render_height) ?? num(p.height) ?? (min !== undefined ? min + STOREY_M : 0);
}

export interface Candidate {
  /** `source/sourceLayer/id`. */
  key: string;
  feature: FeatureIdentifier;
  lngLat: LngLat;
  /** Probe height in metres above sea level (terrain exaggeration included). */
  elevation: number;
  /** Inside a landmark footprint: never probed, always shown. */
  exempt: boolean;
}

export type ScanMap = Pick<
  MlMap,
  | 'queryRenderedFeatures'
  | 'project'
  | 'getCenter'
  | 'getStyle'
  | 'getTerrain'
  | 'queryTerrainElevation'
>;

interface Found {
  key: string;
  feature: FeatureIdentifier;
  lngLat: LngLat;
  distance: number;
}

/** Finds the labels on screen and where to probe each one. */
export class CandidateScanner {
  private readonly roofs = new Map<string, { lng: number; lat: number; roof: number }>();
  private exemptions: number[][][][] = [];

  constructor(
    private readonly map: ScanMap,
    private readonly maxRoofLookups = 48,
  ) {}

  setExemptions(polygons: number[][][][]): void {
    this.exemptions = polygons;
  }

  clearRoofs(): void {
    this.roofs.clear();
  }

  scan(layerIds: string[], maxLabels: number): Candidate[] {
    if (!layerIds.length) return [];
    const centre = this.map.project(this.map.getCenter());
    const found = new Map<string, Found>();
    for (const f of this.map.queryRenderedFeatures({ layers: layerIds })) {
      if (f.id === undefined || f.id === null || f.geometry.type !== 'Point') continue;
      const key = `${f.source}/${f.sourceLayer ?? ''}/${f.id}`;
      if (found.has(key)) continue;
      const lngLat = f.geometry.coordinates as LngLat;
      const p = this.map.project(lngLat);
      found.set(key, {
        key,
        feature: { source: f.source, sourceLayer: f.sourceLayer, id: f.id },
        lngLat,
        distance: Math.hypot(p.x - centre.x, p.y - centre.y),
      });
    }
    const nearest = [...found.values()]
      .sort((a, b) => a.distance - b.distance)
      .slice(0, maxLabels);
    const extrusions = (this.map.getStyle()?.layers ?? [])
      .filter((l) => l.type === 'fill-extrusion')
      .map((l) => l.id);
    const terrain = !!this.map.getTerrain();
    let budget = this.maxRoofLookups;
    return nearest.map(({ key, feature, lngLat }) => {
      const exempt = pointInPolygons(lngLat, this.exemptions);
      let roof = 0;
      if (!exempt && extrusions.length) {
        const cached = this.roofs.get(key);
        if (cached && cached.lng === lngLat[0] && cached.lat === lngLat[1]) roof = cached.roof;
        else if (budget > 0) {
          budget--;
          roof = this.lookupRoof(lngLat, extrusions);
          this.remember(key, lngLat, roof);
        }
      }
      const ground = terrain ? (this.map.queryTerrainElevation(lngLat) ?? 0) : 0;
      return { key, feature, lngLat, elevation: ground + roof + PROBE_LIFT_M, exempt };
    });
  }

  private lookupRoof(lngLat: LngLat, layers: string[]): number {
    let roof = 0;
    for (const f of this.map.queryRenderedFeatures(this.map.project(lngLat), { layers })) {
      const geometry = f.geometry as { type: string; coordinates: unknown };
      if (pointInPolygons(lngLat, polygonsOf(geometry))) {
        roof = Math.max(roof, roofHeight((f.properties ?? {}) as Record<string, unknown>));
      }
    }
    return roof;
  }

  private remember(key: string, [lng, lat]: LngLat, roof: number): void {
    this.roofs.delete(key);
    this.roofs.set(key, { lng, lat, roof });
    while (this.roofs.size > MAX_ROOF_CACHE) this.roofs.delete(this.roofs.keys().next().value!);
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx tsc --noEmit && npx vitest run tests/unit/candidates.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Format, leave uncommitted**

Run: `npx prettier --write src/labels tests/unit/candidates.test.ts`

---

### Task 4: Exemption registry and landmarks integration

**Files:**
- Create: `src/labels/exemptions.ts`
- Modify: `src/landmarks/LandmarksModule.ts` (register a provider on add, notify on change, unregister on remove)
- Test: `tests/unit/exemptions.test.ts` (new), `tests/unit/landmarks.test.ts` (one new test)

**Interfaces:**
- Consumes: `footprintOf(entry, insetM)` from `src/landmarks/replacement.ts`.
- Produces: `setExemptionSource(map: object, owner: string, provider: (() => number[][][][]) | null): void`; `exemptionsFor(map: object): number[][][][]`; `notifyExemptionsChanged(map: object): void`; `onExemptionsChanged(map: object, listener: (() => void) | null): void`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/exemptions.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  exemptionsFor,
  notifyExemptionsChanged,
  onExemptionsChanged,
  setExemptionSource,
} from '../../src/labels/exemptions';

const A = [[[[0, 0], [1, 0], [1, 1], [0, 0]]]];
const B = [[[[5, 5], [6, 5], [6, 6], [5, 5]]]];

describe('exemption registry', () => {
  it('pulls every owner’s footprints per map and notifies the listener', () => {
    const map = {};
    const other = {};
    const listener = vi.fn();
    onExemptionsChanged(map, listener);
    setExemptionSource(map, 'landmarks', () => A);
    setExemptionSource(map, 'other', () => B);
    expect(exemptionsFor(map)).toEqual([...A, ...B]);
    expect(exemptionsFor(other)).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(2);
    notifyExemptionsChanged(map);
    expect(listener).toHaveBeenCalledTimes(3);
    setExemptionSource(map, 'landmarks', null);
    expect(exemptionsFor(map)).toEqual(B);
    onExemptionsChanged(map, null);
    notifyExemptionsChanged(map);
    expect(listener).toHaveBeenCalledTimes(4);
  });
});
```

Append to the `describe('LandmarksModule', …)` block in `tests/unit/landmarks.test.ts` (and add `import { exemptionsFor, onExemptionsChanged } from '../../src/labels/exemptions';` at the top):

```ts
  it('exempts the footprints of shown landmarks from label occlusion', async () => {
    const s = setup();
    const listener = vi.fn();
    onExemptionsChanged(s.map, listener);
    expect(exemptionsFor(s.map)).toEqual([]);
    await loadEiffel(s);
    expect(exemptionsFor(s.map)).toHaveLength(1); // the fixture's bounds rectangle
    expect(listener).toHaveBeenCalled();
    s.module.onRemove();
    expect(exemptionsFor(s.map)).toEqual([]);
    onExemptionsChanged(s.map, null);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/unit/exemptions.test.ts tests/unit/landmarks.test.ts`
Expected: FAIL, cannot resolve `../../src/labels/exemptions`.

- [ ] **Step 3: Implement the registry**

`src/labels/exemptions.ts`:

```ts
/**
 * Per-map footprints whose labels must never be occluded (a landmark's own label). Owners
 * register a provider; the occlusion layer pulls on every scan, so add order does not matter.
 */
type Provider = () => number[][][][];

const providers = new WeakMap<object, Map<string, Provider>>();
const listeners = new WeakMap<object, () => void>();

export function setExemptionSource(map: object, owner: string, provider: Provider | null): void {
  let byOwner = providers.get(map);
  if (provider) {
    if (!byOwner) providers.set(map, (byOwner = new Map()));
    byOwner.set(owner, provider);
  } else {
    byOwner?.delete(owner);
  }
  notifyExemptionsChanged(map);
}

export function exemptionsFor(map: object): number[][][][] {
  return [...(providers.get(map)?.values() ?? [])].flatMap((provide) => provide());
}

export function notifyExemptionsChanged(map: object): void {
  listeners.get(map)?.();
}

/** The map's occlusion layer subscribes here (one listener per map). */
export function onExemptionsChanged(map: object, listener: (() => void) | null): void {
  if (listener) listeners.set(map, listener);
  else listeners.delete(map);
}
```

- [ ] **Step 4: Wire it into `LandmarksModule`**

In `src/landmarks/LandmarksModule.ts`:

1. Imports:

```ts
import { notifyExemptionsChanged, setExemptionSource } from '../labels/exemptions';
import { BuildingReplacement, footprintOf } from './replacement';
```

(replace the existing `import { BuildingReplacement } from './replacement';`).

2. Field next to `replacing`:

```ts
  /** Keys of `replacing` last reported to label occlusion. */
  private exemptKey = '';
```

3. At the end of `onAdd(ctx)`:

```ts
    setExemptionSource(ctx.map, this.id, () =>
      [...this.replacing.values()].flatMap((entry) => footprintOf(entry, 0)),
    );
```

4. At the end of `applyFades()`:

```ts
    const exemptKey = [...this.replacing.keys()].sort().join('|');
    if (exemptKey !== this.exemptKey && this.ctx) {
      this.exemptKey = exemptKey;
      notifyExemptionsChanged(this.ctx.map);
    }
```

5. In `onRemove()`, before `this.ctx = undefined;`:

```ts
    if (this.ctx) setExemptionSource(this.ctx.map, this.id, null);
    this.exemptKey = '';
```

- [ ] **Step 5: Run everything**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 6: Format, leave uncommitted**

Run: `npx prettier --write src/labels src/landmarks tests/unit`

---

### Task 5: GPU occlusion probe

**Files:**
- Create: `src/labels/probe.ts`, `tests/unit/fakeGl.ts`
- Test: `tests/unit/probe.test.ts`

**Interfaces:**
- Consumes: `mercatorX`, `mercatorY`, `mercatorUnitsPerMetre` from `src/core/mercator`.
- Produces: `interface ProbeTarget { key: string; lngLat: LngLat; elevation: number }`; `class OcclusionProbe { constructor(gl: WebGL2RenderingContext); setTargets(targets: ProbeTarget[]): void; draw(mainMatrix: ArrayLike<number>, pointSizePx: number): void; poll(): Map<string, boolean>; readonly pending: boolean; readonly needsDraw: boolean; dispose(): void }`. `fakeGl()` test helper returning `{ gl, state, drawn, answer, failCompile }`.

- [ ] **Step 1: Write the fake GL helper**

`tests/unit/fakeGl.ts`:

```ts
import { vi } from 'vitest';

const C = {
  VERTEX_SHADER: 0x8b31,
  FRAGMENT_SHADER: 0x8b30,
  COMPILE_STATUS: 0x8b81,
  LINK_STATUS: 0x8b82,
  ARRAY_BUFFER: 0x8892,
  ARRAY_BUFFER_BINDING: 0x8894,
  CURRENT_PROGRAM: 0x8b8d,
  VERTEX_ARRAY_BINDING: 0x85b5,
  COLOR_WRITEMASK: 0x0c23,
  DEPTH_WRITEMASK: 0x0b72,
  DEPTH_TEST: 0x0b71,
  DEPTH_FUNC: 0x0b74,
  LESS: 0x0201,
  LEQUAL: 0x0203,
  FLOAT: 0x1406,
  POINTS: 0x0000,
  DYNAMIC_DRAW: 0x88e8,
  ANY_SAMPLES_PASSED_CONSERVATIVE: 0x8d6a,
  QUERY_RESULT: 0x8866,
  QUERY_RESULT_AVAILABLE: 0x8867,
};

/** Minimal WebGL2 stand-in: tracks the state the probe must restore and its queries. */
export function fakeGl() {
  let next = 1;
  const handle = () => ({ id: next++ });
  const mapleState = { program: handle(), vao: handle(), buffer: handle() };
  const state = {
    program: mapleState.program as unknown,
    vao: mapleState.vao as unknown,
    buffer: mapleState.buffer as unknown,
    colorMask: [true, true, true, true],
    depthMask: true,
    depthTest: false,
    depthFunc: C.LESS,
  };
  const queries = new Map<object, { available: boolean; result: number }>();
  const drawn: { first: number; query: object }[] = [];
  let active: object | null = null;
  let compileOk = true;
  const gl = {
    ...C,
    createShader: vi.fn(handle),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: () => compileOk,
    getShaderInfoLog: () => 'boom',
    deleteShader: vi.fn(),
    createProgram: vi.fn(handle),
    attachShader: vi.fn(),
    bindAttribLocation: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    deleteProgram: vi.fn(),
    getUniformLocation: (_p: unknown, name: string) => ({ name }),
    createBuffer: vi.fn(handle),
    deleteBuffer: vi.fn(),
    createVertexArray: vi.fn(handle),
    deleteVertexArray: vi.fn(),
    bindBuffer: (_t: number, b: unknown) => (state.buffer = b),
    bindVertexArray: (v: unknown) => (state.vao = v),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    bufferData: vi.fn(),
    useProgram: (p: unknown) => (state.program = p),
    uniformMatrix4fv: vi.fn(),
    uniform1f: vi.fn(),
    colorMask: (...m: boolean[]) => (state.colorMask = m),
    depthMask: (m: boolean) => (state.depthMask = m),
    enable: (cap: number) => cap === C.DEPTH_TEST && (state.depthTest = true),
    disable: (cap: number) => cap === C.DEPTH_TEST && (state.depthTest = false),
    isEnabled: (cap: number) => cap === C.DEPTH_TEST && state.depthTest,
    depthFunc: (f: number) => (state.depthFunc = f),
    getParameter(p: number): unknown {
      switch (p) {
        case C.CURRENT_PROGRAM:
          return state.program;
        case C.VERTEX_ARRAY_BINDING:
          return state.vao;
        case C.ARRAY_BUFFER_BINDING:
          return state.buffer;
        case C.COLOR_WRITEMASK:
          return [...state.colorMask];
        case C.DEPTH_WRITEMASK:
          return state.depthMask;
        case C.DEPTH_FUNC:
          return state.depthFunc;
        default:
          return null;
      }
    },
    createQuery: vi.fn(() => {
      const q = handle();
      queries.set(q, { available: false, result: 0 });
      return q;
    }),
    deleteQuery: vi.fn(),
    beginQuery: (_t: number, q: object) => {
      active = q;
      queries.get(q)!.available = false;
    },
    endQuery: () => (active = null),
    drawArrays: (_mode: number, first: number) => drawn.push({ first, query: active! }),
    getQueryParameter: (q: object, p: number) => {
      const s = queries.get(q)!;
      return p === C.QUERY_RESULT_AVAILABLE ? s.available : s.result;
    },
    isContextLost: () => false,
  };
  /** Answer every query drawn so far; `visible(first)` decides each probe's result. */
  const answer = (visible: (first: number) => boolean) => {
    for (const d of drawn) Object.assign(queries.get(d.query)!, { available: true, result: +visible(d.first) });
    drawn.length = 0;
  };
  const failCompile = () => (compileOk = false);
  return { gl: gl as unknown as WebGL2RenderingContext, raw: gl, state, mapleState, drawn, answer, failCompile };
}
```

- [ ] **Step 2: Write the failing test**

`tests/unit/probe.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Matrix4 } from 'three';
import { OcclusionProbe } from '../../src/labels/probe';
import { fakeGl } from './fakeGl';

const MAIN = new Matrix4().makeScale(2, 2, 2).toArray();
const A = { key: 'a', lngLat: [2.29, 48.85] as [number, number], elevation: 2.5 };
const B = { key: 'b', lngLat: [2.3, 48.86] as [number, number], elevation: 2.5 };

describe('OcclusionProbe', () => {
  it('draws one query per target and restores every piece of GL state', () => {
    const f = fakeGl();
    const probe = new OcclusionProbe(f.gl);
    probe.setTargets([A, B]);
    probe.draw(MAIN, 4);
    expect(f.drawn.map((d) => d.first)).toEqual([0, 1]);
    expect(f.state).toMatchObject({
      program: f.mapleState.program,
      vao: f.mapleState.vao,
      buffer: f.mapleState.buffer,
      colorMask: [true, true, true, true],
      depthMask: true,
      depthTest: false,
      depthFunc: f.raw.LESS,
    });
    expect(probe.pending).toBe(true);
  });

  it('reads results only once available, then re-probes', () => {
    const f = fakeGl();
    const probe = new OcclusionProbe(f.gl);
    probe.setTargets([A, B]);
    probe.draw(MAIN, 4);
    expect(probe.poll().size).toBe(0); // nothing available yet
    probe.draw(MAIN, 4); // queries still in flight: nothing new drawn
    expect(f.drawn).toHaveLength(2);
    f.answer((first) => first === 0);
    expect(probe.poll()).toEqual(new Map([['a', true], ['b', false]]));
    expect(probe.pending).toBe(false);
    probe.draw(MAIN, 4); // answered → probed again (keeps up while panning)
    expect(f.drawn).toHaveLength(2);
    expect(f.raw.createQuery).toHaveBeenCalledTimes(2); // queries reused from the pool
  });

  it('discards answers for moved or dropped targets', () => {
    const f = fakeGl();
    const probe = new OcclusionProbe(f.gl);
    probe.setTargets([A, B]);
    probe.draw(MAIN, 4);
    probe.setTargets([{ ...A, elevation: 40 }]); // A moved, B dropped
    f.answer(() => true);
    expect(probe.poll().size).toBe(0);
    expect(probe.needsDraw).toBe(true);
    probe.draw(MAIN, 4);
    f.answer(() => false);
    expect(probe.poll()).toEqual(new Map([['a', false]]));
  });

  it('folds the origin into the matrix in float64 and uploads relative positions', () => {
    const f = fakeGl();
    const probe = new OcclusionProbe(f.gl);
    probe.setTargets([A, B]);
    probe.draw(new Matrix4().identity().toArray(), 4);
    const matrix = f.raw.uniformMatrix4fv.mock.calls[0]![2] as Float32Array;
    const positions = f.raw.bufferData.mock.calls[0]![1] as Float32Array;
    expect(positions[0]).toBe(0); // first target is the origin
    expect(positions[1]).toBe(0);
    expect(matrix[12]).toBeCloseTo((A.lngLat[0] + 180) / 360, 6);
  });

  it('throws on shader failure and deletes its objects on dispose', () => {
    const bad = fakeGl();
    bad.failCompile();
    expect(() => new OcclusionProbe(bad.gl)).toThrow(/label probe/);
    const f = fakeGl();
    const probe = new OcclusionProbe(f.gl);
    probe.setTargets([A]);
    probe.draw(MAIN, 4);
    probe.dispose();
    expect(f.raw.deleteQuery).toHaveBeenCalledTimes(1);
    expect(f.raw.deleteBuffer).toHaveBeenCalled();
    expect(f.raw.deleteVertexArray).toHaveBeenCalled();
    expect(f.raw.deleteProgram).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/unit/probe.test.ts`
Expected: FAIL, cannot resolve `../../src/labels/probe`.

- [ ] **Step 4: Implement**

`src/labels/probe.ts`:

```ts
import { mercatorUnitsPerMetre, mercatorX, mercatorY } from '../core/mercator';
import type { LngLat } from '../core/types';

export interface ProbeTarget {
  key: string;
  lngLat: LngLat;
  /** Metres above sea level. */
  elevation: number;
}

const VERTEX = `#version 300 es
in vec3 a_pos;
uniform mat4 u_matrix;
uniform float u_size;
void main() { gl_Position = u_matrix * vec4(a_pos, 1.0); gl_PointSize = u_size; }`;

const FRAGMENT = `#version 300 es
precision lowp float;
out vec4 color;
void main() { color = vec4(0.0); }`;

interface Slot {
  key: string;
  x: number;
  y: number;
  z: number;
  /** Bumped whenever the probe position changes; answers for older revisions are stale. */
  revision: number;
  answered?: number;
  query?: InFlight;
}

interface InFlight {
  handle: WebGLQuery;
  slot: Slot;
  revision: number;
}

/** `main × translate(origin)`, computed in float64 so small relative positions stay exact. */
function translated(m: ArrayLike<number>, ox: number, oy: number): Float32Array {
  const out = new Float32Array(16);
  for (let i = 0; i < 16; i++) out[i] = m[i]!;
  for (let r = 0; r < 4; r++) out[12 + r] = m[r]! * ox + m[4 + r]! * oy + m[12 + r]!;
  return out;
}

/**
 * Draws one invisible point per label inside an occlusion query, against the depth buffer the
 * 3D layers left behind. Call `draw` only from a MapLibre render callback; `poll` any time.
 */
export class OcclusionProbe {
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly buffer: WebGLBuffer;
  private readonly uMatrix: WebGLUniformLocation | null;
  private readonly uSize: WebGLUniformLocation | null;
  private slots: Slot[] = [];
  private byKey = new Map<string, Slot>();
  private origin: [number, number] = [0, 0];
  private uploaded = true;
  private readonly inFlight = new Set<InFlight>();
  private pool: WebGLQuery[] = [];

  constructor(private readonly gl: WebGL2RenderingContext) {
    const shader = (type: number, source: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s);
        gl.deleteShader(s);
        throw new Error(`label probe shader: ${log}`);
      }
      return s;
    };
    const vs = shader(gl.VERTEX_SHADER, VERTEX);
    const fs = shader(gl.FRAGMENT_SHADER, FRAGMENT);
    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, 'a_pos');
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`label probe program: ${log}`);
    }
    this.program = program;
    this.uMatrix = gl.getUniformLocation(program, 'u_matrix');
    this.uSize = gl.getUniformLocation(program, 'u_size');
    this.buffer = gl.createBuffer()!;
    this.vao = gl.createVertexArray()!;
    const vao = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null;
    const buffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  }

  get pending(): boolean {
    return this.inFlight.size > 0;
  }

  /** Some target has no current answer and no query in flight: draw again. */
  get needsDraw(): boolean {
    return this.slots.some((s) => !s.query && s.answered !== s.revision);
  }

  /** Replace the probed set. Positions upload on the next `draw`. */
  setTargets(targets: ProbeTarget[]): void {
    const next = new Map<string, Slot>();
    this.slots = targets.map((t) => {
      const [lng, lat] = t.lngLat;
      const x = mercatorX(lng);
      const y = mercatorY(lat);
      const z = t.elevation * mercatorUnitsPerMetre(lat);
      let slot = this.byKey.get(t.key);
      if (!slot) slot = { key: t.key, x, y, z, revision: 0 };
      else if (slot.x !== x || slot.y !== y || slot.z !== z) {
        Object.assign(slot, { x, y, z });
        slot.revision++;
      }
      next.set(t.key, slot);
      return slot;
    });
    this.byKey = next;
    this.origin = this.slots.length ? [this.slots[0]!.x, this.slots[0]!.y] : [0, 0];
    this.uploaded = false;
  }

  draw(mainMatrix: ArrayLike<number>, pointSizePx: number): void {
    if (!this.slots.length) return;
    const gl = this.gl;
    const saved = {
      program: gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null,
      vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null,
      buffer: gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null,
      colors: gl.getParameter(gl.COLOR_WRITEMASK) as boolean[],
      depthMask: gl.getParameter(gl.DEPTH_WRITEMASK) as boolean,
      depthTest: gl.isEnabled(gl.DEPTH_TEST),
      depthFunc: gl.getParameter(gl.DEPTH_FUNC) as number,
    };
    try {
      if (!this.uploaded) {
        const [ox, oy] = this.origin;
        const data = new Float32Array(this.slots.length * 3);
        this.slots.forEach((s, i) => data.set([s.x - ox, s.y - oy, s.z], i * 3));
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
        this.uploaded = true;
      }
      gl.useProgram(this.program);
      gl.bindVertexArray(this.vao);
      gl.uniformMatrix4fv(this.uMatrix, false, translated(mainMatrix, ...this.origin));
      gl.uniform1f(this.uSize, pointSizePx);
      gl.colorMask(false, false, false, false);
      gl.depthMask(false);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      this.slots.forEach((slot, i) => {
        if (slot.query) return;
        const handle = this.pool.pop() ?? gl.createQuery()!;
        const query: InFlight = { handle, slot, revision: slot.revision };
        slot.query = query;
        this.inFlight.add(query);
        gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE, handle);
        gl.drawArrays(gl.POINTS, i, 1);
        gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE);
      });
    } finally {
      gl.colorMask(saved.colors[0]!, saved.colors[1]!, saved.colors[2]!, saved.colors[3]!);
      gl.depthMask(saved.depthMask);
      gl.depthFunc(saved.depthFunc);
      if (saved.depthTest) gl.enable(gl.DEPTH_TEST);
      else gl.disable(gl.DEPTH_TEST);
      gl.bindVertexArray(saved.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, saved.buffer);
      gl.useProgram(saved.program);
    }
  }

  /** Finished answers since the last poll: label key → visible. Stale answers are dropped. */
  poll(): Map<string, boolean> {
    const gl = this.gl;
    const out = new Map<string, boolean>();
    for (const q of [...this.inFlight]) {
      if (!gl.getQueryParameter(q.handle, gl.QUERY_RESULT_AVAILABLE)) continue;
      const passed = !!gl.getQueryParameter(q.handle, gl.QUERY_RESULT);
      this.inFlight.delete(q);
      this.pool.push(q.handle);
      q.slot.query = undefined;
      if (this.byKey.get(q.slot.key) !== q.slot || q.revision !== q.slot.revision) continue;
      q.slot.answered = q.revision;
      out.set(q.slot.key, passed);
    }
    return out;
  }

  dispose(): void {
    const gl = this.gl;
    for (const q of this.inFlight) gl.deleteQuery(q.handle);
    for (const handle of this.pool) gl.deleteQuery(handle);
    this.inFlight.clear();
    this.pool = [];
    gl.deleteBuffer(this.buffer);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
  }
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx tsc --noEmit && npx vitest run tests/unit/probe.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Format, leave uncommitted**

Run: `npx prettier --write src/labels tests/unit/probe.test.ts tests/unit/fakeGl.ts`

---

### Task 6: The `LabelOcclusion` layer

**Files:**
- Create: `src/labels/LabelOcclusion.ts`
- Modify: `src/index.ts` (exports)
- Test: `tests/unit/labelOcclusion.test.ts`

**Interfaces:**
- Consumes: `LabelOpacity`, `LABEL_STATE` (Task 2); `CandidateScanner`, `labelLayerIds`, `Candidate` (Task 3); `exemptionsFor`, `onExemptionsChanged` (Task 4); `OcclusionProbe` (Task 5); `Tweens` from `src/landmarks/fade.ts` (`set`, `to`, `value`, `delete`, `clear`, `step`, `active`).
- Produces: `class LabelOcclusion implements CustomLayerInterface` with `constructor(options?: LabelOcclusionOptions)`, `readonly id`, `refresh(): void`; `interface LabelOcclusionOptions { id?: string; labelLayers?: string[]; minZoom?: number; fadeMs?: number; maxLabels?: number; onError?: (err: unknown) => void }`.

- [ ] **Step 1: Write the failing test**

`tests/unit/labelOcclusion.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Matrix4 } from 'three';
import type { Map as MlMap } from 'maplibre-gl';
import { LabelOcclusion } from '../../src/labels/LabelOcclusion';
import { setExemptionSource } from '../../src/labels/exemptions';
import { LABEL_STATE } from '../../src/labels/opacity';
import { fakeGl } from './fakeGl';

const FRAME = {
  defaultProjectionData: { mainMatrix: new Matrix4().toArray(), projectionTransition: 0 },
} as never;

function fakeMap() {
  const handlers = new Map<string, (e?: unknown) => void>();
  const styleLayers = [
    { id: 'roads', type: 'line' },
    { id: 'landmarks', type: 'custom' },
    { id: 'pois', type: 'symbol', 'source-layer': 'pois' },
  ];
  const order = ['roads', 'landmarks', 'pois', 'label-occlusion'];
  const paint: Record<string, Record<string, unknown>> = { pois: { 'text-opacity': 1 } };
  const states = new Map<unknown, Record<string, unknown>>();
  const point = (id: number, lng: number) => ({
    id,
    source: 'protomaps',
    sourceLayer: 'pois',
    geometry: { type: 'Point', coordinates: [lng, 48.85] },
  });
  const map = {
    handlers,
    styleLayers,
    order,
    paint,
    states,
    zoom: 16,
    labels: [point(1, 2.29), point(2, 2.3)],
    on: vi.fn((t: string, fn: (e?: unknown) => void) => handlers.set(t, fn)),
    off: vi.fn((t: string) => handlers.delete(t)),
    getZoom: () => map.zoom,
    getCenter: () => ({ lng: 2.29, lat: 48.85 }),
    project: () => ({ x: 0, y: 0 }),
    getTerrain: () => null,
    queryTerrainElevation: () => 0,
    getStyle: () => ({ layers: styleLayers }),
    getLayer: (id: string) =>
      id === 'label-occlusion' && order.includes(id)
        ? { id, type: 'custom' }
        : styleLayers.find((l) => l.id === id),
    getLayersOrder: () => [...order],
    moveLayer: vi.fn((id: string, before?: string) => {
      order.splice(order.indexOf(id), 1);
      order.splice(before ? order.indexOf(before) : order.length, 0, id);
    }),
    queryRenderedFeatures: vi.fn((opts: { layers: string[] }) => {
      for (const id of opts.layers) if (!styleLayers.some((l) => l.id === id)) throw new Error(id);
      return map.labels;
    }),
    getPaintProperty: (id: string, p: string) => paint[id]?.[p],
    setPaintProperty: vi.fn((id: string, p: string, v: unknown) => ((paint[id] ??= {})[p] = v)),
    setFeatureState: vi.fn((f: { id: unknown }, s: Record<string, unknown>) =>
      states.set(f.id, { ...states.get(f.id), ...s }),
    ),
    removeFeatureState: vi.fn((f: { id: unknown }) => states.delete(f.id)),
    triggerRepaint: vi.fn(),
  };
  return map;
}

const stateOf = (m: ReturnType<typeof fakeMap>, id: number) =>
  m.states.get(id)?.[LABEL_STATE] as number | undefined;

function setup(options = {}) {
  const map = fakeMap();
  const f = fakeGl();
  const layer = new LabelOcclusion({ fadeMs: 0, ...options });
  layer.onAdd(map as unknown as MlMap, f.gl);
  vi.advanceTimersByTime(0); // first scan
  return { map, f, layer };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('LabelOcclusion', () => {
  it('moves itself between the 3D layers and the first label layer', () => {
    const { map } = setup();
    expect(map.order).toEqual(['roads', 'landmarks', 'label-occlusion', 'pois']);
  });

  it('wraps label opacity and hides labels whose probe is occluded', () => {
    const { map, f, layer } = setup();
    expect(map.paint.pois!['text-opacity']).toEqual([
      '*',
      1,
      ['coalesce', ['feature-state', LABEL_STATE], 1],
    ]);
    layer.render(f.gl, FRAME);
    expect(f.drawn).toHaveLength(2);
    f.answer((first) => first === 0); // label 1 visible, label 2 behind something
    vi.advanceTimersByTime(20); // result polling frame
    expect(stateOf(map, 1)).toBe(1);
    expect(stateOf(map, 2)).toBe(0);
  });

  it('never hides labels inside an exempt footprint', () => {
    const map0 = fakeMap();
    setExemptionSource(map0, 'landmarks', () => [
      [
        [
          [2.28, 48.84],
          [2.295, 48.84],
          [2.295, 48.86],
          [2.28, 48.86],
          [2.28, 48.84],
        ],
      ],
    ]);
    const f = fakeGl();
    const layer = new LabelOcclusion({ fadeMs: 0 });
    layer.onAdd(map0 as unknown as MlMap, f.gl);
    vi.advanceTimersByTime(0);
    layer.render(f.gl, FRAME);
    expect(f.drawn.map((d) => d.first)).toEqual([0]); // only label 2 is probed
    f.answer(() => false);
    vi.advanceTimersByTime(20);
    expect(stateOf(map0, 1)).toBe(1);
    expect(stateOf(map0, 2)).toBe(0);
    setExemptionSource(map0, 'landmarks', null);
  });

  it('shows everything below minZoom and stops probing', () => {
    const { map, f, layer } = setup();
    layer.render(f.gl, FRAME);
    f.answer(() => false);
    vi.advanceTimersByTime(20);
    expect(stateOf(map, 1)).toBe(0);
    map.zoom = 14;
    map.handlers.get('moveend')!();
    vi.advanceTimersByTime(100);
    expect(map.states.has(1)).toBe(false); // dropped labels are reset to the default (shown)
    layer.render(f.gl, FRAME);
    expect(f.drawn).toHaveLength(0);
  });

  it('only scans label layers that still exist', () => {
    const { map } = setup();
    map.styleLayers.splice(2, 1); // app removed the POI layer
    map.handlers.get('moveend')!();
    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
  });

  it('does nothing without label layers or without WebGL2', () => {
    const map = fakeMap();
    map.styleLayers.splice(2, 1);
    const f = fakeGl();
    const layer = new LabelOcclusion({ fadeMs: 0 });
    layer.onAdd(map as unknown as MlMap, f.gl);
    vi.advanceTimersByTime(0);
    expect(map.queryRenderedFeatures).not.toHaveBeenCalled();
    const { f: f2, layer: l2 } = setup();
    const webgl1 = { ...f2.raw, createQuery: undefined } as unknown as WebGL2RenderingContext;
    expect(() => l2.render(webgl1, FRAME)).not.toThrow();
    expect(f2.drawn).toHaveLength(0);
  });

  it('shows all labels on context loss and rebuilds after restore', () => {
    const { map, f, layer } = setup();
    layer.render(f.gl, FRAME);
    f.answer(() => false);
    vi.advanceTimersByTime(20);
    expect(stateOf(map, 2)).toBe(0);
    map.handlers.get('webglcontextlost')!();
    vi.advanceTimersByTime(20);
    expect(stateOf(map, 2)).toBe(1);
    const restored = fakeGl();
    map.handlers.get('webglcontextrestored')!();
    vi.advanceTimersByTime(0);
    layer.render(restored.gl, FRAME);
    expect(restored.drawn).toHaveLength(2); // a fresh probe on the new context
  });

  it('reports shader failures once and leaves labels alone', () => {
    const onError = vi.fn();
    const { map, layer } = setup({ onError });
    const bad = fakeGl();
    bad.failCompile();
    layer.render(bad.gl, FRAME);
    layer.render(bad.gl, FRAME);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(stateOf(map, 2)).not.toBe(0);
  });

  it('removal restores paint, clears feature-state and deletes GL objects', () => {
    const { map, f, layer } = setup();
    layer.render(f.gl, FRAME);
    f.answer(() => false);
    vi.advanceTimersByTime(20);
    layer.onRemove(map as unknown as MlMap, f.gl);
    expect(map.paint.pois!['text-opacity']).toBe(1);
    expect(map.states.size).toBe(0);
    expect(f.raw.deleteProgram).toHaveBeenCalled();
    expect(map.handlers.size).toBe(0);
  });

  it('re-wraps after a diffed setStyle and tears down cleanly after a full one', () => {
    const { map, f, layer } = setup();
    layer.render(f.gl, FRAME);
    f.answer(() => false);
    vi.advanceTimersByTime(20);
    // Diffed: paint reset by the new style, layer kept.
    map.paint.pois!['text-opacity'] = 0.9;
    map.handlers.get('style.load')!();
    vi.advanceTimersByTime(0);
    expect(map.paint.pois!['text-opacity']).toEqual([
      '*',
      0.9,
      ['coalesce', ['feature-state', LABEL_STATE], 1],
    ]);
    // Full: our layer is gone and the new style must not be touched.
    map.order.splice(map.order.indexOf('label-occlusion'), 1);
    map.paint.pois!['text-opacity'] = 0.7;
    map.setPaintProperty.mockClear();
    map.removeFeatureState.mockClear();
    map.handlers.get('style.load')!();
    expect(map.setPaintProperty).not.toHaveBeenCalled();
    expect(map.removeFeatureState).not.toHaveBeenCalled();
    expect(map.handlers.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/labelOcclusion.test.ts`
Expected: FAIL, cannot resolve `../../src/labels/LabelOcclusion`.

- [ ] **Step 3: Implement**

`src/labels/LabelOcclusion.ts`:

```ts
import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  FeatureIdentifier,
  Map as MlMap,
} from 'maplibre-gl';
import { Tweens } from '../landmarks/fade';
import { CandidateScanner, labelLayerIds, type Candidate } from './candidates';
import { exemptionsFor, onExemptionsChanged } from './exemptions';
import { LABEL_STATE, LabelOpacity } from './opacity';
import { OcclusionProbe } from './probe';

export interface LabelOcclusionOptions {
  id?: string;
  /** Label layers to manage; default: point labels of POI and building layers. */
  labelLayers?: string[];
  /** Below this zoom every label is shown. */
  minZoom?: number;
  fadeMs?: number;
  /** Labels probed at once, nearest to the screen centre first. */
  maxLabels?: number;
  onError?: (err: unknown) => void;
}

const PROBE_PX = 4;
type Listener = (e?: { sourceDataType?: string }) => void;

const nextFrame = (fn: (now: number) => void): void => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fn);
  else setTimeout(() => fn(performance.now()), 16);
};

/**
 * Fades out basemap point labels hidden behind 3D content, using WebGL2 occlusion queries
 * against the depth buffer. Add it anywhere: it moves itself after the 3D layers.
 */
export class LabelOcclusion implements CustomLayerInterface {
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const;
  readonly id: string;
  private map?: MlMap;
  private scanner?: CandidateScanner;
  private opacity?: LabelOpacity;
  private probe?: OcclusionProbe;
  private failed = false;
  private candidates: Candidate[] = [];
  private targetsChanged = false;
  private readonly labels = new Map<string, FeatureIdentifier>();
  private readonly written = new Map<string, number>();
  private readonly fades: Tweens<string>;
  private timer?: ReturnType<typeof setTimeout>;
  private lastScan = 0;
  private stale = true;
  private looping = false;
  private placing = false;

  constructor(private readonly options: LabelOcclusionOptions = {}) {
    this.id = options.id ?? 'label-occlusion';
    this.fades = new Tweens(options.fadeMs ?? 180);
  }

  private readonly handlers: [string, Listener][] = [
    ['move', () => this.changed(Math.max(0, 250 - (performance.now() - this.lastScan)))],
    ['moveend', () => this.changed(60)],
    ['idle', () => this.stale && this.schedule(60)],
    [
      'sourcedata',
      (e) => (!e?.sourceDataType || e.sourceDataType === 'content') && this.changed(150),
    ],
    [
      'terrain',
      () => {
        this.scanner?.clearRoofs();
        this.changed(100);
      },
    ],
    ['styledata', () => this.place()],
    ['style.load', () => this.onStyleLoad()],
    ['webglcontextlost', () => this.contextLost()],
    ['webglcontextrestored', () => this.changed(0)],
  ];

  onAdd(map: MlMap, _gl?: WebGL2RenderingContext): void {
    this.map = map;
    this.scanner = new CandidateScanner(map);
    this.opacity = new LabelOpacity(map, (message) => this.report(new Error(message)));
    this.opacity.wrap(this.layerIds());
    onExemptionsChanged(map, this.refresh);
    for (const [type, fn] of this.handlers) map.on(type as 'move', fn as never);
    this.place();
    this.schedule(0);
  }

  onRemove(_map?: MlMap, _gl?: WebGL2RenderingContext): void {
    this.teardown();
  }

  /** Re-scan labels now (e.g. after the app changed its label layers). */
  readonly refresh = (): void => this.changed(0);

  render(gl: WebGL2RenderingContext, args: CustomRenderMethodInput): void {
    const map = this.map;
    if (!map || this.failed) return;
    if (
      args.defaultProjectionData.projectionTransition > 0 ||
      map.getZoom() < (this.options.minZoom ?? 15)
    ) {
      this.showAll();
      return;
    }
    if (typeof gl.createQuery !== 'function' || gl.isContextLost()) return;
    try {
      this.probe ??= new OcclusionProbe(gl);
      if (this.targetsChanged) {
        this.probe.setTargets(this.candidates.filter((c) => !c.exempt));
        this.targetsChanged = false;
      }
      this.probe.draw(
        args.defaultProjectionData.mainMatrix,
        PROBE_PX * (globalThis.devicePixelRatio || 1),
      );
      this.startLoop();
    } catch (err) {
      this.failed = true;
      this.probe = undefined;
      this.report(err);
      this.showAll();
    }
  }

  private layerIds(): string[] {
    const layers = (this.map?.getStyle()?.layers ?? []) as Parameters<typeof labelLayerIds>[0];
    return labelLayerIds(layers, this.options.labelLayers);
  }

  private changed(delayMs: number): void {
    this.stale = true;
    this.schedule(delayMs);
  }

  private schedule(delayMs: number): void {
    if (!this.map || this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.scan();
    }, delayMs);
  }

  private scan(): void {
    const map = this.map;
    if (!map || !this.scanner) return;
    this.stale = false;
    this.lastScan = performance.now();
    const layers = this.layerIds();
    this.opacity?.wrap(layers);
    this.scanner.setExemptions(exemptionsFor(map));
    const next =
      map.getZoom() >= (this.options.minZoom ?? 15)
        ? this.scanner.scan(layers, this.options.maxLabels ?? 256)
        : [];
    const keep = new Set(next.map((c) => c.key));
    for (const [key, feature] of this.labels) if (!keep.has(key)) this.drop(key, feature);
    for (const c of next) {
      if (!this.labels.has(c.key)) {
        this.labels.set(c.key, c.feature);
        this.fades.set(c.key, 1);
      }
      if (c.exempt) this.fades.to(c.key, 1);
    }
    this.candidates = next;
    this.targetsChanged = true;
    this.startLoop();
    map.triggerRepaint();
  }

  /** A label left the screen or the managed set: back to the style default (shown). */
  private drop(key: string, feature: FeatureIdentifier): void {
    if (this.written.has(key)) this.safely(() => this.map!.removeFeatureState(feature, LABEL_STATE));
    this.written.delete(key);
    this.labels.delete(key);
    this.fades.delete(key);
  }

  private showAll(): void {
    let any = false;
    for (const key of this.labels.keys()) {
      if (this.fades.target(key) !== 1) {
        this.fades.to(key, 1);
        any = true;
      }
    }
    if (any) this.startLoop();
  }

  private startLoop(): void {
    if (this.looping || !this.map) return;
    this.looping = true;
    nextFrame(this.tick);
  }

  private readonly tick = (now: number): void => {
    this.looping = false;
    const map = this.map;
    if (!map) return;
    const probe = this.probe;
    if (probe) {
      for (const [key, visible] of probe.poll()) {
        if (this.labels.has(key)) this.fades.to(key, visible ? 1 : 0);
      }
      if (probe.needsDraw) map.triggerRepaint();
    }
    this.fades.step(now);
    this.write();
    if (probe?.pending || this.fades.active()) this.startLoop();
  };

  private write(): void {
    for (const [key, feature] of this.labels) {
      const value = this.fades.value(key);
      if (this.written.get(key) === value) continue;
      this.safely(() => this.map!.setFeatureState(feature, { [LABEL_STATE]: value }));
      this.written.set(key, value);
    }
  }

  /** Keep this layer after the last 3D layer and before the first label layer. */
  private place(): void {
    const map = this.map;
    if (!map || this.placing || !map.getLayer(this.id)) return;
    this.placing = true;
    try {
      const order = map.getLayersOrder();
      const typeOf = (id: string) => (map.getLayer(id) as { type?: string } | undefined)?.type;
      let last3d = -1;
      order.forEach((id, i) => {
        const type = typeOf(id);
        if (id !== this.id && (type === 'custom' || type === 'fill-extrusion')) last3d = i;
      });
      const firstLabel = order.findIndex((id) => typeOf(id) === 'symbol');
      const at = order.indexOf(this.id);
      const afterLast3d = at > last3d;
      const beforeLabels = firstLabel === -1 || firstLabel < last3d || at < firstLabel;
      if (afterLast3d && beforeLabels) return;
      map.moveLayer(this.id, order.slice(last3d + 1).find((id) => id !== this.id));
    } catch (err) {
      this.report(err);
    } finally {
      this.placing = false;
    }
  }

  private onStyleLoad(): void {
    const map = this.map;
    if (!map) return;
    // The new style owns its paint and feature-state; forget ours without touching it.
    this.opacity?.reset();
    this.written.clear();
    if (!map.getLayer(this.id)) {
      this.labels.clear();
      this.teardown();
      return;
    }
    this.place();
    this.changed(0);
  }

  private contextLost(): void {
    this.probe = undefined; // its handles died with the context
    this.targetsChanged = true;
    this.showAll();
  }

  private teardown(): void {
    const map = this.map;
    if (!map) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const [type, fn] of this.handlers) map.off(type as 'move', fn as never);
    onExemptionsChanged(map, null);
    for (const [key, feature] of this.labels) {
      if (this.written.has(key)) this.safely(() => map.removeFeatureState(feature, LABEL_STATE));
    }
    this.opacity?.restore();
    this.safely(() => this.probe?.dispose());
    this.probe = undefined;
    this.labels.clear();
    this.written.clear();
    this.fades.clear();
    this.candidates = [];
    this.map = undefined;
  }

  private report(err: unknown): void {
    if (this.options.onError) this.options.onError(err);
    else console.warn('[maplibre-landmarks] label occlusion', err);
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch {
      // The style or context was torn down.
    }
  }
}
```

- [ ] **Step 4: Export it**

Append to `src/index.ts`:

```ts
export { LabelOcclusion, type LabelOcclusionOptions } from './labels/LabelOcclusion';
export { LABEL_STATE } from './labels/opacity';
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS (all unit tests, including 10 new `LabelOcclusion` tests).

- [ ] **Step 6: Format, leave uncommitted**

Run: `npx prettier --write src tests/unit && npm run lint`
Expected: lint clean.

---

### Task 7: Browser test, demo toggle and docs

**Files:**
- Modify: `demo/e2e.ts` (add `window.__addLabels`), `demo/main.ts` + `demo/index.html` (toggle), `README.md`
- Create: `tests/browser/labels.pw.ts`

**Interfaces:**
- Consumes: `LabelOcclusion`, `LABEL_STATE` (Task 6); the existing e2e page (`window.__start`, `window.__map`, `window.__state`) and `findTarget()` from `tests/browser/target.ts` (returns `{ anchor, footprint, neighbour }`).
- Produces: `window.__addLabels(points: [number, number][]): void` on the e2e page: adds a GeoJSON source `labels` (feature ids 1..n) drawn as icon-only symbols (layer `labels`) and a `LabelOcclusion({ labelLayers: ['labels'] })`.

- [ ] **Step 1: Write the failing browser test**

`tests/browser/labels.pw.ts`:

```ts
import { expect, test, type Page } from '@playwright/test';
import type {} from '../../demo/e2e';
import { findTarget } from './target';

const labelState = (page: Page, id: number) =>
  page.evaluate(
    (i) => window.__map!.getFeatureState({ source: 'labels', id: i })['landmarks:label'],
    id,
  );

test('hides a label behind the landmark and keeps the one in front', async ({ page }) => {
  const target = await findTarget();
  const lats = (target.footprint as { coordinates: number[][][] }).coordinates[0]!.map((p) => p[1]!);
  const [lng] = target.anchor;
  // The camera looks north (bearing 0, pitch 50): north of the landmark is behind it.
  const behind: [number, number] = [lng, Math.max(...lats) + 0.0004];
  const front: [number, number] = [lng, Math.min(...lats) - 0.0004];

  await page.goto('/e2e.html');
  await page.evaluate((t) => window.__start(t as never), target);
  await page.waitForFunction(() => window.__state.models.length > 0, null, { timeout: 45_000 });
  await page.waitForFunction(
    () => window.__map!.getFeatureState({ source: 'b', id: 1 })['landmarks:fade'] === 1,
    null,
    { timeout: 10_000 },
  );
  await page.evaluate((pts) => window.__addLabels(pts as [number, number][]), [behind, front]);

  await page.waitForFunction(
    () => window.__map!.getFeatureState({ source: 'labels', id: 1 })['landmarks:label'] === 0,
    null,
    { timeout: 10_000 },
  );
  expect(await labelState(page, 2)).toBe(1);

  await page.evaluate(() => window.__map!.removeLayer('label-occlusion'));
  expect(await labelState(page, 1)).toBeUndefined();
  expect(await page.evaluate(() => window.__map!.getPaintProperty('labels', 'icon-opacity'))).toBeUndefined();
  expect(await page.evaluate(() => window.__state.errors)).toEqual([]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx playwright test labels`
Expected: FAIL, `window.__addLabels is not a function`.

- [ ] **Step 3: Add `__addLabels` to the e2e page**

In `demo/e2e.ts`:
- Change the import to `import { LabelOcclusion, LandmarksLayer, type LandmarkInfo } from '../src/index';`.
- Add to the `Window` interface: `/** Add icon labels at the given points, plus label occlusion. */ __addLabels(points: [number, number][]): void;`
- Add at the end of the file:

```ts
window.__addLabels = (points) => {
  const map = window.__map!;
  const size = 8;
  map.addImage('dot', { width: size, height: size, data: new Uint8Array(size * size * 4).fill(255) });
  map.addSource('labels', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: points.map((coordinates, i) => ({
        type: 'Feature',
        id: i + 1,
        properties: {},
        geometry: { type: 'Point', coordinates },
      })),
    },
  });
  map.addLayer({
    id: 'labels',
    type: 'symbol',
    source: 'labels',
    layout: { 'icon-image': 'dot', 'icon-allow-overlap': true, 'icon-ignore-placement': true },
  });
  map.addLayer(
    new LabelOcclusion({
      labelLayers: ['labels'],
      onError: (err) => window.__state.errors.push(`labels: ${String(err)}`),
    }),
  );
};
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx playwright test labels`
Expected: PASS. If label 1 never reaches 0, check with a screenshot that the "behind" point is on screen and behind the model from the camera before changing any code; a too-short landmark (< ~40 m) would need the point moved further north, not a weaker assertion.

- [ ] **Step 5: Demo toggle**

In `demo/index.html`, after the Terrain checkbox line, add:

```html
      <label><input type="checkbox" id="occlusion" /> Hide labels behind 3D</label>
```

In `demo/main.ts`, change the import to `import { LabelOcclusion, LandmarksLayer, type LandmarkInfo, type Theme } from '../src/index';` and append:

```ts
let occlusion: LabelOcclusion | undefined;
$<HTMLInputElement>('occlusion').onchange = (e) => {
  if ((e.target as HTMLInputElement).checked) {
    occlusion = new LabelOcclusion();
    map.addLayer(occlusion);
  } else if (occlusion) {
    map.removeLayer(occlusion.id);
    occlusion = undefined;
  }
};
```

- [ ] **Step 6: Document it**

In `README.md`, after the paragraph that starts "Building replacement uses feature-state", add:

````md
### Label occlusion

Basemap labels draw on top of everything, so shop and building names show through 3D
landmarks. Add `LabelOcclusion` to fade out point labels that are hidden behind 3D content:

```ts
import { LabelOcclusion } from 'maplibre-landmarks';

map.addLayer(new LabelOcclusion());
```

It tests each label against the depth buffer with WebGL2 occlusion queries, so landmark models,
extruded buildings and terrain all hide labels; a landmark never hides its own label. By default
it manages point labels of `pois`/`poi`/`buildings`/`building` source layers.

| Option        | Default           | Description                                          |
| ------------- | ----------------- | ---------------------------------------------------- |
| `id`          | `'label-occlusion'` | Layer id                                           |
| `labelLayers` | auto              | Symbol layer ids to manage                           |
| `minZoom`     | `15`              | Below this zoom every label is shown                 |
| `fadeMs`      | `180`             | Fade duration                                        |
| `maxLabels`   | `256`             | Labels tested at once, nearest to the centre first   |
| `onError`     | `console.warn`    | Shader or GL setup failures                          |

It works without `LandmarksLayer`, moves itself after the 3D layers, needs WebGL2 (otherwise it
does nothing), and `map.removeLayer(id)` restores the label paint.
````

- [ ] **Step 7: Full check, leave uncommitted**

Run: `npx prettier --write demo README.md tests/browser && npx tsc --noEmit && npx vitest run && npm run lint && npm run build && npx playwright test`
Expected: all green (unit, lint, build, 3 browser tests).
