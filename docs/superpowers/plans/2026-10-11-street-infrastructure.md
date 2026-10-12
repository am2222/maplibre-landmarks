# Street Infrastructure Layers: Roadmap and Run 1 (Street Furniture) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Draw OpenStreetMap street infrastructure from Overture's base tiles (`infrastructure` layer) as cheap instanced 3D props, in several runs; run 1 adds street furniture (benches, bins, bollards, hydrants, post boxes, bike racks, …) as a new `StreetFurnitureLayer`.

**Architecture:** Same pattern as the street lamps in `src/power/PowerModule.ts`: a `TileFeed` reads the `infrastructure` source layer tile by tile, points are kept per tile, de-duplicated across tile buffers, the nearest ones within the far cutoff are written into one `InstancedMesh` per prop kind, anchored at the view centre. Prop shapes live in a small catalogue (`src/street/props.ts`) mapping Overture `class` values to unit-metre geometries and colours, so later runs add kinds by adding entries.

**Tech Stack:** TypeScript, three.js (`InstancedMesh`, `BoxGeometry`, `CylinderGeometry`, `mergeGeometries`), MapLibre GL JS custom layers via the repo's `ModuleLayer`, Vitest.

**Spec:** No separate spec. The requirements are this document's "Roadmap" and "Run 1 scope" sections, from the conversation of 2026-10-11 (the Overture `infrastructure` inventory counted around Hôtel de Ville, Paris, zoom 16).

## Global Constraints

- Data: Overture base tiles, source layer `infrastructure`, fields `subtype`, `class`, `source_tags` (JSON string of the OSM tags), `id`. Same source as `PowerLinesLayer`.
- Geometry in local metres, glTF axes (X east, Y up, Z south), anchored with `localPosition(originAt(anchor), lngLat, elevation)` from `src/core/mercator.ts`.
- One draw call per prop kind (`InstancedMesh`), `frustumCulled = false` (instances spread around the anchor), as trees and power supports do.
- Respect `farCutoffM(view)` from `src/core/cutoff.ts` for pitched views; option `farCutoff: false` turns it off.
- Never commit: the user commits. Each task ends with a checkpoint (tests, typecheck, lint, prettier), not a commit.
- Prettier formatting (`npx prettier --write`), ESLint clean (`npx eslint .`), `npx tsc --noEmit` clean.
- Comments: the repo's style. Short doc comments saying why, British spelling ("colour", "metres").

## Roadmap (one run per group)

Counts are from the tiles loaded around Hôtel de Ville, Paris, at zoom 16. They show what is typical, not complete totals.

| Run | Layer | Overture classes | Count | Notes |
|---|---|---|---|---|
| done | `PowerLinesLayer` | `street_lamp` | 3,295 | Glow at dusk and night |
| **1** | `StreetFurnitureLayer` (new) | `bench`, `waste_basket`, `recycling`, `bollard`, `fire_hydrant`, `post_box`, `bicycle_parking`, `drinking_water`, `vending_machine`, `information`, `street_cabinet`, `charging_station` | ~6,300 | Points only; this plan |
| 2 | same layer | `traffic_signals` (lit red/amber/green at night), `bus_stop` (shelter), `give_way` (sign), `bicycle_rental` (dock) | ~710 | Needs road bearing for orientation: nearest Protomaps `roads` segment |
| 3 | `BarriersLayer` (new) | `fence`, `wall`, `retaining_wall`, `hedge`, `city_wall`, `guard_rail` (lines and polygon rings) | ~520 lines | Extruded ribbons along lines, one merged mesh per kind; heights from `source_tags.height` |
| 4 | split by fit | `fountain` (water layer look), `artwork` (plinth), `bell_tower`, `communication_tower`, `storage_tank`, `platform` (raised slabs), `pier` | ~600 | Mostly polygons; reuse roof/extrusion helpers where possible |
| not planned | | `crossing`, `kerb`, `manhole`, `drain`, `stop_position`, `parking_entrance`, `atm`, `gate`, `entrance`, `parking_space`, `substation` | | Flat markings, on walls, or invisible at map scale. Crossings could come back as road paint later |

Open question for after run 1: move `street_lamp` from `PowerLinesLayer` into `StreetFurnitureLayer` (one place for street props) or keep it with power. Run 1 does not touch the lamps.

## Run 1 scope

- New `StreetFurnitureLayer` / `StreetFurnitureModule`, default `minZoom` 16 (props are under 2 m and invisible further out).
- Twelve prop kinds (table above), each a simple low-poly shape with its own colour.
- Orientation: the OSM `direction` tag (degrees or compass letters) when tagged, else a stable per-position turn.
- Options: `source` (required), `sourceLayer` (`'infrastructure'`), `minZoom` (16), `maxPerKind` (1500), `kinds` (subset to draw, default all), `farCutoff` (true), `onError`.
- `getStats()`: `{ total, byKind: Record<string, number> }`.
- Demo: a "Street" tab with a toggle and stats, URL `?street`; the `overture-base` source loads when power or street is on.
- Docs: `docs/guide/street.md`, sidebar entry, README mention.

## Review Focus

- A prop in two tiles' buffers (near a tile edge) must be drawn once, not twice: the test in Task 2 checks de-duplication.
- A `direction` tag that is not a number or compass letter (`"forward"`, `"300-30"`) must not break the build: falls back to the hashed turn (Task 1 test).
- A tile that loads with no props, or a class not in `kinds`, must leave the other kinds' instance counts alone (Task 2 test).
- Below `minZoom` nothing is read or drawn, and the feed is suspended (Task 2 test).
- A missing source is reported once through `onError` (Task 2 test).

## File Structure

- Create `src/street/props.ts`: the prop catalogue (`PROP_KINDS`, `propGeometry(kind)`, `PROP_COLOURS`) and `directionDeg(tags)`. Pure functions, no map access.
- Create `src/street/StreetFurnitureModule.ts`: the `LayerModule` (feed, selection, instancing, stats).
- Create `src/street/StreetFurnitureLayer.ts`: the `ModuleLayer` wrapper, as `src/power/PowerLayer.ts`.
- Modify `src/index.ts`: exports.
- Create `tests/unit/streetProps.test.ts`, `tests/unit/streetFurnitureModule.test.ts`.
- Modify `demo/index.html`, `demo/main.ts`, `demo/style.ts` (source loaded when street is on).
- Create `docs/guide/street.md`; modify `docs/.vitepress/config.ts`, `README.md`.

---

### Task 1: Prop catalogue and direction parsing

**Files:**
- Create: `src/street/props.ts`
- Test: `tests/unit/streetProps.test.ts`

**Interfaces:**
- Produces:
  - `type PropKind = 'bench' | 'waste_basket' | 'recycling' | 'bollard' | 'fire_hydrant' | 'post_box' | 'bicycle_parking' | 'drinking_water' | 'vending_machine' | 'information' | 'street_cabinet' | 'charging_station'`
  - `const PROP_KINDS: readonly PropKind[]`
  - `const PROP_COLOURS: Record<PropKind, number>` (sRGB hex)
  - `function propGeometry(kind: PropKind): BufferGeometry` (metres, standing on y = 0, front facing −Z)
  - `function directionDeg(tags: Record<string, unknown>): number | undefined`
  - `function hashedTurnDeg(lngLat: [number, number]): number` (0–360, stable)

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/streetProps.test.ts
import { describe, expect, it } from 'vitest';
import { Box3 } from 'three';
import {
  directionDeg,
  hashedTurnDeg,
  PROP_COLOURS,
  PROP_KINDS,
  propGeometry,
} from '../../src/street/props';

describe('street props', () => {
  it('builds every kind standing on the ground, in metres, with a colour', () => {
    for (const kind of PROP_KINDS) {
      const g = propGeometry(kind);
      const box = new Box3().setFromBufferAttribute(g.getAttribute('position') as never);
      expect(box.min.y).toBeCloseTo(0, 6);
      expect(box.max.y).toBeGreaterThan(0.3);
      expect(box.max.y).toBeLessThan(2.5);
      expect(Math.max(box.max.x - box.min.x, box.max.z - box.min.z)).toBeLessThan(3);
      expect(g.getAttribute('normal')).toBeDefined();
      expect(PROP_COLOURS[kind]).toBeTypeOf('number');
    }
  });

  it('reads the OSM direction tag in degrees or compass letters', () => {
    expect(directionDeg({ direction: '135' })).toBe(135);
    expect(directionDeg({ direction: '-90' })).toBe(270);
    expect(directionDeg({ direction: 'NE' })).toBe(45);
    expect(directionDeg({ direction: 'wsw' })).toBe(247.5);
    expect(directionDeg({ direction: 'forward' })).toBeUndefined();
    expect(directionDeg({ direction: '300-30' })).toBeUndefined();
    expect(directionDeg({})).toBeUndefined();
  });

  it('turns untagged props by a stable angle from their position', () => {
    const a = hashedTurnDeg([2.35, 48.85]);
    expect(hashedTurnDeg([2.35, 48.85])).toBe(a);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(360);
    expect(hashedTurnDeg([2.3501, 48.85])).not.toBe(a);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/unit/streetProps.test.ts`
Expected: FAIL, "Failed to resolve import ../../src/street/props".

- [ ] **Step 3: Implement the catalogue**

```ts
// src/street/props.ts
import { BoxGeometry, BufferGeometry, CylinderGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Overture `infrastructure` classes drawn as street furniture. */
export const PROP_KINDS = [
  'bench',
  'waste_basket',
  'recycling',
  'bollard',
  'fire_hydrant',
  'post_box',
  'bicycle_parking',
  'drinking_water',
  'vending_machine',
  'information',
  'street_cabinet',
  'charging_station',
] as const;
export type PropKind = (typeof PROP_KINDS)[number];

/** Muted colours that sit with the basemap (sRGB hex). */
export const PROP_COLOURS: Record<PropKind, number> = {
  bench: 0x6b5a46,
  waste_basket: 0x3f5a4a,
  recycling: 0x4b6f8a,
  bollard: 0x4a4d52,
  fire_hydrant: 0xa8433a,
  post_box: 0xc9a227,
  bicycle_parking: 0x7a7f86,
  drinking_water: 0x355e6b,
  vending_machine: 0x8a3f3f,
  information: 0x50606e,
  street_cabinet: 0x8c8f87,
  charging_station: 0x3d7a5a,
};

/** A box `w` × `h` × `d` metres standing on y = `y0`, centred at (x, z). */
const box = (w: number, h: number, d: number, x = 0, y0 = 0, z = 0) =>
  new BoxGeometry(w, h, d).translate(x, y0 + h / 2, z).toNonIndexed();
/** An upright cylinder of radius `r` and height `h` standing on y = `y0`. */
const post = (r: number, h: number, x = 0, y0 = 0, z = 0, sides = 8) =>
  new CylinderGeometry(r, r, h, sides).translate(x, y0 + h / 2, z).toNonIndexed();

function parts(kind: PropKind): BufferGeometry[] {
  switch (kind) {
    case 'bench':
      return [
        box(1.8, 0.06, 0.45, 0, 0.42, 0), // seat
        box(1.8, 0.4, 0.05, 0, 0.5, 0.22), // backrest, at the back (+Z)
        box(0.06, 0.42, 0.4, -0.8),
        box(0.06, 0.42, 0.4, 0.8),
      ];
    case 'waste_basket':
      return [post(0.04, 0.5), post(0.22, 0.55, 0, 0.35)];
    case 'recycling':
      return [box(1.6, 1.3, 1.1)];
    case 'bollard':
      return [post(0.09, 0.9)];
    case 'fire_hydrant':
      return [post(0.13, 0.6), post(0.09, 0.12, 0, 0.6), post(0.05, 0.12, 0.13, 0.35, 0, 6)];
    case 'post_box':
      return [box(0.45, 1.25, 0.35)];
    case 'bicycle_parking':
      // Three hoops: two legs and a top bar each, 0.8 m apart along x.
      return [-0.8, 0, 0.8].flatMap((x) => [
        box(0.05, 0.8, 0.05, x, 0, -0.3),
        box(0.05, 0.8, 0.05, x, 0, 0.3),
        box(0.05, 0.05, 0.65, x, 0.78, 0),
      ]);
    case 'drinking_water':
      return [post(0.16, 1.0), post(0.04, 0.15, 0, 1.0, -0.1, 6)];
    case 'vending_machine':
      return [box(0.9, 1.8, 0.8)];
    case 'information':
      return [box(0.08, 1.3, 0.08, -0.45), box(0.08, 1.3, 0.08, 0.45), box(1.1, 0.75, 0.05, 0, 0.9)];
    case 'street_cabinet':
      return [box(0.8, 1.2, 0.4)];
    case 'charging_station':
      return [box(0.45, 1.6, 0.3)];
  }
}

/** A prop of `kind` in metres, standing on y = 0, its front facing −Z (north before turning). */
export function propGeometry(kind: PropKind): BufferGeometry {
  const pieces = parts(kind).map((g) => {
    g.deleteAttribute('uv');
    return g;
  });
  const merged = mergeGeometries(pieces);
  if (!merged) throw new Error(`street prop geometry: ${kind}`);
  merged.computeVertexNormals();
  return merged;
}

const COMPASS = [
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
];

/** The OSM `direction` tag as degrees clockwise from north, when it is a number or compass point. */
export function directionDeg(tags: Record<string, unknown>): number | undefined {
  const raw = String(tags.direction ?? '').trim();
  if (!raw) return undefined;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return ((Number(raw) % 360) + 360) % 360;
  const i = COMPASS.indexOf(raw.toUpperCase());
  return i >= 0 ? i * 22.5 : undefined;
}

/** A stable turn for an untagged prop, from its position (degrees, 0–360). */
export function hashedTurnDeg([lng, lat]: [number, number]): number {
  const h = Math.abs(Math.sin(lng * 12_989.8 + lat * 78_233.1)) * 43_758.5;
  return (h % 1) * 360;
}
```

Note: Prettier will reflow the `COMPASS` array; that is fine.

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run tests/unit/streetProps.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Checkpoint**

Run: `npx prettier --write src/street tests/unit/streetProps.test.ts && npx eslint src/street tests/unit/streetProps.test.ts && npx tsc --noEmit`
Expected: no errors. Do not commit.

---

### Task 2: StreetFurnitureModule

**Files:**
- Create: `src/street/StreetFurnitureModule.ts`
- Test: `tests/unit/streetFurnitureModule.test.ts`

**Interfaces:**
- Consumes: `PROP_KINDS`, `PropKind`, `PROP_COLOURS`, `propGeometry`, `directionDeg`, `hashedTurnDeg` from `src/street/props.ts` (Task 1); `TileFeed`, `FeedFeature`, `FeedMap` from `src/core/tileFeed.ts`; `farCutoffM`, `tileNearestM` from `src/core/cutoff.ts`; `localPosition`, `originAt` from `src/core/mercator.ts`.
- Produces:
  - `interface StreetFurnitureOptions { source: string; sourceLayer?: string; minZoom?: number; maxPerKind?: number; kinds?: PropKind[]; farCutoff?: boolean; onError?: (err: unknown) => void }`
  - `interface StreetFurnitureStats { total: number; byKind: Partial<Record<PropKind, number>> }`
  - `class StreetFurnitureModule implements LayerModule` with `getStats(): StreetFurnitureStats`; its scene group is named `'street-furniture'` and each mesh is named after its kind.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/streetFurnitureModule.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Matrix4, Scene, Vector3, type InstancedMesh } from 'three';
import type { ModuleContext } from '../../src/core/LayerModule';
import {
  StreetFurnitureModule,
  type StreetFurnitureOptions,
} from '../../src/street/StreetFurnitureModule';
import { view } from './helpers';

const C: [number, number] = [2.3522, 48.8566];
const M = 111_320;
const KX = M * Math.cos((C[1] * Math.PI) / 180);
const at = (east: number, north = 0): [number, number] => [C[0] + east / KX, C[1] + north / M];
const prop = (cls: string, east: number, north = 0, tags: object = {}) => ({
  properties: { subtype: 'pedestrian', class: cls, source_tags: JSON.stringify(tags) },
  geometry: { type: 'Point', coordinates: at(east, north) },
});

function setup(over: Partial<StreetFurnitureOptions> = {}, features: unknown[] = []) {
  const handlers = new Map<string, (e?: unknown) => void>();
  const map = {
    features,
    getSource: (id: string) => (id === 'base' ? { type: 'vector' } : undefined),
    getTerrain: () => null,
    queryTerrainElevation: () => 0,
    getZoom: () => 17,
    getCenter: () => ({ lng: C[0], lat: C[1] }),
    querySourceFeatures: vi.fn(() => map.features),
    on: vi.fn((t: string, fn: (e?: unknown) => void) => handlers.set(t, fn)),
    off: vi.fn((t: string) => handlers.delete(t)),
  };
  const scene = new Scene();
  const onError = vi.fn();
  const module = new StreetFurnitureModule({ source: 'base', onError, ...over });
  module.onAdd({
    map,
    scene,
    core: { theme: 'day' },
    requestRepaint: vi.fn(),
  } as unknown as ModuleContext);
  return { map, scene, module, onError, handlers };
}

const mesh = (scene: Scene, name: string) =>
  scene.getObjectByName('street-furniture')!.getObjectByName(name) as InstancedMesh;

afterEach(() => vi.useRealTimers());

describe('StreetFurnitureModule', () => {
  it('instances each prop kind in its own mesh', () => {
    const { scene, module } = setup({}, [
      prop('bench', 0),
      prop('bench', 10),
      prop('bollard', 5),
      prop('atm', 3), // not a furniture kind
    ]);
    module.update(view({ center: C, zoom: 17 }));
    expect(module.getStats()).toEqual({ total: 3, byKind: { bench: 2, bollard: 1 } });
    expect(mesh(scene, 'bench').count).toBe(2);
    expect(mesh(scene, 'bollard').count).toBe(1);
    expect(mesh(scene, 'fire_hydrant').count).toBe(0);
  });

  it('draws a prop seen in two tiles once', () => {
    const { module } = setup({}, [prop('bench', 0), prop('bench', 0)]);
    module.update(view({ center: C, zoom: 17 }));
    expect(module.getStats().total).toBe(1);
  });

  it('turns a prop to its OSM direction tag', () => {
    const { scene, module } = setup({}, [prop('bench', 0, 0, { direction: 'E' })]);
    module.update(view({ center: C, zoom: 17 }));
    const m = new Matrix4();
    mesh(scene, 'bench').getMatrixAt(0, m);
    // Front is −Z (north) before turning; facing east, it points +X.
    const front = new Vector3(0, 0, -1).transformDirection(m);
    expect(front.x).toBeCloseTo(1, 6);
    expect(front.z).toBeCloseTo(0, 6);
  });

  it('draws only the kinds asked for, nearest first up to maxPerKind', () => {
    const { module } = setup({ kinds: ['bench'], maxPerKind: 2 }, [
      prop('bench', 30),
      prop('bench', 10),
      prop('bench', 20),
      prop('bollard', 1),
    ]);
    module.update(view({ center: C, zoom: 17 }));
    expect(module.getStats()).toEqual({ total: 2, byKind: { bench: 2 } });
  });

  it('reads nothing below minZoom', () => {
    const { map, module } = setup({}, [prop('bench', 0)]);
    module.update(view({ center: C, zoom: 15 }));
    expect(map.querySourceFeatures).not.toHaveBeenCalled();
    expect(module.getStats().total).toBe(0);
  });

  it('pitched: draws no prop past the far cutoff', () => {
    const { module } = setup({}, [prop('bench', 0), prop('bench', 2000)]);
    module.update(view({ center: C, zoom: 17, pitch: 70, heightPx: 900 }));
    expect(module.getStats().total).toBe(1);
  });

  it('reports a missing source once and cleans up on removal', () => {
    const { scene, module, onError } = setup({ source: 'nope' });
    module.update(view({ center: C, zoom: 17 }));
    module.update(view({ center: C, zoom: 17 }));
    expect(onError).toHaveBeenCalledTimes(1);
    module.onRemove();
    expect(scene.getObjectByName('street-furniture')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/unit/streetFurnitureModule.test.ts`
Expected: FAIL, "Failed to resolve import ../../src/street/StreetFurnitureModule".

- [ ] **Step 3: Implement the module**

```ts
// src/street/StreetFurnitureModule.ts
import { Group, InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import { farCutoffM, tileNearestM } from '../core/cutoff';
import type { LayerModule, ModuleContext } from '../core/LayerModule';
import { localPosition, originAt } from '../core/mercator';
import { TileFeed, type FeedFeature, type FeedMap } from '../core/tileFeed';
import type { LngLat, Origin, ViewState } from '../core/types';
import {
  directionDeg,
  hashedTurnDeg,
  PROP_COLOURS,
  PROP_KINDS,
  propGeometry,
  type PropKind,
} from './props';

export interface StreetFurnitureOptions {
  /** Vector source with Overture's `base` schema (`infrastructure` layer). */
  source: string;
  /** Source layer holding the props (default 'infrastructure'). */
  sourceLayer?: string;
  /** Props appear from this zoom (default 16: they are under 2 m tall). */
  minZoom?: number;
  /** Nearest props drawn per kind at most (default 1500). */
  maxPerKind?: number;
  /** Kinds to draw (default all). */
  kinds?: PropKind[];
  /** Pitched views draw props only to about three screen heights away (default true). */
  farCutoff?: boolean;
  onError?: (err: unknown) => void;
}

export interface StreetFurnitureStats {
  total: number;
  byKind: Partial<Record<PropKind, number>>;
}

interface Prop {
  kind: PropKind;
  lngLat: LngLat;
  /** Degrees clockwise from north the prop's front faces. */
  facing: number;
}

const REBUILD_DEBOUNCE_MS = 150;

const tagsOf = (f: FeedFeature): Record<string, unknown> => {
  try {
    return JSON.parse(String(f.properties?.source_tags ?? '{}')) as Record<string, unknown>;
  } catch {
    return {};
  }
};

/** Benches, bins, bollards, hydrants and other street furniture, instanced per kind. */
export class StreetFurnitureModule implements LayerModule {
  private ctx?: ModuleContext;
  private readonly group = new Group();
  private readonly meshes = new Map<PropKind, InstancedMesh>();
  private feed?: TileFeed;
  private readonly tiles = new Map<string, Prop[]>();
  private anchor: LngLat = [0, 0];
  private view?: ViewState;
  private timer?: ReturnType<typeof setTimeout>;
  private stats: StreetFurnitureStats = { total: 0, byKind: {} };
  private reported = false;
  private readonly kinds: PropKind[];

  constructor(private readonly options: StreetFurnitureOptions) {
    this.group.name = 'street-furniture';
    this.kinds = options.kinds ?? [...PROP_KINDS];
  }

  onAdd(ctx: ModuleContext): void {
    this.ctx = ctx;
    for (const kind of this.kinds) {
      const material = new MeshStandardMaterial({ color: PROP_COLOURS[kind], roughness: 0.8 });
      const mesh = new InstancedMesh(propGeometry(kind), material, this.maxPerKind);
      mesh.name = kind;
      mesh.count = 0;
      mesh.frustumCulled = false;
      this.meshes.set(kind, mesh);
      this.group.add(mesh);
    }
    ctx.scene.add(this.group);
  }

  update(view: ViewState): void {
    this.view = view;
    this.rebuild();
  }

  place(origin: Origin): void {
    this.group.position.set(...localPosition(origin, this.anchor, 0));
    this.group.updateMatrixWorld(true);
  }

  getStats(): StreetFurnitureStats {
    return { total: this.stats.total, byKind: { ...this.stats.byKind } };
  }

  styleChanged(attached: boolean): void {
    this.feed?.reset();
    if (attached) this.rebuild();
  }

  onRemove(): void {
    clearTimeout(this.timer);
    this.feed?.dispose();
    this.feed = undefined;
    this.ctx?.scene.remove(this.group);
    for (const mesh of this.meshes.values()) {
      mesh.geometry.dispose();
      (mesh.material as MeshStandardMaterial).dispose();
      mesh.dispose();
    }
    this.meshes.clear();
    this.ctx = undefined;
  }

  private get maxPerKind(): number {
    return this.options.maxPerKind ?? 1500;
  }

  private readonly schedule = (): void => {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.rebuild(), REBUILD_DEBOUNCE_MS);
  };

  private rebuild(): void {
    const ctx = this.ctx;
    const view = this.view;
    if (!ctx || !view) return;
    const hasSource = !!ctx.map.getSource(this.options.source);
    if (!hasSource && !this.reported) {
      this.reported = true;
      const err = new Error(`source "${this.options.source}" not found`);
      if (this.options.onError) this.options.onError(err);
      else console.warn('[maplibre-landmarks] street furniture', err);
    }
    if (!hasSource || view.zoom < (this.options.minZoom ?? 16)) {
      this.feed?.suspend();
      this.draw(view, []);
      return;
    }
    this.feedFor(ctx).settle();
    const cutoff = this.options.farCutoff === false ? Infinity : farCutoffM(view);
    const k = 111_320 * Math.cos((view.center[1] * Math.PI) / 180);
    const distance = ([lng, lat]: LngLat) =>
      Math.hypot((lng - view.center[0]) * k, (lat - view.center[1]) * 111_320);
    // A prop near a tile edge is in both tiles' buffers: once each.
    const unique = new Map<string, Prop>();
    for (const props of this.tiles.values())
      for (const p of props)
        unique.set(`${p.kind}|${p.lngLat[0].toFixed(7)},${p.lngLat[1].toFixed(7)}`, p);
    const chosen: Prop[] = [];
    for (const kind of this.kinds)
      chosen.push(
        ...[...unique.values()]
          .filter((p) => p.kind === kind)
          .map((p) => ({ p, d: distance(p.lngLat) }))
          .filter(({ d }) => d <= cutoff)
          .sort((a, b) => a.d - b.d)
          .slice(0, this.maxPerKind)
          .map(({ p }) => p),
      );
    this.draw(view, chosen);
  }

  private feedFor(ctx: ModuleContext): TileFeed {
    this.feed ??= new TileFeed(ctx.map as unknown as FeedMap, {
      source: this.options.source,
      sourceLayer: this.options.sourceLayer ?? 'infrastructure',
      filter: ['in', ['get', 'class'], ['literal', this.kinds]],
      wants: (key) =>
        key === '*' ||
        !this.view ||
        this.options.farCutoff === false ||
        tileNearestM(key, this.view.center) <= farCutoffM(this.view),
      onTile: (key, features) => {
        this.tiles.set(key, this.read(features));
        this.schedule();
      },
      onDrop: (key) => {
        this.tiles.delete(key);
        this.schedule();
      },
    });
    return this.feed;
  }

  private read(features: FeedFeature[]): Prop[] {
    const props: Prop[] = [];
    for (const f of features) {
      const kind = String(f.properties?.class) as PropKind;
      if (!this.kinds.includes(kind) || f.geometry.type !== 'Point') continue;
      const lngLat = f.geometry.coordinates as LngLat;
      props.push({ kind, lngLat, facing: directionDeg(tagsOf(f)) ?? hashedTurnDeg(lngLat) });
    }
    return props;
  }

  /** Write the chosen props into their meshes, around the view centre. */
  private draw(view: ViewState, chosen: Prop[]): void {
    const ctx = this.ctx!;
    this.anchor = view.center;
    const origin = originAt(this.anchor);
    const ground = (p: LngLat) =>
      ctx.map.getTerrain() ? (ctx.map.queryTerrainElevation(p) ?? 0) : 0;
    const counts = new Map<PropKind, number>();
    const m = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    const one = new Vector3(1, 1, 1);
    for (const p of chosen) {
      const mesh = this.meshes.get(p.kind);
      if (!mesh) continue;
      const i = counts.get(p.kind) ?? 0;
      const base = new Vector3(...localPosition(origin, p.lngLat, ground(p.lngLat)));
      // Front is −Z (north); turning clockwise seen from above is negative about +Y.
      q.setFromAxisAngle(up, (-p.facing * Math.PI) / 180);
      mesh.setMatrixAt(i, m.compose(base, q, one));
      counts.set(p.kind, i + 1);
    }
    const byKind: Partial<Record<PropKind, number>> = {};
    for (const [kind, mesh] of this.meshes) {
      mesh.count = counts.get(kind) ?? 0;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.count) byKind[kind] = mesh.count;
    }
    this.stats = { total: chosen.length, byKind };
    ctx.requestRepaint();
  }
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run tests/unit/streetFurnitureModule.test.ts`
Expected: PASS (7 tests). If "turns a prop to its OSM direction tag" fails with x ≈ −1, the turn sign is reversed: use `+p.facing` in `setFromAxisAngle` and re-run.

- [ ] **Step 5: Checkpoint**

Run: `npx prettier --write src/street tests/unit/streetFurnitureModule.test.ts && npx eslint src/street tests/unit && npx tsc --noEmit && npx vitest run`
Expected: all tests pass. Do not commit.

---

### Task 3: Layer, exports, demo and docs

**Files:**
- Create: `src/street/StreetFurnitureLayer.ts`
- Modify: `src/index.ts` (after the `PowerModule` export line)
- Modify: `demo/index.html` (tab button next to `<button data-tab="power">`, a `<section class="controls" data-controls="street">` after the power section)
- Modify: `demo/main.ts` (`addStreet`, `LAYERS`, stats, `?street`, source condition)
- Modify: `demo/style.ts` only if the `overture-base` source condition lives there (it is set from `powerUrl` in `demo/main.ts`'s `style()`)
- Create: `docs/guide/street.md`; modify `docs/.vitepress/config.ts`, `README.md`
- Test: `tests/unit/streetFurnitureModule.test.ts` (one export test)

**Interfaces:**
- Consumes: `StreetFurnitureModule`, `StreetFurnitureOptions`, `StreetFurnitureStats` (Task 2); `PropKind`, `PROP_KINDS` (Task 1).
- Produces: `class StreetFurnitureLayer extends ModuleLayer` with `getStats(): StreetFurnitureStats`; package exports `StreetFurnitureLayer`, `StreetFurnitureModule`, `PROP_KINDS`, and the types `StreetFurnitureLayerOptions`, `StreetFurnitureOptions`, `StreetFurnitureStats`, `PropKind`.

- [ ] **Step 1: Write the failing export test** (append to `tests/unit/streetFurnitureModule.test.ts`)

```ts
import * as pkg from '../../src/index';

describe('package exports', () => {
  it('exports the street furniture layer', () => {
    expect(pkg.StreetFurnitureLayer).toBeTypeOf('function');
    expect(pkg.PROP_KINDS).toContain('bench');
  });
});
```

Run: `npx vitest run tests/unit/streetFurnitureModule.test.ts`
Expected: FAIL, `pkg.StreetFurnitureLayer` is undefined.

- [ ] **Step 2: Add the layer and exports**

```ts
// src/street/StreetFurnitureLayer.ts
import { ModuleLayer, type ModuleLayerOptions } from '../core/ModuleLayer';
import {
  StreetFurnitureModule,
  type StreetFurnitureOptions,
  type StreetFurnitureStats,
} from './StreetFurnitureModule';

export interface StreetFurnitureLayerOptions extends StreetFurnitureOptions, ModuleLayerOptions {
  id: string;
}

/** MapLibre custom layer drawing street furniture: benches, bins, bollards, hydrants and more. */
export class StreetFurnitureLayer extends ModuleLayer {
  private readonly street: StreetFurnitureModule;

  constructor(options: StreetFurnitureLayerOptions) {
    const street = new StreetFurnitureModule(options);
    super(options.id, street, options);
    this.street = street;
  }

  getStats(): StreetFurnitureStats {
    return this.street.getStats();
  }
}
```

In `src/index.ts`, after `export { PowerModule, type PowerOptions, type PowerStats } from './power/PowerModule';`:

```ts
export {
  StreetFurnitureLayer,
  type StreetFurnitureLayerOptions,
} from './street/StreetFurnitureLayer';
export {
  StreetFurnitureModule,
  type StreetFurnitureOptions,
  type StreetFurnitureStats,
} from './street/StreetFurnitureModule';
export { PROP_KINDS, type PropKind } from './street/props';
```

Run: `npx vitest run tests/unit/streetFurnitureModule.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 3: Demo**

In `demo/index.html`, after `<button data-tab="power">Power</button>` add `<button data-tab="street">Street</button>`, and after the power `</section>` add:

```html
<section class="controls" data-controls="street">
  <label class="check"
    ><input type="checkbox" data-toggle="street" /> Show street furniture</label
  >
  <p class="stats" id="street-stats"></p>
</section>
```

(Match the exact markup of the power section in the file. Copy it, then change the ids and text.)

In `demo/main.ts`:
- Import `StreetFurnitureLayer` from `'../src/index'`.
- Add `let street: StreetFurnitureLayer | undefined;` next to `let power`.
- Change the `powerUrl` line in `style()` to load the source for either layer:
  `powerUrl: toggle('power').checked || toggle('street').checked ? OVERTURE_BASE : undefined,`
- Add, next to `addPower`:

```ts
function addStreet() {
  remove('street');
  // Without its source yet: restyle, and the style reload adds this layer (restoreLayers).
  if (!map.getSource('overture-base')) return restyle();
  street = new StreetFurnitureLayer({
    id: 'street',
    source: 'overture-base',
    onError: (err) => console.warn('[street]', err),
  });
  map.addLayer(street, before3D());
}
```

- Add `street: { add: addStreet, id: () => 'street' },` to `LAYERS` after the `power` entry.
- Next to the `?power` block before `new MlMap`, add:

```ts
if (params.has('street')) {
  toggle('street').checked = true;
  syncTabDots();
}
```

  Also add `` `?street` (street furniture) `` to the URL parameter comment.
- In the stats `setInterval`, after the power stats:

```ts
const st = street?.getStats();
$('street-stats').textContent =
  st && toggle('street').checked ? `${st.total} props (zoom 16+)` : '';
```

- Add `get street() { return street; },` next to `get power()` in the debug object at the end of the file.

Check: `npx eslint demo && npx tsc --noEmit`.
Manual check: `npm run dev`, then open `http://localhost:5179/?street&power#18/48.8566/2.3522/30/60`. Expect benches, bins and bollards around Hôtel de Ville, and a stats line with a few hundred props.

- [ ] **Step 4: Docs**

Create `docs/guide/street.md`:

````md
# Street furniture

`StreetFurnitureLayer` stands OpenStreetMap street furniture along the streets: benches, bins,
recycling containers, bollards, fire hydrants, post boxes, bike racks, drinking fountains,
vending machines, information boards, street cabinets and charging stations. Data comes from
the `infrastructure` layer of [Overture's base theme](https://docs.overturemaps.org/guides/base/),
the same source as the [power lines and street lamps](./power).

```ts
import { StreetFurnitureLayer } from 'maplibre-landmarks';

map.addLayer(new StreetFurnitureLayer({ id: 'street', source: 'overture-base' }));
```

Each kind is one instanced mesh, a simple low-poly shape in a muted colour. A prop faces its
OSM `direction` tag (degrees or compass points) when it has one; otherwise each turns its own
stable way.

| Option        | Default            | Notes                                                       |
| ------------- | ------------------ | ----------------------------------------------------------- |
| `source`      | required           | Vector source with Overture's base schema                   |
| `sourceLayer` | `'infrastructure'` |                                                             |
| `minZoom`     | `16`               | The props are under 2 m tall                                |
| `maxPerKind`  | `1500`             | Nearest drawn per kind                                      |
| `kinds`       | all                | Subset of `PROP_KINDS`, e.g. `['bench', 'bollard']`         |
| `farCutoff`   | `true`             | Pitched views draw props only to about three screen heights |
| `onError`     | —                  |                                                             |

Methods: `getStats()` (`total`, `byKind`).
````

In `docs/.vitepress/config.ts`, after `{ text: 'Power lines & lamps', link: '/guide/power' },` add `{ text: 'Street furniture', link: '/guide/street' },`.

In `README.md`, change "power lines and street lamps" to "power lines, street lamps and street furniture" in both places it appears.

- [ ] **Step 5: Checkpoint**

Run: `npx prettier --write . && npx prettier --check . && npx eslint . && npx tsc --noEmit && npx vitest run`
Expected: everything passes. Then run `npm run docs:build` and expect a successful build that includes `guide/street.html`. Do not commit; report the changed files for the user to review.

---

## Self-review notes

- Coverage: every item in "Run 1 scope" has a task. The catalogue, orientation and colours are in Task 1; the feed, selection, cutoff, minZoom, stats and errors in Task 2; the layer, exports, demo, docs and README in Task 3.
- Names used across tasks: `PropKind`, `PROP_KINDS`, `PROP_COLOURS`, `propGeometry`, `directionDeg`, `hashedTurnDeg`, `StreetFurnitureModule`, `StreetFurnitureOptions`, `StreetFurnitureStats`, `StreetFurnitureLayer`, `StreetFurnitureLayerOptions`, and the group name `'street-furniture'`.
- Review Focus tests: de-duplication, kind filtering, minZoom and missing source are in Task 2; the bad `direction` tag is in Task 1.
