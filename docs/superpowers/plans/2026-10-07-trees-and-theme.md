# Trees + Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shared `day | dawn | dusk | night` theme to the plugin and a `TreesLayer` that draws
instanced, wind-animated, theme-coloured 3D trees from Protomaps tree points and green polygons,
with pluggable tree models.

**Architecture:**
- Theme lives in the shared `ThreeCore`. It holds the light rigs plus a module registry with a
  `themeChanged` hook, and an exported `setTheme(map, theme)` reaches it.
- The trees module follows the landmarks pattern: pure, testable units (`hash`, `scatter`,
  `collect`, `select`, `models/*`, `material`, `batches`) wired by a GL-free `TreesModule` inside
  a `ModuleLayer`.
- Each update collects, scatters, selects the nearest N and writes instance matrices into
  `InstancedMesh`es.
- Wind and theme are shader uniforms only.

**Tech Stack:** TypeScript, three ≥0.170 (`InstancedMesh`, `mergeGeometries` from
`three/addons/utils/BufferGeometryUtils.js`, `onBeforeCompile`), MapLibre GL JS 6, Vitest,
Playwright.

**Spec:** `docs/superpowers/specs/2026-10-07-trees-design.md` (builds on
`docs/superpowers/specs/2026-10-07-maplibre-landmarks-design.md`).

## Global Constraints

- **Never run `git commit`, `git add`, amend, merge or push**, and never `git init`. The user
  commits manually. Each task ends with a **Checkpoint** step: leave the changes in the working
  tree and report the files.
- Node 22, ESM only. **No new runtime or dev dependencies.** Everything needed is already
  installed (three, maplibre-gl, vitest, playwright, @protomaps/basemaps, pmtiles).
- MapLibre 6 has no default export; use named imports.
- Pure modules (`src/trees/hash.ts`, `scatter.ts`, `collect.ts`, `select.ts`, `src/core/theme.ts`)
  import `maplibre-gl` for types only.
- glTF axes are X east, Y up, Z south, in metres. Wind `directionDeg` is where the wind blows
  **from**, clockwise from north.
- Theme names are exactly `day`, `dawn`, `dusk`, `night`.
- Defaults:
  - `maxTrees: 4000`, `minZoom: 16`, `lodDistanceM: 300`
  - `scatter: { forest: 1/60, wood: 1/60, park: 1/400 }`, `scatterSkipRatio: 0.25`
  - `wind: { strength: 1, directionDeg: 250 }`
  - `weights: { deciduous: 0.6, conifer: 0.2, birch: 0.2 }`
  - `sourceLayers: { points: 'pois', polygons: 'landuse' }`; an empty string means no source
    layer (GeoJSON).
- Triangle budgets: at most 400 per tree variant and at most 24 per impostor.
- Commands:
  - unit tests: `npx vitest run`
  - typecheck: `npx tsc --noEmit`
  - lint: `npm run lint`
  - browser tests: `npm run test:browser`

## Review Focus

1. **Tiles finishing after the layer was added.** Trees must appear without a pan. Pinned in
   Task 9: a `sourcedata` event for the source re-runs the update after 200 ms.
2. **Polygon pieces arriving over several updates** (tiles load one by one). Scatter must be
   recomputed when pieces are added, not served from a stale cache. Pinned in Task 9: a partial
   polygon followed by the full polygon increases the scattered count.
3. **Theme set before the layers exist, or after they were removed and re-added.** The theme must
   survive. Pinned in Task 1 (pending theme, theme kept across core re-creation).
4. **A tree model that fails to load** (bad GLB URL). The other models must still draw, and the
   error must be reported once. Pinned in Task 9.
5. **Layer removed while models are still being prepared** (async). There must be no errors, no
   meshes added to a dead scene, and the geometries must be disposed. Pinned in Task 9.

---

## File Structure

```
src/core/theme.ts                 (new; replaces src/core/lighting.ts) Theme, THEMES, createLightRig
src/core/ThreeCore.ts             (modify) theme state, module registry, setTheme(map), pending themes
src/core/LayerModule.ts           (modify) themeChanged hook
src/core/ModuleLayer.ts           (modify) register/unregister module with the core
src/landmarks/LandmarksModule.ts  (modify) lighting → theme
src/landmarks/LandmarksLayer.ts   (modify) setLighting → setTheme
src/trees/hash.ts                 hashString, seededRand (mulberry32), hashValues
src/trees/scatter.ts              polygon maths, jittered global grid scatter, fill rule
src/trees/collect.ts              mapped points, polygon groups, PointIndex, piecesHash
src/trees/select.ts               nearest-N, LOD split, deterministic attributes
src/trees/models/types.ts         TreeModel, TreeParts
src/trees/models/procedural.ts    conifer, deciduous, birch, defaultImpostor, mergeParts
src/trees/models/prepare.ts       prepareVariant, prepareModel
src/trees/models/glb.ts           treeModelFromGLB
src/trees/material.ts             themed + wind material
src/trees/batches.ts              TreeBatches
src/trees/TreesModule.ts          LayerModule
src/trees/TreesLayer.ts           public layer
src/index.ts                      (modify) exports
demo/index.html, demo/main.ts     (modify) theme selector, trees, wind, stats
demo/e2e-trees.html, demo/e2e-trees.ts (new) keyless trees test page
demo/vite.config.ts               (modify) add e2e-trees input
tests/unit/*.test.ts              new + modified
tests/unit/glb-fixture.ts         (new) in-memory GLB builder
tests/browser/trees.pw.ts         (new)
README.md                         (modify)
```

---

### Task 1: Shared theme in the core (rename lighting → theme)

**Files:**
- Create: `src/core/theme.ts`
- Delete: `src/core/lighting.ts`
- Modify: `src/core/ThreeCore.ts`, `src/core/LayerModule.ts`, `src/core/ModuleLayer.ts`,
  `src/landmarks/LandmarksModule.ts`, `src/landmarks/LandmarksLayer.ts`, `src/index.ts`,
  `demo/main.ts`, `demo/index.html`, `README.md`
- Test: `tests/unit/core.test.ts`, `tests/unit/landmarks.test.ts`

**Interfaces:**
- Produces:
  - `type Theme = 'day' | 'dawn' | 'dusk' | 'night'`, `THEME_NAMES: Theme[]`
  - `interface ThemePalette { foliage: number; foliageJitter: number; trunk: number }`
  - `interface ThemeValues { sky; ground; hemi; sun; sunColor; sunDir: [number, number, number]; palette: ThemePalette }`
  - `THEMES: Record<Theme, ThemeValues>`
  - `interface LightRig { group: Group; setTheme(theme: Theme): void }`, `createLightRig(theme)`
  - `ThreeCore` gains `theme` (getter), `setTheme(theme)`, `register(module)`, `unregister(module)`,
    and a constructor `(map, renderer, theme = 'day')`
  - `setTheme(map: object, theme: Theme): void` (exported from `ThreeCore.ts` and `index.ts`)
  - `LayerModule.themeChanged?(theme: Theme): void`
  - Landmarks: option `theme?: Theme`, methods `setTheme(theme)` on `LandmarksModule` and
    `LandmarksLayer`. **Removed:** `lighting`, `setLighting`, `LightingPreset`, `LIGHTING`,
    `core.setLighting`, `core.lighting`.

- [ ] **Step 1: Update the core tests (failing)**

In `tests/unit/core.test.ts`:

- Replace the import `import { createLightRig, LIGHTING } from '../../src/core/lighting';` with:
```ts
import { createLightRig, THEMES } from '../../src/core/theme';
```
- Replace the import
  `import { acquireCore, releaseCore, type RendererLike } from '../../src/core/ThreeCore';` with:
```ts
import { acquireCore, releaseCore, setTheme, type RendererLike } from '../../src/core/ThreeCore';
```
- Replace the whole `describe('lighting', ...)` block with:
```ts
describe('theme', () => {
  it('builds a hemisphere + sun rig and switches themes', () => {
    const rig = createLightRig('day');
    const hemi = rig.group.children.find((c) => c instanceof HemisphereLight) as HemisphereLight;
    const sun = rig.group.children.find((c) => c instanceof DirectionalLight) as DirectionalLight;
    expect(hemi.intensity).toBe(THEMES.day.hemi);
    rig.setTheme('night');
    expect(hemi.intensity).toBe(THEMES.night.hemi);
    expect(sun.intensity).toBe(THEMES.night.sun);
    rig.setTheme('dusk');
    expect(hemi.intensity).toBe(THEMES.dusk.hemi);
  });

  it('defines a palette for every theme', () => {
    for (const t of ['day', 'dawn', 'dusk', 'night'] as const) {
      expect(THEMES[t].palette.foliage).toBeTypeOf('number');
      expect(THEMES[t].palette.trunk).toBeTypeOf('number');
    }
  });

  it('adopts a theme set on the map before the core existed', () => {
    const map = fakeMap();
    setTheme(asMap(map), 'night');
    const core = acquireCore(asMap(map), gl, () => fakeRenderer());
    expect(core.theme).toBe('night');
    releaseCore(asMap(map));
  });

  it('setTheme(map) updates every scene and notifies registered modules', () => {
    const map = fakeMap();
    const core = acquireCore(asMap(map), gl, () => fakeRenderer());
    const scene = core.createScene();
    const mod = { themeChanged: vi.fn() };
    core.register(mod);
    setTheme(asMap(map), 'dusk');
    expect(mod.themeChanged).toHaveBeenCalledWith('dusk');
    const hemi = scene.children[0]!.children.find(
      (c) => c instanceof HemisphereLight,
    ) as HemisphereLight;
    expect(hemi.intensity).toBe(THEMES.dusk.hemi);
    core.unregister(mod);
    setTheme(asMap(map), 'day');
    expect(mod.themeChanged).toHaveBeenCalledTimes(1);
    releaseCore(asMap(map));
  });

  it('keeps the theme when the core is released and re-created', () => {
    const map = fakeMap();
    acquireCore(asMap(map), gl, () => fakeRenderer()).setTheme('dawn');
    releaseCore(asMap(map));
    expect(acquireCore(asMap(map), gl, () => fakeRenderer()).theme).toBe('dawn');
    releaseCore(asMap(map));
  });
});
```
- In `describe('ThreeCore')`, replace the test `'applies lighting to every scene'` with:
```ts
  it('applies the theme to every scene', () => {
    const map = fakeMap();
    const core = acquireCore(asMap(map), gl, () => fakeRenderer());
    const s1 = core.createScene();
    core.setTheme('dawn');
    const s2 = core.createScene();
    const intensity = (s: Scene) =>
      (s.children[0]!.children.find((c) => c instanceof HemisphereLight) as HemisphereLight)
        .intensity;
    expect(intensity(s1)).toBe(THEMES.dawn.hemi);
    expect(intensity(s2)).toBe(THEMES.dawn.hemi);
    releaseCore(asMap(map));
  });
```
- In `describe('ModuleLayer')`, add `themeChanged: vi.fn(),` to the object returned by
  `moduleSpy`, and append this test inside the describe:
```ts
  it('registers its module for theme changes while added', () => {
    const map = fakeMap();
    const mod = moduleSpy();
    const layer = new ModuleLayer('themed', mod, { rendererFactory: () => fakeRenderer() });
    layer.onAdd(map as unknown as MlMap, gl);
    setTheme(asMap(map), 'night');
    expect(mod.themeChanged).toHaveBeenCalledWith('night');
    layer.onRemove(map as unknown as MlMap, gl);
    setTheme(asMap(map), 'day');
    expect(mod.themeChanged).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: Update the landmarks tests (failing)**

In `tests/unit/landmarks.test.ts`:
- Replace `const core = { setLighting: vi.fn() };` with
  `const core = { setTheme: vi.fn(), theme: 'day' };`.
- Replace the test `'applies the lighting preset on add'` with:
```ts
  it('applies the theme option on add', () => {
    const s = setup({ theme: 'night' });
    expect(s.core.setTheme).toHaveBeenCalledWith('night');
  });

  it('leaves the map theme alone without a theme option', () => {
    const s = setup();
    expect(s.core.setTheme).not.toHaveBeenCalled();
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/core.test.ts tests/unit/landmarks.test.ts`
Expected: FAIL with "Failed to resolve import ../../src/core/theme" (and type or option failures
in the landmarks tests).

- [ ] **Step 4: Implement the theme**

`src/core/theme.ts`:
```ts
import { DirectionalLight, Group, HemisphereLight } from 'three';

export type Theme = 'day' | 'dawn' | 'dusk' | 'night';
export const THEME_NAMES: Theme[] = ['day', 'dawn', 'dusk', 'night'];

/** Module colours for a theme (sRGB hex; three converts to linear). */
export interface ThemePalette {
  foliage: number;
  /** 0..1 amount of per-tree lightness/hue variation. */
  foliageJitter: number;
  trunk: number;
}

export interface ThemeValues {
  sky: number;
  ground: number;
  hemi: number;
  sun: number;
  sunColor: number;
  /** Direction towards the sun in local glTF axes (X east, Y up, Z south). */
  sunDir: [number, number, number];
  palette: ThemePalette;
}

export const THEMES: Record<Theme, ThemeValues> = {
  day: {
    sky: 0xdfeaf5,
    ground: 0x8a8070,
    hemi: 1.6,
    sun: 2.2,
    sunColor: 0xfff4e0,
    sunDir: [-0.5, 1, 0.35],
    palette: { foliage: 0x4f7a3a, foliageJitter: 0.35, trunk: 0x5a4532 },
  },
  dawn: {
    sky: 0xf2c9a8,
    ground: 0x5a4a40,
    hemi: 1.1,
    sun: 1.8,
    sunColor: 0xffb47a,
    sunDir: [-1, 0.35, 0.2],
    palette: { foliage: 0x6f7d3c, foliageJitter: 0.3, trunk: 0x6a4a35 },
  },
  dusk: {
    sky: 0x6a5a8a,
    ground: 0x2a2228,
    hemi: 0.8,
    sun: 0.9,
    sunColor: 0xff9a6a,
    sunDir: [1, 0.25, -0.1],
    palette: { foliage: 0x3a5240, foliageJitter: 0.25, trunk: 0x3e3230 },
  },
  night: {
    sky: 0x30406a,
    ground: 0x101018,
    hemi: 0.45,
    sun: 0.25,
    sunColor: 0x9fb4ff,
    sunDir: [0.3, 1, -0.4],
    palette: { foliage: 0x1f3328, foliageJitter: 0.2, trunk: 0x2a2420 },
  },
};

export interface LightRig {
  group: Group;
  setTheme(theme: Theme): void;
}

export function createLightRig(theme: Theme): LightRig {
  const group = new Group();
  const hemi = new HemisphereLight();
  const sun = new DirectionalLight();
  group.add(hemi, sun);
  const setTheme = (t: Theme) => {
    const v = THEMES[t];
    hemi.color.setHex(v.sky);
    hemi.groundColor.setHex(v.ground);
    hemi.intensity = v.hemi;
    sun.color.setHex(v.sunColor);
    sun.intensity = v.sun;
    sun.position
      .set(...v.sunDir)
      .normalize()
      .multiplyScalar(1000);
  };
  setTheme(theme);
  return { group, setTheme };
}
```

Delete `src/core/lighting.ts`: `rm src/core/lighting.ts`.

`src/core/ThreeCore.ts`: replace the whole file with:
```ts
import type { Map as MlMap } from 'maplibre-gl';
import { Camera, Scene, WebGLRenderer } from 'three';
import { createLightRig, type LightRig, type Theme } from './theme';
import { cameraMatrix, originAt } from './mercator';
import type { Origin } from './types';

export interface RendererLike {
  resetState(): void;
  render(scene: Scene, camera: Camera): void;
  dispose(): void;
}

export type CoreMap = Pick<MlMap, 'getCenter' | 'getCanvas'>;
export type RendererFactory = (map: CoreMap, gl: WebGL2RenderingContext) => RendererLike;

/** Anything that wants to hear about theme changes (every LayerModule qualifies). */
export interface ThemeListener {
  themeChanged?(theme: Theme): void;
}

export const createWebGLRenderer: RendererFactory = (map, gl) => {
  const renderer = new WebGLRenderer({
    canvas: map.getCanvas(),
    context: gl as unknown as WebGLRenderingContext,
    antialias: true,
  });
  renderer.autoClear = false;
  return renderer;
};

const cores = new WeakMap<object, ThreeCore>();
/** Themes set on a map while it has no core (before any layer, or between re-adds). */
const pendingThemes = new WeakMap<object, Theme>();

export function acquireCore(
  map: CoreMap,
  gl: WebGL2RenderingContext,
  factory: RendererFactory = createWebGLRenderer,
): ThreeCore {
  let core = cores.get(map);
  if (!core) {
    core = new ThreeCore(map, factory(map, gl), pendingThemes.get(map) ?? 'day');
    pendingThemes.delete(map);
    cores.set(map, core);
  }
  core.refs++;
  return core;
}

export function releaseCore(map: CoreMap): void {
  const core = cores.get(map);
  if (!core) return;
  core.refs--;
  if (core.refs <= 0) {
    pendingThemes.set(map, core.theme);
    core.dispose();
    cores.delete(map);
  }
}

/** Switch every plugin layer on `map` to `theme` (remembered if no layer is added yet). */
export function setTheme(map: object, theme: Theme): void {
  const core = cores.get(map);
  if (core) core.setTheme(theme);
  else pendingThemes.set(map, theme);
}

/** One Three.js renderer per map, shared by every module layer on it. */
export class ThreeCore {
  refs = 0;
  private readonly camera = new Camera();
  private readonly rigs = new Map<Scene, LightRig>();
  private readonly listeners = new Set<ThemeListener>();

  constructor(
    private readonly map: CoreMap,
    readonly renderer: RendererLike,
    private current: Theme = 'day',
  ) {}

  get theme(): Theme {
    return this.current;
  }

  createScene(): Scene {
    const scene = new Scene();
    const rig = createLightRig(this.current);
    scene.add(rig.group);
    this.rigs.set(scene, rig);
    return scene;
  }

  releaseScene(scene: Scene): void {
    this.rigs.delete(scene);
  }

  register(listener: ThemeListener): void {
    this.listeners.add(listener);
  }

  unregister(listener: ThemeListener): void {
    this.listeners.delete(listener);
  }

  setTheme(theme: Theme): void {
    this.current = theme;
    for (const rig of this.rigs.values()) rig.setTheme(theme);
    for (const l of this.listeners) l.themeChanged?.(theme);
  }

  render(scene: Scene, mainMatrix: ArrayLike<number>, place: (origin: Origin) => void): void {
    const center = this.map.getCenter();
    const origin = originAt([center.lng, center.lat]);
    place(origin);
    this.camera.projectionMatrix.copy(cameraMatrix(mainMatrix, origin));
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    this.renderer.resetState();
    this.renderer.render(scene, this.camera);
    this.renderer.resetState();
  }

  dispose(): void {
    this.rigs.clear();
    this.listeners.clear();
    this.renderer.dispose();
  }
}
```

`src/core/LayerModule.ts`:
- Add `import type { Theme } from './theme';` after the existing imports.
- Add this member just before `onRemove(): void;`:
```ts
  /** The map-wide theme changed (`setTheme(map, theme)`); update palettes, then repaint. */
  themeChanged?(theme: Theme): void;
```

`src/core/ModuleLayer.ts`:
- In `onAdd`, immediately after the `this.module.onAdd({...});` call, add:
  `this.core.register(this.module);`
- In `onRemove`, immediately before `this.module.onRemove();`, add:
  `this.core?.unregister(this.module);`

- [ ] **Step 5: Rename lighting to theme in landmarks**

`src/landmarks/LandmarksModule.ts`:
- Replace `import type { LightingPreset } from '../core/lighting';` with
  `import type { Theme } from '../core/theme';`.
- In `LandmarksOptions`, replace `lighting?: LightingPreset;` with `theme?: Theme;`.
- Replace the field `private lighting: LightingPreset;` with `private themeOption?: Theme;`.
- In the constructor, replace `this.lighting = opts.lighting ?? 'day';` with
  `this.themeOption = opts.theme;`.
- In `onAdd`, replace `ctx.core.setLighting(this.lighting);` with
  `if (this.themeOption) ctx.core.setTheme(this.themeOption);`.
- Replace the method `setLighting(preset: LightingPreset): void { ... }` with:
```ts
  setTheme(theme: Theme): void {
    this.themeOption = theme;
    this.ctx?.core.setTheme(theme);
  }
```

`src/landmarks/LandmarksLayer.ts`:
- Replace `import type { LightingPreset } from '../core/lighting';` with
  `import type { Theme } from '../core/theme';`.
- Replace the method `setLighting` with:
```ts
  setTheme(theme: Theme): void {
    this.landmarks.setTheme(theme);
  }
```

`src/index.ts`:
- Replace `export { LIGHTING, type LightingPreset } from './core/lighting';` with:
```ts
export { THEME_NAMES, THEMES, type Theme, type ThemePalette, type ThemeValues } from './core/theme';
```
- Replace the ThreeCore export block with:
```ts
export {
  acquireCore,
  createWebGLRenderer,
  releaseCore,
  setTheme,
  ThreeCore,
  type RendererFactory,
  type RendererLike,
  type ThemeListener,
} from './core/ThreeCore';
```

Keep the demo compiling (Task 10 rewrites it):
- `demo/main.ts`:
  - change the import `type LightingPreset` to `type Theme`;
  - `let lighting: LightingPreset = 'day';` → `let lighting: Theme = 'day';`;
  - in the `LandmarksLayer` options, `lighting,` → `theme: lighting,`;
  - in the lighting `onchange` handler, `as LightingPreset` → `as Theme` and
    `layer?.setLighting(lighting);` → `layer?.setTheme(lighting);`.
- `demo/index.html`: in the lighting `<select>`, add `<option>dusk</option>` between `dawn` and
  `night`.

`README.md`:
- In the options table, replace the `lighting` row with this row (Prettier re-aligns the table):
```
| `theme` | — | `'day'`, `'dawn'`, `'dusk'` or `'night'`; sets the map-wide theme (see `setTheme`) |
```
- Replace `Methods: \`setLighting(preset)\`,` with `Methods: \`setTheme(theme)\`,`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run && npx tsc --noEmit && npx prettier --write . >/dev/null && npm run lint`
Expected: every test passes (89 existing + 6 new = 95), tsc is clean, and lint is clean. Then run
`grep -rn "ighting\|LightingPreset\|LIGHTING" src tests demo README.md`. Expected: no matches.

- [ ] **Step 7: Checkpoint.** Do not commit. Report the changed files.

---

### Task 2: Seeded hashing and polygon scatter

**Files:**
- Create: `src/trees/hash.ts`, `src/trees/scatter.ts`
- Test: `tests/unit/scatter.test.ts`

**Interfaces:**
- Produces:
  - `hashString(s: string): number` (FNV-1a, uint32)
  - `seededRand(seed: number): () => number` (mulberry32, the same algorithm as the CodePen)
  - `hashValues(key: string, n: number): number[]`
  - `type Ring = number[][]`, `type PolygonCoords = Ring[]` (an outer ring followed by holes)
  - `interface ScatterPoint { key: string; lngLat: [number, number] }`
  - `pointInPolygon(p: number[], polygon: PolygonCoords): boolean`
  - `polygonAreaM2(polygon: PolygonCoords): number`
  - `bboxOf(pieces: PolygonCoords[]): [number, number, number, number]`
  - `scatterPolygon(kind: string, pieces: PolygonCoords[], density: number): ScatterPoint[]`
  - `shouldScatter(pieces: PolygonCoords[], density: number, mappedInside: number, skipRatio: number): boolean`
  - `MAX_SCATTER_CELLS = 250_000`

- [ ] **Step 1: Write the failing test**

`tests/unit/scatter.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { hashString, hashValues, seededRand } from '../../src/trees/hash';
import {
  pointInPolygon,
  polygonAreaM2,
  scatterPolygon,
  shouldScatter,
} from '../../src/trees/scatter';

const M = 111_195; // metres per degree of latitude (R = 6371008.8)

function square(lng: number, lat: number, sizeM: number): number[][] {
  const dLat = sizeM / M;
  const dLng = sizeM / (M * Math.cos((lat * Math.PI) / 180));
  return [
    [lng, lat],
    [lng + dLng, lat],
    [lng + dLng, lat + dLat],
    [lng, lat + dLat],
    [lng, lat],
  ];
}

const SQ = square(2.29, 48.85, 200);

describe('hash', () => {
  it('is deterministic and spreads values in [0, 1)', () => {
    expect(hashString('a')).toBe(hashString('a'));
    expect(hashString('a')).not.toBe(hashString('b'));
    const v = hashValues('tree:1', 5);
    expect(v).toHaveLength(5);
    expect(v.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(hashValues('tree:1', 5)).toEqual(v);
    expect(hashValues('tree:2', 5)).not.toEqual(v);
  });

  it('seededRand is mulberry32', () => {
    expect(seededRand(1)()).toBeCloseTo(0.6270739405881613, 12);
  });
});

describe('polygon geometry', () => {
  const hole = square(2.2905, 48.8505, 100);

  it('measures area in square metres', () => {
    expect(Math.abs(polygonAreaM2([SQ]) - 40_000) / 40_000).toBeLessThan(0.01);
    expect(Math.abs(polygonAreaM2([SQ, hole]) - 30_000) / 30_000).toBeLessThan(0.01);
  });

  it('respects holes', () => {
    const inHole = [hole[0]![0]! + 0.0001, hole[0]![1]! + 0.0001];
    const inRing = [SQ[0]![0]! + 0.0001, SQ[0]![1]! + 0.0001];
    expect(pointInPolygon(inHole, [SQ, hole])).toBe(false);
    expect(pointInPolygon(inRing, [SQ, hole])).toBe(true);
  });
});

describe('scatterPolygon', () => {
  it('is deterministic', () => {
    expect(scatterPolygon('park', [[SQ]], 1 / 400)).toEqual(scatterPolygon('park', [[SQ]], 1 / 400));
  });

  it('does not depend on how tiles split the polygon', () => {
    const [w, s] = SQ[0] as [number, number];
    const [e, n] = SQ[2] as [number, number];
    const mid = (w + e) / 2;
    const left = [[w, s], [mid, s], [mid, n], [w, n], [w, s]];
    const right = [[mid, s], [e, s], [e, n], [mid, n], [mid, s]];
    const whole = scatterPolygon('park', [[SQ]], 1 / 100).map((p) => p.key).sort();
    const split = scatterPolygon('park', [[left], [right]], 1 / 100).map((p) => p.key).sort();
    expect(split).toEqual(whole);
  });

  it('matches the requested density', () => {
    const n = scatterPolygon('forest', [[SQ]], 1 / 60).length;
    const expected = 40_000 / 60;
    expect(n / expected).toBeGreaterThan(0.85);
    expect(n / expected).toBeLessThan(1.15);
  });

  it('keeps holes empty', () => {
    const hole = square(2.2905, 48.8505, 100);
    const pts = scatterPolygon('forest', [[SQ, hole]], 1 / 60);
    expect(pts.length).toBeGreaterThan(0);
    expect(pts.some((p) => pointInPolygon(p.lngLat, [hole]))).toBe(false);
  });

  it('jitters differently per kind', () => {
    const a = scatterPolygon('park', [[SQ]], 1 / 400)[0]!.lngLat;
    const b = scatterPolygon('wood', [[SQ]], 1 / 400)[0]!.lngLat;
    expect(a).not.toEqual(b);
  });

  it('refuses absurdly large polygons', () => {
    expect(scatterPolygon('forest', [[square(2, 48, 100_000)]], 1 / 60)).toEqual([]);
  });
});

describe('shouldScatter', () => {
  it('skips at and above the ratio and fills below it', () => {
    // park target = 40000 / 400 = 100 trees → 25% = 25 mapped trees
    expect(shouldScatter([[SQ]], 1 / 400, 24, 0.25)).toBe(true);
    expect(shouldScatter([[SQ]], 1 / 400, 25, 0.25)).toBe(false);
    expect(shouldScatter([[SQ]], 1 / 400, 30, 0.25)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/scatter.test.ts`
Expected: FAIL with "Cannot find module '../../src/trees/hash'".

- [ ] **Step 3: Implement**

`src/trees/hash.ts`:
```ts
/** FNV-1a 32-bit hash of a string. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: small seeded PRNG in [0, 1) (same as the CodePen's seededRand). */
export function seededRand(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `n` deterministic values in [0, 1) for a key. */
export function hashValues(key: string, n: number): number[] {
  const rand = seededRand(hashString(key));
  return Array.from({ length: n }, rand);
}
```

`src/trees/scatter.ts`:
```ts
import { EARTH_RADIUS_M, mercatorUnitsPerMetre, mercatorX, mercatorY } from '../core/mercator';
import { hashString, seededRand } from './hash';

export type Ring = number[][];
/** One polygon: outer ring first, then holes. Coordinates are [lng, lat]. */
export type PolygonCoords = Ring[];

export interface ScatterPoint {
  key: string;
  lngLat: [number, number];
}

export const MAX_SCATTER_CELLS = 250_000;
const METRES_PER_DEG = (2 * Math.PI * EARTH_RADIUS_M) / 360;

function pointInRing([x, y]: number[], ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi! > y! !== yj! > y! && x! < ((xj! - xi!) * (y! - yi!)) / (yj! - yi!) + xi!) {
      inside = !inside;
    }
  }
  return inside;
}

export function pointInPolygon(p: number[], [outer, ...holes]: PolygonCoords): boolean {
  return !!outer && pointInRing(p, outer) && !holes.some((h) => pointInRing(p, h));
}

function ringAreaM2(ring: Ring, lat0: number): number {
  const kx = METRES_PER_DEG * Math.cos((lat0 * Math.PI) / 180);
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j]![0]! * kx * (ring[i]![1]! * METRES_PER_DEG) - ring[i]![0]! * kx * (ring[j]![1]! * METRES_PER_DEG);
  }
  return Math.abs(a / 2);
}

export function polygonAreaM2([outer, ...holes]: PolygonCoords): number {
  if (!outer?.length) return 0;
  const lat0 = outer.reduce((s, p) => s + p[1]!, 0) / outer.length;
  return Math.max(0, ringAreaM2(outer, lat0) - holes.reduce((s, h) => s + ringAreaM2(h, lat0), 0));
}

export function bboxOf(pieces: PolygonCoords[]): [number, number, number, number] {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const poly of pieces) {
    for (const [x, y] of poly[0] ?? []) {
      w = Math.min(w, x!);
      e = Math.max(e, x!);
      s = Math.min(s, y!);
      n = Math.max(n, y!);
    }
  }
  return [w, s, e, n];
}

const lngFromMercX = (x: number) => x * 360 - 180;
const latFromMercY = (y: number) =>
  (360 / Math.PI) * Math.atan(Math.exp(((180 - y * 360) * Math.PI) / 180)) - 90;

/**
 * Seeded points on a global jittered grid (cell = 1/√density metres), kept where they fall inside
 * any piece. Keys are `kind:i:j`, so tile clipping and overlapping tile buffers never change or
 * duplicate the result.
 */
export function scatterPolygon(
  kind: string,
  pieces: PolygonCoords[],
  density: number,
): ScatterPoint[] {
  if (!(density > 0) || !pieces.length) return [];
  const [w, s, e, n] = bboxOf(pieces);
  if (!Number.isFinite(w)) return [];
  // Same grid for every piece of a polygon: scale at the latitude rounded to a whole degree.
  const cell = (1 / Math.sqrt(density)) * mercatorUnitsPerMetre(Math.round((s + n) / 2));
  const x0 = Math.floor(mercatorX(w) / cell);
  const x1 = Math.floor(mercatorX(e) / cell);
  const y0 = Math.floor(mercatorY(n) / cell);
  const y1 = Math.floor(mercatorY(s) / cell);
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_SCATTER_CELLS) return [];
  const salt = hashString(kind);
  const out: ScatterPoint[] = [];
  for (let i = x0; i <= x1; i++) {
    for (let j = y0; j <= y1; j++) {
      const rand = seededRand(Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ salt);
      const p: [number, number] = [
        lngFromMercX((i + 0.1 + 0.8 * rand()) * cell),
        latFromMercY((j + 0.1 + 0.8 * rand()) * cell),
      ];
      if (pieces.some((poly) => pointInPolygon(p, poly))) out.push({ key: `${kind}:${i}:${j}`, lngLat: p });
    }
  }
  return out;
}

/** Fill rule: scatter only when mapped trees inside stay below `skipRatio` of the target count. */
export function shouldScatter(
  pieces: PolygonCoords[],
  density: number,
  mappedInside: number,
  skipRatio: number,
): boolean {
  const target = pieces.reduce((sum, p) => sum + polygonAreaM2(p), 0) * density;
  return mappedInside < skipRatio * target;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/scatter.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Check.** Run `npx tsc --noEmit && npx prettier --write src tests >/dev/null && npm run lint`.
  Expected: clean.

- [ ] **Step 6: Checkpoint.** Do not commit.

---

### Task 3: Collecting tree points and green polygons

**Files:**
- Create: `src/trees/collect.ts`
- Test: `tests/unit/collect.test.ts`

**Interfaces:**
- Consumes: `PolygonCoords`, `pointInPolygon`, `bboxOf` from `scatter.ts`
- Produces:
  - `type CollectTarget = Pick<Map, 'querySourceFeatures'>`
  - `interface MappedTree { key: string; lngLat: [number, number] }`
  - `interface PolygonGroup { id: string; kind: string; pieces: PolygonCoords[] }`
  - `collectMapped(map, source: string, sourceLayer?: string): MappedTree[]`
  - `collectPolygons(map, source: string, sourceLayer: string | undefined, kinds: string[]): PolygonGroup[]`
  - `class PointIndex { constructor(points: MappedTree[]); countInside(pieces: PolygonCoords[]): number }`
  - `piecesHash(pieces: PolygonCoords[]): string`

- [ ] **Step 1: Write the failing test**

`tests/unit/collect.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import {
  collectMapped,
  collectPolygons,
  piecesHash,
  PointIndex,
  type CollectTarget,
} from '../../src/trees/collect';

const pt = (id: number | undefined, lng: number, lat: number, kind = 'tree') => ({
  id,
  properties: { kind },
  geometry: { type: 'Point', coordinates: [lng, lat] },
});
const ring = (x: number, y: number, d = 0.001) => [
  [x, y],
  [x + d, y],
  [x + d, y + d],
  [x, y + d],
  [x, y],
];
const poly = (id: number | undefined, kind: string, coords: number[][][]) => ({
  id,
  properties: { kind },
  geometry: { type: 'Polygon', coordinates: coords },
});

function fake(features: unknown[]) {
  const querySourceFeatures = vi.fn(() => features);
  return { map: { querySourceFeatures } as unknown as CollectTarget, querySourceFeatures };
}

describe('collectMapped', () => {
  it('queries tree points and de-duplicates tiles by id', () => {
    const { map, querySourceFeatures } = fake([
      pt(1, 2.29, 48.85),
      pt(1, 2.29, 48.85),
      pt(2, 2.291, 48.85),
      pt(undefined, 2.292, 48.85),
      poly(9, 'park', [ring(2.29, 48.85)]),
    ]);
    const trees = collectMapped(map, 'protomaps', 'pois');
    expect(trees.map((t) => t.key)).toEqual(['t:1', 't:2', 't:2.292000,48.850000']);
    expect(querySourceFeatures).toHaveBeenCalledWith('protomaps', {
      sourceLayer: 'pois',
      filter: ['==', ['get', 'kind'], 'tree'],
    });
  });

  it('omits the source layer for GeoJSON sources', () => {
    const { map, querySourceFeatures } = fake([]);
    collectMapped(map, 'geo', '');
    expect(querySourceFeatures).toHaveBeenCalledWith('geo', {
      filter: ['==', ['get', 'kind'], 'tree'],
    });
  });
});

describe('collectPolygons', () => {
  it('groups pieces by kind and id, skipping features without ids', () => {
    const { map, querySourceFeatures } = fake([
      poly(5, 'park', [ring(2.29, 48.85)]),
      poly(5, 'park', [ring(2.291, 48.85)]),
      poly(5, 'park', [ring(2.29, 48.85)]), // same piece from an overlapping tile
      poly(undefined, 'park', [ring(2.3, 48.85)]),
      {
        id: 6,
        properties: { kind: 'forest' },
        geometry: { type: 'MultiPolygon', coordinates: [[ring(2.31, 48.85)], [ring(2.32, 48.85)]] },
      },
      pt(7, 2.29, 48.85),
    ]);
    const groups = collectPolygons(map, 'protomaps', 'landuse', ['park', 'forest']);
    expect(groups.map((g) => [g.id, g.kind, g.pieces.length])).toEqual([
      ['park:5', 'park', 2],
      ['forest:6', 'forest', 2],
    ]);
    expect(querySourceFeatures).toHaveBeenCalledWith('protomaps', {
      sourceLayer: 'landuse',
      filter: ['in', ['get', 'kind'], ['literal', ['park', 'forest']]],
    });
  });

  it('does not query when no kinds are scattered', () => {
    const { map, querySourceFeatures } = fake([]);
    expect(collectPolygons(map, 'protomaps', 'landuse', [])).toEqual([]);
    expect(querySourceFeatures).not.toHaveBeenCalled();
  });
});

describe('PointIndex and piecesHash', () => {
  it('counts only points inside the pieces', () => {
    const index = new PointIndex([
      { key: 'a', lngLat: [2.2905, 48.8505] },
      { key: 'b', lngLat: [2.2915, 48.8505] },
      { key: 'c', lngLat: [2.2995, 48.8595] },
    ]);
    expect(index.countInside([[ring(2.29, 48.85)]])).toBe(1);
    expect(index.countInside([[ring(2.29, 48.85)], [ring(2.291, 48.85)]])).toBe(2);
  });

  it('changes when a piece is added', () => {
    const one = [[ring(2.29, 48.85)]];
    expect(piecesHash(one)).toBe(piecesHash([[ring(2.29, 48.85)]]));
    expect(piecesHash([...one, [ring(2.291, 48.85)]])).not.toBe(piecesHash(one));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/collect.test.ts`
Expected: FAIL with "Cannot find module '../../src/trees/collect'".

- [ ] **Step 3: Implement**

`src/trees/collect.ts`:
```ts
import type { Map as MlMap } from 'maplibre-gl';
import { bboxOf, pointInPolygon, type PolygonCoords } from './scatter';

export type CollectTarget = Pick<MlMap, 'querySourceFeatures'>;

export interface MappedTree {
  key: string;
  lngLat: [number, number];
}

export interface PolygonGroup {
  /** `kind:featureId` */
  id: string;
  kind: string;
  pieces: PolygonCoords[];
}

const layerOpt = (sourceLayer?: string) => (sourceLayer ? { sourceLayer } : {});

/** Protomaps `pois` points with kind=tree, de-duplicated across tiles. */
export function collectMapped(
  map: CollectTarget,
  source: string,
  sourceLayer?: string,
): MappedTree[] {
  const features = map.querySourceFeatures(source, {
    ...layerOpt(sourceLayer),
    filter: ['==', ['get', 'kind'], 'tree'],
  });
  const out = new Map<string, MappedTree>();
  for (const f of features) {
    if (f.geometry.type !== 'Point') continue;
    const [lng, lat] = f.geometry.coordinates as [number, number];
    const key =
      f.id !== undefined && f.id !== null ? `t:${f.id}` : `t:${lng.toFixed(6)},${lat.toFixed(6)}`;
    if (!out.has(key)) out.set(key, { key, lngLat: [lng, lat] });
  }
  return [...out.values()];
}

const pieceKey = (p: PolygonCoords) => `${p[0]?.length ?? 0}:${p[0]?.[0]?.join(',')}:${p[0]?.[1]?.join(',')}`;

/** Green polygons of the given kinds, grouped by feature id (tiles split them into pieces). */
export function collectPolygons(
  map: CollectTarget,
  source: string,
  sourceLayer: string | undefined,
  kinds: string[],
): PolygonGroup[] {
  if (!kinds.length) return [];
  const features = map.querySourceFeatures(source, {
    ...layerOpt(sourceLayer),
    filter: ['in', ['get', 'kind'], ['literal', kinds]],
  });
  const groups = new Map<string, PolygonGroup & { seen: Set<string> }>();
  for (const f of features) {
    if (f.id === undefined || f.id === null) continue;
    const g = f.geometry;
    const polys =
      g.type === 'Polygon'
        ? [g.coordinates as PolygonCoords]
        : g.type === 'MultiPolygon'
          ? (g.coordinates as PolygonCoords[])
          : [];
    if (!polys.length) continue;
    const kind = String(f.properties?.kind);
    const id = `${kind}:${f.id}`;
    let group = groups.get(id);
    if (!group) groups.set(id, (group = { id, kind, pieces: [], seen: new Set() }));
    for (const p of polys) {
      const k = pieceKey(p);
      if (group.seen.has(k)) continue;
      group.seen.add(k);
      group.pieces.push(p);
    }
  }
  return [...groups.values()].map(({ id, kind, pieces }) => ({ id, kind, pieces }));
}

/** Changes whenever pieces are added or removed (tiles loading in or out). */
export function piecesHash(pieces: PolygonCoords[]): string {
  return pieces.map(pieceKey).sort().join('|');
}

/** Bucketed point lookup for counting mapped trees inside polygons. */
export class PointIndex {
  private static readonly CELL = 0.001; // degrees (~100 m)
  private readonly buckets = new Map<string, MappedTree[]>();

  constructor(points: MappedTree[]) {
    for (const p of points) {
      const k = this.key(p.lngLat[0], p.lngLat[1]);
      let b = this.buckets.get(k);
      if (!b) this.buckets.set(k, (b = []));
      b.push(p);
    }
  }

  countInside(pieces: PolygonCoords[]): number {
    const [w, s, e, n] = bboxOf(pieces);
    if (!Number.isFinite(w)) return 0;
    const c = PointIndex.CELL;
    let count = 0;
    for (let x = Math.floor(w / c); x <= Math.floor(e / c); x++) {
      for (let y = Math.floor(s / c); y <= Math.floor(n / c); y++) {
        for (const p of this.buckets.get(`${x}:${y}`) ?? []) {
          if (pieces.some((poly) => pointInPolygon(p.lngLat, poly))) count++;
        }
      }
    }
    return count;
  }

  private key(lng: number, lat: number): string {
    return `${Math.floor(lng / PointIndex.CELL)}:${Math.floor(lat / PointIndex.CELL)}`;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/collect.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Check.** Run `npx tsc --noEmit && npx prettier --write src tests >/dev/null && npm run lint`.
  Expected: clean.

- [ ] **Step 6: Checkpoint.** Do not commit.

---

### Task 4: Selecting trees (nearest N, LOD, deterministic look)

**Files:**
- Create: `src/trees/select.ts`
- Test: `tests/unit/select.test.ts`

**Interfaces:**
- Consumes: `hashValues` from `hash.ts`
- Produces:
  - `interface Candidate { key: string; lngLat: [number, number] }`
  - `interface PlacedTree { key; lngLat; distanceM: number; far: boolean; model: number; variant: number; scale: number; rotation: number; tint: number }`
  - `pickModel(weights: number[], u: number): number`
  - `selectTrees(candidates: Candidate[], center: [number, number], opts: { maxTrees: number; lodDistanceM: number; weights: number[]; variants: number[] }): PlacedTree[]`

- [ ] **Step 1: Write the failing test**

`tests/unit/select.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { pickModel, selectTrees, type Candidate } from '../../src/trees/select';

const C: [number, number] = [2.29, 48.85];
const M = 111_195;
const kx = M * Math.cos((C[1] * Math.PI) / 180);
const east = (key: string, m: number): Candidate => ({ key, lngLat: [C[0] + m / kx, C[1]] });
const opts = { maxTrees: 3, lodDistanceM: 100, weights: [1], variants: [4] };

describe('pickModel', () => {
  it('follows cumulative weights and treats zero weights as uniform', () => {
    expect(pickModel([0.6, 0.2, 0.2], 0.1)).toBe(0);
    expect(pickModel([0.6, 0.2, 0.2], 0.7)).toBe(1);
    expect(pickModel([0.6, 0.2, 0.2], 0.95)).toBe(2);
    expect(pickModel([0, 0], 0.7)).toBe(1);
  });
});

describe('selectTrees', () => {
  it('keeps the nearest trees and marks far ones', () => {
    const trees = selectTrees(
      [east('d', 300), east('a', 10), east('c', 150), east('b', 90)],
      C,
      opts,
    );
    expect(trees.map((t) => t.key)).toEqual(['a', 'b', 'c']);
    expect(trees.map((t) => t.far)).toEqual([false, false, true]);
    expect(trees[1]!.distanceM).toBeCloseTo(90, 0);
  });

  it('gives a tree the same look regardless of order or neighbours', () => {
    const one = selectTrees([east('x', 20)], C, { ...opts, weights: [1, 1], variants: [4, 2] })[0]!;
    const two = selectTrees([east('y', 5), east('x', 20)], C, {
      ...opts,
      weights: [1, 1],
      variants: [4, 2],
    }).find((t) => t.key === 'x')!;
    expect({ ...two, distanceM: 0 }).toEqual({ ...one, distanceM: 0 });
  });

  it('keeps attributes in range', () => {
    const trees = selectTrees(
      Array.from({ length: 200 }, (_, i) => east(`k${i}`, i)),
      C,
      { maxTrees: 200, lodDistanceM: 1000, weights: [1, 1], variants: [4, 2] },
    );
    for (const t of trees) {
      expect(t.variant).toBeLessThan(t.model === 0 ? 4 : 2);
      expect(t.scale).toBeGreaterThanOrEqual(0.8);
      expect(t.scale).toBeLessThan(1.2);
      expect(t.rotation).toBeGreaterThanOrEqual(0);
      expect(t.rotation).toBeLessThan(2 * Math.PI);
      expect(t.tint).toBeGreaterThanOrEqual(0);
      expect(t.tint).toBeLessThan(1);
    }
  });

  it('distributes models by weight', () => {
    const trees = selectTrees(
      Array.from({ length: 10_000 }, (_, i) => east(`t:${i}`, 1)),
      C,
      { maxTrees: 10_000, lodDistanceM: 1000, weights: [0.6, 0.2, 0.2], variants: [1, 1, 1] },
    );
    const share = (m: number) => trees.filter((t) => t.model === m).length / trees.length;
    expect(Math.abs(share(0) - 0.6)).toBeLessThan(0.05);
    expect(Math.abs(share(1) - 0.2)).toBeLessThan(0.05);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/select.test.ts`
Expected: FAIL with "Cannot find module '../../src/trees/select'".

- [ ] **Step 3: Implement**

`src/trees/select.ts`:
```ts
import { EARTH_RADIUS_M } from '../core/mercator';
import { hashValues } from './hash';

export interface Candidate {
  key: string;
  lngLat: [number, number];
}

export interface PlacedTree extends Candidate {
  distanceM: number;
  far: boolean;
  model: number;
  variant: number;
  scale: number;
  rotation: number;
  tint: number;
}

const METRES_PER_DEG = (2 * Math.PI * EARTH_RADIUS_M) / 360;

export function pickModel(weights: number[], u: number): number {
  const total = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (!(total > 0)) return Math.min(weights.length - 1, Math.floor(u * weights.length));
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += Math.max(0, weights[i]!) / total;
    if (u < acc) return i;
  }
  return weights.length - 1;
}

/** Nearest `maxTrees` to `center`; far beyond `lodDistanceM`; look derived from the key only. */
export function selectTrees(
  candidates: Candidate[],
  center: [number, number],
  opts: { maxTrees: number; lodDistanceM: number; weights: number[]; variants: number[] },
): PlacedTree[] {
  const kx = METRES_PER_DEG * Math.cos((center[1] * Math.PI) / 180);
  return candidates
    .map((c) => ({
      c,
      d: Math.hypot((c.lngLat[0] - center[0]) * kx, (c.lngLat[1] - center[1]) * METRES_PER_DEG),
    }))
    .sort((a, b) => a.d - b.d || (a.c.key < b.c.key ? -1 : 1))
    .slice(0, opts.maxTrees)
    .map(({ c, d }) => {
      const [hm, hv, hs, hr, ht] = hashValues(c.key, 5) as [number, number, number, number, number];
      const model = pickModel(opts.weights, hm);
      return {
        key: c.key,
        lngLat: c.lngLat,
        distanceM: d,
        far: d > opts.lodDistanceM,
        model,
        variant: Math.floor(hv * (opts.variants[model] ?? 1)),
        scale: 0.8 + 0.4 * hs,
        rotation: 2 * Math.PI * hr,
        tint: ht,
      };
    });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/select.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Check.** Run `npx tsc --noEmit && npx prettier --write src tests >/dev/null && npm run lint`.
  Expected: clean.

- [ ] **Step 6: Checkpoint.** Do not commit.

---

### Task 5: Tree models (contract, procedural port, variant preparation)

**Files:**
- Create: `src/trees/models/types.ts`, `src/trees/models/procedural.ts`, `src/trees/models/prepare.ts`
- Test: `tests/unit/models.test.ts`

**Interfaces:**
- Consumes: `seededRand`, `hashString` from `hash.ts`
- Produces:
  - `interface TreeParts { trunk: BufferGeometry; foliage: BufferGeometry; trunkTone?: number; foliageTone?: number }`
  - `interface TreeModel { id: string; variants?: number; build(seed: number): TreeParts | Promise<TreeParts>; impostor?(): TreeParts | Promise<TreeParts> }`
  - `mergeParts(geoms: BufferGeometry[]): BufferGeometry`: non-indexed, position only;
    empty input gives an empty geometry
  - `conifer`, `deciduous`, `birch`: `TreeModel`
  - `defaultImpostor(height: number, radius: number, conical: boolean): TreeParts`
  - `interface PreparedVariant { geometry: BufferGeometry; height: number; radius: number; triangles: number }`
  - `interface PreparedModel { id: string; variants: PreparedVariant[]; impostor: PreparedVariant }`
  - `prepareVariant(parts: TreeParts, seed: number): PreparedVariant`: attributes
    `position`, `normal`, `aPart`, `aShade`, `aHeight`
  - `prepareModel(model: TreeModel): Promise<PreparedModel>`
  - `disposePrepared(m: PreparedModel): void`

- [ ] **Step 1: Write the failing test**

`tests/unit/models.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { BoxGeometry, type BufferGeometry } from 'three';
import {
  birch,
  conifer,
  deciduous,
  defaultImpostor,
  mergeParts,
} from '../../src/trees/models/procedural';
import { prepareModel, prepareVariant } from '../../src/trees/models/prepare';
import type { TreeModel, TreeParts } from '../../src/trees/models/types';

const positions = (g: BufferGeometry) => Array.from(g.getAttribute('position').array as Float32Array);

describe('procedural models', () => {
  for (const model of [conifer, deciduous, birch]) {
    it(`${model.id} is deterministic per seed and differs across seeds`, () => {
      const a = model.build(42) as TreeParts;
      const b = model.build(42) as TreeParts;
      const c = model.build(43) as TreeParts;
      expect(positions(a.foliage)).toEqual(positions(b.foliage));
      expect(positions(a.foliage)).not.toEqual(positions(c.foliage));
    });

    it(`${model.id} produces valid parts standing on y = 0`, () => {
      const parts = model.build(7) as TreeParts;
      for (const g of [parts.trunk, parts.foliage]) {
        const p = positions(g);
        expect(p.length).toBeGreaterThan(0);
        expect(p.every(Number.isFinite)).toBe(true);
      }
      parts.trunk.computeBoundingBox();
      expect(parts.trunk.boundingBox!.min.y).toBeCloseTo(0, 2);
    });

    it(`${model.id} variants stay within 400 triangles`, () => {
      for (let seed = 0; seed < 20; seed++) {
        expect(prepareVariant(model.build(seed) as TreeParts, seed).triangles).toBeLessThanOrEqual(400);
      }
    });
  }

  it('impostors stay within 24 triangles', () => {
    expect(prepareVariant(defaultImpostor(12, 2, true), 1).triangles).toBeLessThanOrEqual(24);
    expect(prepareVariant(defaultImpostor(8, 3, false), 1).triangles).toBeLessThanOrEqual(24);
  });

  it('mergeParts handles an empty list', () => {
    expect(mergeParts([]).getAttribute('position').count).toBe(0);
  });
});

describe('prepareVariant', () => {
  const parts: TreeParts = {
    trunk: new BoxGeometry(0.2, 2, 0.2).translate(0, 1, 0),
    foliage: new BoxGeometry(2, 2, 2).translate(0, 3, 0),
    trunkTone: 2,
  };

  it('tags trunk then foliage vertices and normalises height', () => {
    const v = prepareVariant(parts, 1);
    const part = v.geometry.getAttribute('aPart').array as Float32Array;
    const h = v.geometry.getAttribute('aHeight').array as Float32Array;
    expect(part[0]).toBe(0);
    expect(part[part.length - 1]).toBe(1);
    expect(v.height).toBeCloseTo(4, 5);
    expect(v.radius).toBeCloseTo(Math.SQRT2, 5);
    expect(Math.min(...h)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...h)).toBeCloseTo(1, 5);
    expect(v.geometry.getAttribute('normal')).toBeDefined();
    expect(v.triangles).toBe(24);
  });

  it('applies part tones to the shade', () => {
    const v = prepareVariant(parts, 1);
    const shade = v.geometry.getAttribute('aShade').array as Float32Array;
    expect(shade[0]).toBeGreaterThan(1.6); // trunk: 0.85–1.15 × tone 2
    expect(shade[shade.length - 1]).toBeLessThan(1.2); // foliage: tone 1
  });
});

describe('prepareModel', () => {
  it('builds 4 variants and a default impostor', async () => {
    const m = await prepareModel(conifer);
    expect(m.id).toBe('conifer');
    expect(m.variants).toHaveLength(4);
    expect(m.impostor.triangles).toBeLessThanOrEqual(24);
  });

  it('supports async builds and custom impostors', async () => {
    const custom: TreeModel = {
      id: 'box',
      variants: 2,
      build: async () => ({ trunk: new BoxGeometry(1, 1, 1), foliage: new BoxGeometry(1, 1, 1) }),
      impostor: () => ({ trunk: mergeParts([]), foliage: new BoxGeometry(1, 1, 1) }),
    };
    const m = await prepareModel(custom);
    expect(m.variants).toHaveLength(2);
    expect(m.impostor.triangles).toBe(12);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/models.test.ts`
Expected: FAIL with "Cannot find module '../../src/trees/models/procedural'".

- [ ] **Step 3: Implement**

`src/trees/models/types.ts`:
```ts
import type { BufferGeometry } from 'three';

/** A tree's geometry in metres, glTF axes (Y up), base at y = 0. Colours come from the theme. */
export interface TreeParts {
  trunk: BufferGeometry;
  foliage: BufferGeometry;
  /** Brightness multiplier on the theme's trunk colour (e.g. pale birch bark). Default 1. */
  trunkTone?: number;
  /** Brightness multiplier on the theme's foliage colour. Default 1. */
  foliageTone?: number;
}

export interface TreeModel {
  id: string;
  /** Seeded variants to prebuild. Default 4. */
  variants?: number;
  build(seed: number): TreeParts | Promise<TreeParts>;
  /** Far-LOD stand-in. Default: a cone or round crown derived from variant 0's bounds. */
  impostor?(): TreeParts | Promise<TreeParts>;
}
```

`src/trees/models/procedural.ts`:
```ts
import {
  BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  Euler,
  Float32BufferAttribute,
  IcosahedronGeometry,
  Matrix4,
  OctahedronGeometry,
  Quaternion,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { seededRand } from '../hash';
import type { TreeModel, TreeParts } from './types';

type Vec3 = [number, number, number];

function placed(g: BufferGeometry, pos: Vec3, rot: Vec3 = [0, 0, 0]): BufferGeometry {
  const m = new Matrix4().compose(
    new Vector3(...pos),
    new Quaternion().setFromEuler(new Euler(...rot)),
    new Vector3(1, 1, 1),
  );
  return g.applyMatrix4(m);
}

/** Merge into one non-indexed, position-only geometry (normals are recomputed later). */
export function mergeParts(geoms: BufferGeometry[]): BufferGeometry {
  const clean = geoms.map((g) => {
    const flat = g.index ? g.toNonIndexed() : g;
    const out = new BufferGeometry();
    out.setAttribute('position', flat.getAttribute('position'));
    return out;
  });
  if (!clean.length) {
    const empty = new BufferGeometry();
    empty.setAttribute('position', new Float32BufferAttribute([], 3));
    return empty;
  }
  const merged = mergeGeometries(clean);
  if (!merged) throw new Error('mergeGeometries failed');
  return merged;
}

/** Conifer: tapered, slightly irregular trunk + 4 layered, offset cones (from the CodePen). */
export const conifer: TreeModel = {
  id: 'conifer',
  build(seed): TreeParts {
    const rand = seededRand(seed);
    const trunkH = 3.0 + rand() * 1.5;
    const trunk = new CylinderGeometry(0.25, 0.55, trunkH, 6);
    const tpos = trunk.getAttribute('position');
    for (let i = 0; i < tpos.count; i++) {
      const r = 0.92 + rand() * 0.16;
      tpos.setX(i, tpos.getX(i) * r);
      tpos.setZ(i, tpos.getZ(i) * r);
    }
    trunk.translate(0, trunkH / 2, 0);
    const cones: BufferGeometry[] = [];
    for (let i = 0; i < 4; i++) {
      const t = i / 3;
      const radius = (2.2 - t * 1.5) * (0.85 + rand() * 0.3);
      const height = (3.5 - t * 1.5) * (0.85 + rand() * 0.3);
      const sides = 6 + Math.floor(rand() * 3);
      const pos: Vec3 = [(rand() - 0.5) * 0.4, trunkH + 1 + i * (height * 0.55), (rand() - 0.5) * 0.4];
      cones.push(placed(new ConeGeometry(radius, height, sides), pos, [0, rand() * Math.PI * 2, 0]));
    }
    return { trunk: mergeParts([trunk]), foliage: mergeParts(cones), foliageTone: 0.8 };
  },
};

/** Deciduous: bent trunk + lumpy crown of icosphere lobes (from the CodePen). */
export const deciduous: TreeModel = {
  id: 'deciduous',
  build(seed): TreeParts {
    const rand = seededRand(seed);
    const trunkH = 2.5 + rand() * 1.2;
    const trunk = new CylinderGeometry(0.3, 0.6, trunkH, 6);
    let bx = rand() - 0.5;
    let bz = rand() - 0.5;
    const blen = Math.hypot(bx, bz);
    if (blen < 1e-6) {
      bx = 1;
      bz = 0;
    } else {
      bx /= blen;
      bz /= blen;
    }
    const tpos = trunk.getAttribute('position');
    for (let i = 0; i < tpos.count; i++) {
      const yNorm = (tpos.getY(i) + trunkH / 2) / trunkH;
      const bend = Math.pow(yNorm, 1.5) * 0.4;
      tpos.setX(i, tpos.getX(i) + bx * bend);
      tpos.setZ(i, tpos.getZ(i) + bz * bend);
    }
    trunk.translate(0, trunkH / 2, 0);
    const centre: Vec3 = [bx * 0.4, trunkH + 1.6, bz * 0.4];
    const lobes: BufferGeometry[] = [];
    const lobeCount = 5 + Math.floor(rand() * 3);
    for (let i = 0; i < lobeCount; i++) {
      const angle = (i / lobeCount) * Math.PI * 2 + rand() * 0.5;
      const dist = 0.6 + rand() * 0.9;
      const lobeR = 1.2 + rand() * 1.0;
      const pos: Vec3 = [
        centre[0] + Math.cos(angle) * dist,
        centre[1] + (rand() - 0.3) * 0.8,
        centre[2] + Math.sin(angle) * dist,
      ];
      lobes.push(
        placed(new IcosahedronGeometry(lobeR, 0), pos, [
          rand() * Math.PI,
          rand() * Math.PI,
          rand() * Math.PI,
        ]),
      );
    }
    lobes.push(
      placed(new IcosahedronGeometry(1.5 + rand() * 0.5, 0), centre, [
        rand() * Math.PI,
        rand() * Math.PI,
        rand() * Math.PI,
      ]),
    );
    return { trunk: mergeParts([trunk]), foliage: mergeParts(lobes) };
  },
};

/** Birch: slim pale trunk + small round crown (from the CodePen). */
export const birch: TreeModel = {
  id: 'birch',
  build(seed): TreeParts {
    const rand = seededRand(seed);
    const trunkH = 4 + rand() * 1.5;
    const trunk = new CylinderGeometry(0.18, 0.28, trunkH, 6).translate(0, trunkH / 2, 0);
    const baseY = trunkH + 1;
    const lobes: BufferGeometry[] = [];
    const count = 4 + Math.floor(rand() * 2);
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      const pos: Vec3 = [Math.cos(angle) * 0.7, baseY + (rand() - 0.5) * 0.5, Math.sin(angle) * 0.7];
      lobes.push(placed(new IcosahedronGeometry(0.9 + rand() * 0.4, 0), pos));
    }
    lobes.push(placed(new IcosahedronGeometry(1.0, 0), [0, baseY, 0]));
    return { trunk: mergeParts([trunk]), foliage: mergeParts(lobes), trunkTone: 2.4, foliageTone: 1.25 };
  },
};

/** Cheap far-LOD stand-in: 6-sided cone (12 tris) or octahedron on an open 3-sided trunk (14 tris). */
export function defaultImpostor(height: number, radius: number, conical: boolean): TreeParts {
  if (conical) {
    return {
      trunk: mergeParts([]),
      foliage: mergeParts([new ConeGeometry(radius, height, 6).translate(0, height / 2, 0)]),
    };
  }
  const trunkH = height * 0.45;
  return {
    trunk: mergeParts([
      new CylinderGeometry(radius * 0.1, radius * 0.12, trunkH, 3, 1, true).translate(0, trunkH / 2, 0),
    ]),
    foliage: mergeParts([new OctahedronGeometry(radius * 0.9, 0).translate(0, height * 0.65, 0)]),
  };
}
```

`src/trees/models/prepare.ts`:
```ts
import { BufferAttribute, type BufferGeometry } from 'three';
import { hashString, seededRand } from '../hash';
import { defaultImpostor, mergeParts } from './procedural';
import type { TreeModel, TreeParts } from './types';

export interface PreparedVariant {
  geometry: BufferGeometry;
  height: number;
  radius: number;
  triangles: number;
}

export interface PreparedModel {
  id: string;
  variants: PreparedVariant[];
  impostor: PreparedVariant;
}

/** Merge trunk + foliage and add aPart / aShade / aHeight for the tree material. */
export function prepareVariant(parts: TreeParts, seed: number): PreparedVariant {
  const trunk = mergeParts([parts.trunk]);
  const foliage = mergeParts([parts.foliage]);
  const trunkCount = trunk.getAttribute('position').count;
  const geometry = mergeParts([trunk, foliage]);
  geometry.computeVertexNormals();
  const pos = geometry.getAttribute('position');
  const n = pos.count;
  geometry.computeBoundingBox();
  const height = Math.max(geometry.boundingBox!.max.y, 1e-3);
  const part = new Float32Array(n);
  const shade = new Float32Array(n);
  const h = new Float32Array(n);
  const rand = seededRand(seed ^ 0x5bd1e995);
  let radius = 0;
  for (let tri = 0; tri < n / 3; tri++) {
    const s = 0.85 + 0.3 * rand();
    for (let k = 0; k < 3; k++) {
      const i = tri * 3 + k;
      const isFoliage = i >= trunkCount;
      part[i] = isFoliage ? 1 : 0;
      shade[i] = s * (isFoliage ? (parts.foliageTone ?? 1) : (parts.trunkTone ?? 1));
      h[i] = Math.min(1, Math.max(0, pos.getY(i) / height));
      radius = Math.max(radius, Math.hypot(pos.getX(i), pos.getZ(i)));
    }
  }
  geometry.setAttribute('aPart', new BufferAttribute(part, 1));
  geometry.setAttribute('aShade', new BufferAttribute(shade, 1));
  geometry.setAttribute('aHeight', new BufferAttribute(h, 1));
  return { geometry, height, radius, triangles: n / 3 };
}

export async function prepareModel(model: TreeModel): Promise<PreparedModel> {
  const count = Math.max(1, Math.floor(model.variants ?? 4));
  const base = hashString(model.id);
  const variants: PreparedVariant[] = [];
  for (let i = 0; i < count; i++) {
    const seed = (base + i * 7919) | 0;
    variants.push(prepareVariant(await model.build(seed), seed));
  }
  const v0 = variants[0]!;
  const impostorParts = model.impostor
    ? await model.impostor()
    : defaultImpostor(v0.height, Math.max(v0.radius, 0.5), model.id.includes('conifer'));
  return { id: model.id, variants, impostor: prepareVariant(impostorParts, base ^ 0x1234) };
}

export function disposePrepared(m: PreparedModel): void {
  for (const v of [...m.variants, m.impostor]) v.geometry.dispose();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/models.test.ts`
Expected: PASS (15 tests). If a procedural model exceeds 400 triangles, report the count. Do not
change the budget; reduce sides or detail in that model instead and record a ruling.

- [ ] **Step 5: Check.** Run `npx tsc --noEmit && npx prettier --write src tests >/dev/null && npm run lint`.
  Expected: clean.

- [ ] **Step 6: Checkpoint.** Do not commit.

---

### Task 6: GLB tree models

**Files:**
- Create: `src/trees/models/glb.ts`, `tests/unit/glb-fixture.ts`
- Test: `tests/unit/glb.test.ts`

**Interfaces:**
- Consumes:
  - `parseGlb`, `disposeObject` from `src/landmarks/loader.ts`
  - `HttpError`, `globalFetch`, `type Fetch` from `src/landmarks/catalogue.ts`
  - `mergeParts` from `procedural.ts`
- Produces:
  - `interface GlbTreeOptions { id?: string; foliage: string[]; trunk: string[]; fetch?: Fetch; trunkTone?: number; foliageTone?: number }`
  - `treeModelFromGLB(url: string, opts: GlbTreeOptions): TreeModel` (`variants: 1`; loads once)
  - Test helper `makeGlb(meshes: { material: string; positions: number[] }[]): Uint8Array`

- [ ] **Step 1: Write the fixture builder and the failing test**

`tests/unit/glb-fixture.ts`:
```ts
/** Builds a minimal binary glTF (one node + mesh per entry, one named material each). */
export function makeGlb(meshes: { material: string; positions: number[] }[]): Uint8Array {
  const chunks: Float32Array[] = [];
  const bufferViews: object[] = [];
  const accessors: object[] = [];
  const gltfMeshes: object[] = [];
  const materials: object[] = [];
  let offset = 0;
  meshes.forEach((m, i) => {
    const arr = new Float32Array(m.positions);
    chunks.push(arr);
    const min = [0, 1, 2].map((k) => Math.min(...m.positions.filter((_, j) => j % 3 === k)));
    const max = [0, 1, 2].map((k) => Math.max(...m.positions.filter((_, j) => j % 3 === k)));
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: arr.byteLength });
    accessors.push({ bufferView: i, componentType: 5126, count: arr.length / 3, type: 'VEC3', min, max });
    materials.push({ name: m.material, pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] } });
    gltfMeshes.push({ primitives: [{ attributes: { POSITION: i }, material: i }] });
    offset += arr.byteLength;
  });
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: meshes.map((_, i) => i) }],
    nodes: meshes.map((_, i) => ({ mesh: i })),
    meshes: gltfMeshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: offset }],
  };
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  if (jsonPad) {
    const padded = new Uint8Array(jsonBytes.length + jsonPad).fill(0x20);
    padded.set(jsonBytes);
    jsonBytes = padded;
  }
  const total = 12 + 8 + jsonBytes.length + 8 + offset;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); // 'glTF'
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, 0x4e4f534a, true); // 'JSON'
  out.set(jsonBytes, 20);
  const binStart = 20 + jsonBytes.length;
  view.setUint32(binStart, offset, true);
  view.setUint32(binStart + 4, 0x004e4942, true); // 'BIN\0'
  let p = binStart + 8;
  for (const c of chunks) {
    out.set(new Uint8Array(c.buffer), p);
    p += c.byteLength;
  }
  return out;
}
```

`tests/unit/glb.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { HttpError } from '../../src/landmarks/catalogue';
import { treeModelFromGLB } from '../../src/trees/models/glb';
import type { TreeParts } from '../../src/trees/models/types';
import { makeGlb } from './glb-fixture';
import { fakeFetch } from './helpers';

const GLB_URL = 'https://assets.test/trees/palm.glb';
const GLB = makeGlb([
  { material: 'bark', positions: [0, 0, 0, 0.2, 0, 0, 0, 2, 0] },
  { material: 'leaves', positions: [-1, 2, 0, 1, 2, 0, 0, 4, 0] },
  { material: 'misc', positions: [-1, 3, 0, 1, 3, 0, 0, 3.5, 0] },
]);

describe('treeModelFromGLB', () => {
  it('splits meshes into trunk and foliage by material name', async () => {
    const model = treeModelFromGLB(GLB_URL, { trunk: ['bark'], foliage: ['leaves'], fetch: fakeFetch({ [GLB_URL]: GLB }) });
    expect(model.id).toBe('palm');
    expect(model.variants).toBe(1);
    const parts = (await model.build(1)) as TreeParts;
    expect(parts.trunk.getAttribute('position').count).toBe(3);
    expect(parts.foliage.getAttribute('position').count).toBe(6); // leaves + unlisted misc
  });

  it('loads the file once and passes tones through', async () => {
    const f = fakeFetch({ [GLB_URL]: GLB });
    const model = treeModelFromGLB(GLB_URL, {
      id: 'my-palm',
      trunk: ['bark'],
      foliage: ['leaves'],
      fetch: f,
      trunkTone: 1.5,
    });
    const a = (await model.build(1)) as TreeParts;
    await model.build(2);
    expect(f.calls).toEqual([GLB_URL]);
    expect(model.id).toBe('my-palm');
    expect(a.trunkTone).toBe(1.5);
  });

  it('rejects with HttpError when the file is missing', async () => {
    const model = treeModelFromGLB(GLB_URL, { trunk: [], foliage: [], fetch: fakeFetch({}) });
    await expect(model.build(1)).rejects.toBeInstanceOf(HttpError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/glb.test.ts`
Expected: FAIL with "Cannot find module '../../src/trees/models/glb'".

- [ ] **Step 3: Implement**

`src/trees/models/glb.ts`:
```ts
import type { BufferGeometry, Material, Mesh } from 'three';
import { globalFetch, HttpError, type Fetch } from '../../landmarks/catalogue';
import { disposeObject, parseGlb } from '../../landmarks/loader';
import { mergeParts } from './procedural';
import type { TreeModel, TreeParts } from './types';

export interface GlbTreeOptions {
  /** Defaults to the file name without extension. */
  id?: string;
  /** Material names that are leaves (unlisted materials also count as foliage). */
  foliage: string[];
  /** Material names that are bark/trunk. */
  trunk: string[];
  fetch?: Fetch;
  trunkTone?: number;
  foliageTone?: number;
}

/** Wrap a GLB asset (metres, Y up, base at 0) as a single-variant, theme-coloured TreeModel. */
export function treeModelFromGLB(url: string, opts: GlbTreeOptions): TreeModel {
  const fetchFn = opts.fetch ?? globalFetch;
  let parts: Promise<TreeParts> | undefined;
  const load = async (): Promise<TreeParts> => {
    const res = await fetchFn(url);
    if (!res.ok) throw new HttpError(res.status, url);
    const root = await parseGlb(await res.arrayBuffer());
    root.updateMatrixWorld(true);
    const trunk: BufferGeometry[] = [];
    const foliage: BufferGeometry[] = [];
    root.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      const material = ([] as Material[]).concat(mesh.material)[0];
      const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
      (opts.trunk.includes(material?.name ?? '') ? trunk : foliage).push(geometry);
    });
    disposeObject(root);
    return {
      trunk: mergeParts(trunk),
      foliage: mergeParts(foliage),
      trunkTone: opts.trunkTone,
      foliageTone: opts.foliageTone,
    };
  };
  const fileName = url.split('?')[0]!.split('/').pop() ?? 'tree';
  return {
    id: opts.id ?? fileName.replace(/\.[^.]*$/, ''),
    variants: 1,
    build: () => (parts ??= load()),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/glb.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Check.** Run `npx tsc --noEmit && npx prettier --write src tests >/dev/null && npm run lint`.
  Expected: clean.

- [ ] **Step 6: Checkpoint.** Do not commit.

---

### Task 7: Themed, wind-animated tree material

**Files:**
- Create: `src/trees/material.ts`
- Test: `tests/unit/material.test.ts`

**Interfaces:**
- Consumes: `THEMES`, `type Theme` from `src/core/theme.ts`
- Produces:
  - `interface TreeUniforms { uTime: { value: number }; uWindDir: { value: Vector2 }; uWindStrength: { value: number }; uFoliage: { value: Color }; uFoliageJitter: { value: number }; uTrunk: { value: Color } }`
  - `windVector(directionDeg: number): [number, number]`: downwind direction in local XZ
  - `createTreeMaterial(): { material: MeshStandardMaterial; uniforms: TreeUniforms; setTheme(theme: Theme): void; setWind(strength: number, directionDeg: number): void }`.
    `material.userData.treeUniforms === uniforms`.

- [ ] **Step 1: Write the failing test**

`tests/unit/material.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { Color, ShaderLib } from 'three';
import { THEMES } from '../../src/core/theme';
import { createTreeMaterial, windVector } from '../../src/trees/material';

describe('windVector', () => {
  it('points downwind in local XZ (X east, Z south)', () => {
    const [x1, z1] = windVector(270); // westerly blows east
    expect(x1).toBeCloseTo(1, 6);
    expect(z1).toBeCloseTo(0, 6);
    const [x2, z2] = windVector(0); // northerly blows south (+Z)
    expect(x2).toBeCloseTo(0, 6);
    expect(z2).toBeCloseTo(1, 6);
  });
});

describe('createTreeMaterial', () => {
  it('patches the standard shader with wind and palette colouring', () => {
    const { material, uniforms } = createTreeMaterial();
    const shader = {
      vertexShader: ShaderLib.physical.vertexShader,
      fragmentShader: ShaderLib.physical.fragmentShader,
      uniforms: {} as Record<string, unknown>,
    };
    material.onBeforeCompile(shader as never, {} as never);
    expect(shader.vertexShader).not.toContain('#include <project_vertex>');
    expect(shader.vertexShader).toContain('mvPosition = instanceMatrix * mvPosition');
    expect(shader.vertexShader).toContain('uWindDir');
    expect(shader.vertexShader).toContain('attribute float aTint');
    expect(shader.fragmentShader).toContain('mix(uTrunk, foliageCol, vPart)');
    expect(shader.uniforms.uTime).toBe(uniforms.uTime);
    expect(material.customProgramCacheKey()).toBe('trees-v1');
    expect(material.userData.treeUniforms).toBe(uniforms);
  });

  it('applies theme palettes and wind', () => {
    const { uniforms, setTheme, setWind } = createTreeMaterial();
    setTheme('night');
    expect(uniforms.uFoliage.value.equals(new Color(THEMES.night.palette.foliage))).toBe(true);
    expect(uniforms.uTrunk.value.equals(new Color(THEMES.night.palette.trunk))).toBe(true);
    expect(uniforms.uFoliageJitter.value).toBe(THEMES.night.palette.foliageJitter);
    setWind(1.5, 270);
    expect(uniforms.uWindStrength.value).toBe(1.5);
    expect(uniforms.uWindDir.value.x).toBeCloseTo(1, 6);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/material.test.ts`
Expected: FAIL with "Cannot find module '../../src/trees/material'".

- [ ] **Step 3: Implement**

`src/trees/material.ts`:
```ts
import { Color, MeshStandardMaterial, Vector2 } from 'three';
import { THEMES, type Theme } from '../core/theme';

export interface TreeUniforms {
  uTime: { value: number };
  uWindDir: { value: Vector2 };
  uWindStrength: { value: number };
  uFoliage: { value: Color };
  uFoliageJitter: { value: number };
  uTrunk: { value: Color };
}

/** Downwind unit vector in local XZ for a wind blowing FROM `directionDeg` (clockwise from north). */
export function windVector(directionDeg: number): [number, number] {
  const to = ((directionDeg + 180) * Math.PI) / 180;
  return [Math.sin(to), -Math.cos(to)];
}

const VERTEX_DECL = /* glsl */ `
attribute float aPart;
attribute float aShade;
attribute float aHeight;
attribute float aTint;
varying float vPart;
varying float vShade;
varying float vTint;
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWindStrength;
`;

const PROJECT_WITH_WIND = /* glsl */ `
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
  vec3 treeOrigin = instanceMatrix[3].xyz;
#else
  vec3 treeOrigin = vec3( 0.0 );
#endif
float treeY = max( mvPosition.y - treeOrigin.y, 0.0 );
float phase = dot( treeOrigin.xz, vec2( 0.13, 0.07 ) );
float sway = ( sin( uTime * 1.1 + phase ) * 0.6 + sin( uTime * 2.3 + phase * 1.7 ) * 0.4 ) * uWindStrength;
mvPosition.xz += uWindDir * ( sway * 0.05 * aHeight * treeY + 0.15 * uWindStrength * aHeight );
mvPosition.xz += aPart * 0.05 * uWindStrength * vec2(
  sin( uTime * 6.0 + phase * 3.0 + position.y ),
  cos( uTime * 5.0 + phase * 2.0 + position.y ) );
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;
`;

const FRAGMENT_DECL = /* glsl */ `
varying float vPart;
varying float vShade;
varying float vTint;
uniform vec3 uFoliage;
uniform vec3 uTrunk;
uniform float uFoliageJitter;
`;

const PALETTE_COLOR = /* glsl */ `
#include <color_fragment>
vec3 foliageCol = uFoliage * ( 1.0 + ( vTint - 0.5 ) * uFoliageJitter );
foliageCol.r += ( vTint - 0.5 ) * uFoliageJitter * 0.08;
diffuseColor.rgb = mix(uTrunk, foliageCol, vPart) * vShade;
`;

export function createTreeMaterial() {
  const uniforms: TreeUniforms = {
    uTime: { value: 0 },
    uWindDir: { value: new Vector2(1, 0) },
    uWindStrength: { value: 1 },
    uFoliage: { value: new Color() },
    uFoliageJitter: { value: 0.3 },
    uTrunk: { value: new Color() },
  };
  const material = new MeshStandardMaterial({ flatShading: true, roughness: 0.9, metalness: 0 });
  material.userData.treeUniforms = uniforms;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_DECL}`)
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvPart = aPart;\nvShade = aShade;\nvTint = aTint;',
      )
      .replace('#include <project_vertex>', PROJECT_WITH_WIND);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_DECL}`)
      .replace('#include <color_fragment>', PALETTE_COLOR);
  };
  material.customProgramCacheKey = () => 'trees-v1';

  const setTheme = (theme: Theme) => {
    const p = THEMES[theme].palette;
    uniforms.uFoliage.value.setHex(p.foliage);
    uniforms.uTrunk.value.setHex(p.trunk);
    uniforms.uFoliageJitter.value = p.foliageJitter;
  };
  const setWind = (strength: number, directionDeg: number) => {
    uniforms.uWindStrength.value = Math.max(0, strength);
    uniforms.uWindDir.value.set(...windVector(directionDeg));
  };
  setTheme('day');
  return { material, uniforms, setTheme, setWind };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/material.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Check.** Run `npx tsc --noEmit && npx prettier --write src tests >/dev/null && npm run lint`.
  Expected: clean.

- [ ] **Step 6: Checkpoint.** Do not commit.

---

### Task 8: Instanced batches

**Files:**
- Create: `src/trees/batches.ts`
- Test: `tests/unit/batches.test.ts`

**Interfaces:**
- Consumes: `PreparedModel` from `prepare.ts`, `PlacedTree` from `select.ts`, `originAt` and
  `localPosition` from `src/core/mercator.ts`
- Produces:
  `class TreeBatches { readonly group: Group; constructor(material: Material, capacity: number); setModels(models: PreparedModel[]): void; write(trees: PlacedTree[], anchor: [number, number], elevation?: (p: [number, number]) => number): { near: number; far: number; drawn: number }; get drawn(): number; dispose(): void }`

- [ ] **Step 1: Write the failing test**

`tests/unit/batches.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, InstancedMesh, Matrix4, MeshBasicMaterial, Vector3 } from 'three';
import { TreeBatches } from '../../src/trees/batches';
import { prepareVariant, type PreparedModel } from '../../src/trees/models/prepare';
import type { PlacedTree } from '../../src/trees/select';

const box = () =>
  prepareVariant({ trunk: new BoxGeometry(0.2, 1, 0.2), foliage: new BoxGeometry(1, 1, 1) }, 1);
const model = (id: string, variants: number): PreparedModel => ({
  id,
  variants: Array.from({ length: variants }, box),
  impostor: box(),
});
const C: [number, number] = [2.29, 48.85];
const kx = 111_195 * Math.cos((C[1] * Math.PI) / 180);
const tree = (over: Partial<PlacedTree>): PlacedTree => ({
  key: 'k',
  lngLat: C,
  distanceM: 0,
  far: false,
  model: 0,
  variant: 0,
  scale: 1,
  rotation: 0,
  tint: 0.5,
  ...over,
});

describe('TreeBatches', () => {
  it('creates one mesh per model variant plus one impostor per model', () => {
    const b = new TreeBatches(new MeshBasicMaterial(), 10);
    b.setModels([model('a', 2), model('b', 1)]);
    expect(b.group.children).toHaveLength(2 + 1 + 2);
    expect(b.group.children.every((c) => (c as InstancedMesh).count === 0)).toBe(true);
  });

  it('writes instances relative to the anchor, splits LODs and writes tints', () => {
    const b = new TreeBatches(new MeshBasicMaterial(), 10);
    b.setModels([model('a', 2)]);
    const counts = b.write(
      [
        tree({ key: 'near', lngLat: [C[0] + 100 / kx, C[1]], variant: 1, tint: 0.25, scale: 2 }),
        tree({ key: 'far', far: true }),
      ],
      C,
    );
    expect(counts).toEqual({ near: 1, far: 1, drawn: 2 });
    const [v0, v1, imp] = b.group.children as InstancedMesh[];
    expect(v0!.count).toBe(0);
    expect(v1!.count).toBe(1);
    expect(imp!.count).toBe(1);
    const m = new Matrix4();
    v1!.getMatrixAt(0, m);
    const p = new Vector3().setFromMatrixPosition(m);
    expect(p.x).toBeCloseTo(100, 0);
    expect(new Vector3().setFromMatrixScale(m).x).toBeCloseTo(2, 5);
    expect(v1!.geometry.getAttribute('aTint').getX(0)).toBe(0.25);
  });

  it('adds terrain elevation and clamps to capacity', () => {
    const b = new TreeBatches(new MeshBasicMaterial(), 2);
    b.setModels([model('a', 1)]);
    const counts = b.write([tree({ key: '1' }), tree({ key: '2' }), tree({ key: '3' })], C, () => 12);
    expect(counts.drawn).toBe(2);
    const m = new Matrix4();
    (b.group.children[0] as InstancedMesh).getMatrixAt(0, m);
    expect(new Vector3().setFromMatrixPosition(m).y).toBe(12);
  });

  it('disposes meshes and geometries', () => {
    const b = new TreeBatches(new MeshBasicMaterial(), 2);
    const m = model('a', 1);
    b.setModels([m]);
    const spy = vi.spyOn(m.variants[0]!.geometry, 'dispose');
    b.dispose();
    expect(spy).toHaveBeenCalled();
    expect(b.group.children).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/batches.test.ts`
Expected: FAIL with "Cannot find module '../../src/trees/batches'".

- [ ] **Step 3: Implement**

`src/trees/batches.ts`:
```ts
import {
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3,
  type Material,
} from 'three';
import { localPosition, originAt } from '../core/mercator';
import type { PreparedModel } from './models/prepare';
import type { PlacedTree } from './select';

/** Instanced meshes for every (model × variant) plus one impostor mesh per model. */
export class TreeBatches {
  readonly group = new Group();
  private near: InstancedMesh[][] = [];
  private far: InstancedMesh[] = [];
  private total = 0;

  constructor(
    private readonly material: Material,
    private readonly capacity: number,
  ) {}

  get drawn(): number {
    return this.total;
  }

  setModels(models: PreparedModel[]): void {
    this.clearMeshes();
    this.near = models.map((m) => m.variants.map((v) => this.mesh(v.geometry)));
    this.far = models.map((m) => this.mesh(m.impostor.geometry));
  }

  write(
    trees: PlacedTree[],
    anchor: [number, number],
    elevation: (p: [number, number]) => number = () => 0,
  ): { near: number; far: number; drawn: number } {
    const all = this.meshes();
    for (const mesh of all) mesh.count = 0;
    const origin = originAt(anchor);
    const m = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    const pos = new Vector3();
    const scale = new Vector3();
    let near = 0;
    let far = 0;
    for (const t of trees) {
      const variants = this.near[t.model];
      if (!variants?.length) continue;
      const mesh = t.far ? this.far[t.model]! : variants[t.variant % variants.length]!;
      const i = mesh.count;
      if (i >= this.capacity || near + far >= this.capacity) continue;
      const [x, y, z] = localPosition(origin, t.lngLat, elevation(t.lngLat));
      m.compose(pos.set(x, y, z), q.setFromAxisAngle(up, t.rotation), scale.setScalar(t.scale));
      mesh.setMatrixAt(i, m);
      (mesh.geometry.getAttribute('aTint') as InstancedBufferAttribute).setX(i, t.tint);
      mesh.count = i + 1;
      if (t.far) far++;
      else near++;
    }
    for (const mesh of all) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.geometry.getAttribute('aTint').needsUpdate = true;
    }
    this.total = near + far;
    return { near, far, drawn: this.total };
  }

  dispose(): void {
    this.clearMeshes();
  }

  private mesh(geometry: InstancedMesh['geometry']): InstancedMesh {
    geometry.setAttribute(
      'aTint',
      new InstancedBufferAttribute(new Float32Array(this.capacity), 1),
    );
    const mesh = new InstancedMesh(geometry, this.material, this.capacity);
    mesh.count = 0;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    return mesh;
  }

  private meshes(): InstancedMesh[] {
    return [...this.near.flat(), ...this.far];
  }

  private clearMeshes(): void {
    for (const mesh of this.meshes()) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
      mesh.dispose();
    }
    this.near = [];
    this.far = [];
    this.total = 0;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/batches.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Check.** Run `npx tsc --noEmit && npx prettier --write src tests >/dev/null && npm run lint`.
  Expected: clean.

- [ ] **Step 6: Checkpoint.** Do not commit.

---

### Task 9: TreesModule, TreesLayer and exports

**Files:**
- Create: `src/trees/TreesModule.ts`, `src/trees/TreesLayer.ts`
- Modify: `src/index.ts`
- Test: `tests/unit/trees.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–8; `padBounds` and `padMetres` from
  `src/landmarks/discovery.ts`; `ModuleLayer` and `ModuleLayerOptions`
- Produces:
  - `interface TreesWind { strength?: number; directionDeg?: number }`
  - `interface TreesOptions { source: string; sourceLayers?: { points?: string; polygons?: string }; models?: TreeModel[]; weights?: Record<string, number>; maxTrees?; minZoom?; lodDistanceM?; scatter?: Record<string, number> | false; scatterSkipRatio?; wind?: TreesWind; theme?: Theme; onError?: (err: unknown, ctx: { stage: 'source' | 'model'; id?: string }) => void }`
  - `interface TreeStats { mapped; scattered; drawn; near; far; updateMs; polygonsFilled; polygonsSkipped }`
  - `class TreesModule implements LayerModule { constructor(opts: TreesOptions); setWind(w: TreesWind); setTheme(t: Theme); getStats(): TreeStats }`
  - `interface TreesLayerOptions extends TreesOptions, ModuleLayerOptions { id: string }`
  - `class TreesLayer extends ModuleLayer { setWind; setTheme; getStats }`

- [ ] **Step 1: Write the failing test**

`tests/unit/trees.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Color, Group, Scene } from 'three';
import type { ModuleContext } from '../../src/core/LayerModule';
import { localPosition, originAt } from '../../src/core/mercator';
import { THEMES } from '../../src/core/theme';
import type { TreeModel } from '../../src/trees/models/types';
import { TreesModule, type TreesOptions } from '../../src/trees/TreesModule';
import type { TreeUniforms } from '../../src/trees/material';
import { flush, view } from './helpers';

const C: [number, number] = [2.2945, 48.8584];
const M = 111_195;
const kx = M * Math.cos((C[1] * Math.PI) / 180);
const at = (e: number, n: number): [number, number] => [C[0] + e / kx, C[1] + n / M];
const square = (e: number, n: number, size: number) => [
  at(e - size / 2, n - size / 2),
  at(e + size / 2, n - size / 2),
  at(e + size / 2, n + size / 2),
  at(e - size / 2, n + size / 2),
  at(e - size / 2, n - size / 2),
];
const point = (id: number, lngLat: [number, number]) => ({
  id,
  properties: { kind: 'tree' },
  geometry: { type: 'Point', coordinates: lngLat },
});
const polygon = (id: number, kind: string, ring: number[][]) => ({
  id,
  properties: { kind },
  geometry: { type: 'Polygon', coordinates: [ring] },
});

const box: TreeModel = {
  id: 'box',
  variants: 2,
  build: () => ({
    trunk: new BoxGeometry(0.2, 1, 0.2).translate(0, 0.5, 0),
    foliage: new BoxGeometry(1, 1, 1).translate(0, 1.5, 0),
  }),
};

function setup(over: Partial<TreesOptions> = {}, data?: { points?: unknown[]; polygons?: unknown[] }) {
  const features = {
    points: data?.points ?? [point(1, at(10, 0)), point(2, at(-20, 5)), point(3, at(400, 0))],
    polygons: data?.polygons ?? [],
  };
  const handlers = new Map<string, (e: unknown) => void>();
  const map = {
    features,
    handlers,
    getSource: (id: string) => (id === 'src' ? {} : undefined),
    getTerrain: () => null,
    queryTerrainElevation: () => 0,
    querySourceFeatures: vi.fn((_s: string, o: { filter: unknown[] }) =>
      o.filter[0] === '==' ? features.points : features.polygons,
    ),
    on: vi.fn((t: string, fn: (e: unknown) => void) => handlers.set(t, fn)),
    off: vi.fn((t: string) => handlers.delete(t)),
  };
  const scene = new Scene();
  const core = { theme: 'day', setTheme: vi.fn() };
  const requestRepaint = vi.fn();
  const onError = vi.fn();
  const module = new TreesModule({ source: 'src', models: [box], minZoom: 15, onError, ...over });
  module.onAdd({ map, core, scene, requestRepaint } as unknown as ModuleContext);
  return { module, map, scene, core, requestRepaint, onError };
}

const uniformsOf = (scene: Scene) =>
  (((scene.children[0] as Group).children[0] as unknown as { material: { userData: { treeUniforms: TreeUniforms } } })
    .material.userData.treeUniforms);

afterEach(() => vi.useRealTimers());

describe('TreesModule', () => {
  it('draws mapped trees once models are ready', async () => {
    const s = setup();
    s.module.update(view({ center: C, zoom: 17 }));
    await flush();
    const stats = s.module.getStats();
    expect(stats.mapped).toBe(3);
    expect(stats.drawn).toBe(3);
    expect(stats.near).toBe(2); // the tree 400 m away is beyond lodDistanceM 300
    expect(stats.far).toBe(1);
    expect(s.requestRepaint).toHaveBeenCalled();
  });

  it('applies the theme option and follows theme changes', async () => {
    const s = setup({ theme: 'dusk' });
    expect(s.core.setTheme).toHaveBeenCalledWith('dusk');
    await flush(); // meshes (and so the material) exist once models are prepared
    s.module.themeChanged('night');
    const u = uniformsOf(s.scene);
    expect(u.uFoliage.value.equals(new Color(THEMES.night.palette.foliage))).toBe(true);
  });

  it('scatters into a park without mapped trees and skips a forest full of them', async () => {
    const forestTrees = Array.from({ length: 20 }, (_, i) =>
      point(100 + i, at(-110 + (i % 5) * 10, -20 + Math.floor(i / 5) * 10)),
    );
    const s = setup({}, {
      points: forestTrees,
      polygons: [polygon(1, 'park', square(90, 0, 80)), polygon(2, 'forest', square(-90, 0, 60))],
    });
    s.module.update(view({ center: C, zoom: 17 }));
    await flush();
    const stats = s.module.getStats();
    expect(stats.polygonsFilled).toBe(1);
    expect(stats.polygonsSkipped).toBe(1);
    expect(stats.scattered).toBeGreaterThan(8);
    expect(stats.drawn).toBe(20 + stats.scattered);
  });

  it('recomputes scatter when more pieces of a polygon load', async () => {
    const full = square(90, 0, 80);
    const westHalf = [at(50, -40), at(90, -40), at(90, 40), at(50, 40), at(50, -40)];
    const s = setup({}, { points: [], polygons: [polygon(1, 'park', westHalf)] });
    s.module.update(view({ center: C, zoom: 17 }));
    await flush();
    const partial = s.module.getStats().scattered;
    s.map.features.polygons = [polygon(1, 'park', westHalf), polygon(1, 'park', full)];
    s.module.update(view({ center: C, zoom: 17 }));
    expect(s.module.getStats().scattered).toBeGreaterThan(partial);
  });

  it('draws nothing below minZoom', async () => {
    const s = setup();
    s.module.update(view({ center: C, zoom: 14 }));
    await flush();
    expect(s.module.getStats().drawn).toBe(0);
    expect(s.map.querySourceFeatures).not.toHaveBeenCalled();
  });

  it('caps at maxTrees', async () => {
    const s = setup({ maxTrees: 2 });
    s.module.update(view({ center: C, zoom: 17 }));
    await flush();
    expect(s.module.getStats().drawn).toBe(2);
  });

  it('animates only while there is wind and trees', async () => {
    const s = setup();
    expect(s.module.frame(1000)).toBe(false); // nothing drawn yet
    s.module.update(view({ center: C, zoom: 17 }));
    await flush();
    expect(s.module.frame(2000)).toBe(true);
    expect(uniformsOf(s.scene).uTime.value).toBe(2);
    s.module.setWind({ strength: 0 });
    expect(s.module.frame(3000)).toBe(false);
  });

  it('reports a missing source once', async () => {
    const s = setup({ source: 'nope' });
    await flush();
    s.module.update(view({ center: C, zoom: 17 }));
    s.module.update(view({ center: C, zoom: 17 }));
    expect(s.onError).toHaveBeenCalledTimes(1);
    expect(s.onError.mock.calls[0]![1]).toEqual({ stage: 'source' });
  });

  it('drops a failing model, reports it, and draws with the others', async () => {
    const broken: TreeModel = { id: 'broken', build: () => Promise.reject(new Error('404')) };
    const s = setup({ models: [broken, box] });
    s.module.update(view({ center: C, zoom: 17 }));
    await flush();
    expect(s.onError).toHaveBeenCalledWith(expect.any(Error), { stage: 'model', id: 'broken' });
    expect(s.module.getStats().drawn).toBe(3);
  });

  it('re-runs the update when tiles of its source load', async () => {
    const s = setup({}, { points: [] });
    s.module.update(view({ center: C, zoom: 17 }));
    await flush();
    expect(s.module.getStats().drawn).toBe(0);
    vi.useFakeTimers();
    s.map.features.points = [point(1, at(10, 0))];
    s.map.handlers.get('sourcedata')!({ sourceId: 'other' });
    vi.advanceTimersByTime(250);
    expect(s.module.getStats().drawn).toBe(0);
    s.map.handlers.get('sourcedata')!({ sourceId: 'src' });
    vi.advanceTimersByTime(250);
    expect(s.module.getStats().drawn).toBe(1);
  });

  it('places the batch group relative to the render origin', async () => {
    const s = setup();
    s.module.update(view({ center: C, zoom: 17 }));
    await flush();
    const origin = originAt(at(50, 0));
    s.module.place(origin);
    const group = s.scene.children[0] as Group;
    expect(group.position.x).toBeCloseTo(localPosition(origin, C, 0)[0], 6);
  });

  it('cleans up, including when removed before models are ready', async () => {
    const s = setup();
    s.module.onRemove();
    await flush();
    expect(s.scene.children).toHaveLength(0);
    expect(s.map.handlers.has('sourcedata')).toBe(false);
    expect(s.onError).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/trees.test.ts`
Expected: FAIL with "Cannot find module '../../src/trees/TreesModule'".

- [ ] **Step 3: Implement**

`src/trees/TreesModule.ts`:
```ts
import type { LayerModule, ModuleContext } from '../core/LayerModule';
import { localPosition } from '../core/mercator';
import type { Theme } from '../core/theme';
import type { Bounds, LngLat, Origin, ViewState } from '../core/types';
import { padBounds, padMetres } from '../landmarks/discovery';
import { TreeBatches } from './batches';
import {
  collectMapped,
  collectPolygons,
  piecesHash,
  PointIndex,
  type MappedTree,
  type PolygonGroup,
} from './collect';
import { createTreeMaterial } from './material';
import { disposePrepared, prepareModel, type PreparedModel } from './models/prepare';
import { birch, conifer, deciduous } from './models/procedural';
import type { TreeModel } from './models/types';
import { scatterPolygon, shouldScatter, type ScatterPoint } from './scatter';
import { selectTrees, type PlacedTree } from './select';

export interface TreesWind {
  strength?: number;
  /** Where the wind blows from, degrees clockwise from north. */
  directionDeg?: number;
}

export interface TreesOptions {
  source: string;
  /** Default { points: 'pois', polygons: 'landuse' }; '' means none (GeoJSON sources). */
  sourceLayers?: { points?: string; polygons?: string };
  models?: TreeModel[];
  weights?: Record<string, number>;
  maxTrees?: number;
  minZoom?: number;
  lodDistanceM?: number;
  /** Trees per m² by landuse kind; false disables scattering. */
  scatter?: Record<string, number> | false;
  scatterSkipRatio?: number;
  wind?: TreesWind;
  theme?: Theme;
  onError?: (err: unknown, ctx: { stage: 'source' | 'model'; id?: string }) => void;
}

export interface TreeStats {
  mapped: number;
  scattered: number;
  drawn: number;
  near: number;
  far: number;
  updateMs: number;
  polygonsFilled: number;
  polygonsSkipped: number;
}

const DEFAULT_WEIGHTS: Record<string, number> = { deciduous: 0.6, conifer: 0.2, birch: 0.2 };
const DEFAULT_SCATTER: Record<string, number> = { forest: 1 / 60, wood: 1 / 60, park: 1 / 400 };
const SCATTER_CACHE_LIMIT = 512;
const SOURCE_DEBOUNCE_MS = 200;

const inBounds = ([lng, lat]: LngLat, [w, s, e, n]: Bounds) =>
  lng >= w && lng <= e && lat >= s && lat <= n;

export class TreesModule implements LayerModule {
  private ctx?: ModuleContext;
  private readonly look = createTreeMaterial();
  private batches?: TreeBatches;
  private models: { model: TreeModel; prepared: PreparedModel }[] = [];
  private lastView?: ViewState;
  private anchor: LngLat = [0, 0];
  private readonly scatterCache = new Map<string, { hash: string; points: ScatterPoint[] }>();
  private stats: TreeStats = {
    mapped: 0,
    scattered: 0,
    drawn: 0,
    near: 0,
    far: 0,
    updateMs: 0,
    polygonsFilled: 0,
    polygonsSkipped: 0,
  };
  private wind: Required<TreesWind>;
  private themeOption?: Theme;
  private sourceErrorReported = false;
  private disposed = false;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly opts: TreesOptions) {
    this.wind = { strength: opts.wind?.strength ?? 1, directionDeg: opts.wind?.directionDeg ?? 250 };
    this.themeOption = opts.theme;
    this.look.setWind(this.wind.strength, this.wind.directionDeg);
  }

  onAdd(ctx: ModuleContext): void {
    this.ctx = ctx;
    this.disposed = false;
    if (this.themeOption) ctx.core.setTheme(this.themeOption);
    this.look.setTheme(ctx.core.theme);
    this.batches = new TreeBatches(this.look.material, this.opts.maxTrees ?? 4000);
    ctx.scene.add(this.batches.group);
    ctx.map.on('sourcedata', this.onSourceData);
    void this.loadModels();
  }

  update(view: ViewState): void {
    this.lastView = view;
    const ctx = this.ctx;
    if (!ctx || !this.batches || !this.models.length) return;
    const t0 = performance.now();
    if (view.zoom < (this.opts.minZoom ?? 16)) {
      this.write([], view);
      return;
    }
    if (!ctx.map.getSource(this.opts.source)) {
      this.reportSource(new Error(`Source "${this.opts.source}" not found`));
      this.write([], view);
      return;
    }
    const layers = { points: 'pois', polygons: 'landuse', ...this.opts.sourceLayers };
    const scatter = this.opts.scatter === false ? {} : (this.opts.scatter ?? DEFAULT_SCATTER);
    let mapped: MappedTree[];
    let polygons: PolygonGroup[];
    try {
      mapped = collectMapped(ctx.map, this.opts.source, layers.points);
      polygons = collectPolygons(ctx.map, this.opts.source, layers.polygons, Object.keys(scatter));
    } catch (err) {
      this.reportSource(err);
      this.write([], view);
      return;
    }

    const index = new PointIndex(mapped);
    const scattered = new Map<string, ScatterPoint>();
    let filled = 0;
    let skipped = 0;
    for (const g of polygons) {
      const density = scatter[g.kind]!;
      const inside = index.countInside(g.pieces);
      const hash = `${piecesHash(g.pieces)}|${inside}`;
      let hit = this.scatterCache.get(g.id);
      if (!hit || hit.hash !== hash) {
        const fill = shouldScatter(g.pieces, density, inside, this.opts.scatterSkipRatio ?? 0.25);
        hit = { hash, points: fill ? scatterPolygon(g.kind, g.pieces, density) : [] };
      }
      this.scatterCache.delete(g.id); // LRU: re-insert as most recent
      this.scatterCache.set(g.id, hit);
      if (this.scatterCache.size > SCATTER_CACHE_LIMIT) {
        this.scatterCache.delete(this.scatterCache.keys().next().value as string);
      }
      if (hit.points.length) filled++;
      else skipped++;
      for (const p of hit.points) scattered.set(p.key, p);
    }

    const padded = padBounds(view.bounds, padMetres(view.pitch, 30));
    const candidates = [...mapped, ...scattered.values()].filter((c) => inBounds(c.lngLat, padded));
    const selected = selectTrees(candidates, view.center, {
      maxTrees: this.opts.maxTrees ?? 4000,
      lodDistanceM: this.opts.lodDistanceM ?? 300,
      weights: this.models.map(
        ({ model }) => this.opts.weights?.[model.id] ?? DEFAULT_WEIGHTS[model.id] ?? 1,
      ),
      variants: this.models.map(({ prepared }) => prepared.variants.length),
    });
    this.write(selected, view);
    this.stats = {
      ...this.stats,
      mapped: mapped.length,
      scattered: scattered.size,
      polygonsFilled: filled,
      polygonsSkipped: skipped,
      updateMs: performance.now() - t0,
    };
  }

  place(origin: Origin): void {
    if (!this.batches) return;
    this.batches.group.position.set(...localPosition(origin, this.anchor, 0));
    this.batches.group.updateMatrixWorld(true);
  }

  frame(timeMs: number): boolean {
    this.look.uniforms.uTime.value = timeMs / 1000;
    return this.wind.strength > 0 && (this.batches?.drawn ?? 0) > 0;
  }

  themeChanged(theme: Theme): void {
    this.look.setTheme(theme);
    this.ctx?.requestRepaint();
  }

  styleChanged(attached: boolean): void {
    if (attached && this.lastView) this.update(this.lastView);
  }

  onRemove(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    const ctx = this.ctx;
    ctx?.map.off('sourcedata', this.onSourceData);
    if (this.batches) {
      ctx?.scene.remove(this.batches.group);
      this.batches.dispose(); // disposes every prepared geometry it holds
    }
    this.look.material.dispose();
    this.models = [];
    this.scatterCache.clear();
    this.batches = undefined;
    this.ctx = undefined;
  }

  setTheme(theme: Theme): void {
    this.themeOption = theme;
    this.ctx?.core.setTheme(theme);
  }

  setWind(wind: TreesWind): void {
    this.wind = { ...this.wind, ...wind };
    this.look.setWind(this.wind.strength, this.wind.directionDeg);
    this.ctx?.requestRepaint();
  }

  getStats(): TreeStats {
    return { ...this.stats };
  }

  private async loadModels(): Promise<void> {
    const models = this.opts.models ?? [deciduous, conifer, birch];
    const results = await Promise.allSettled(models.map((m) => prepareModel(m)));
    if (this.disposed || !this.batches) {
      for (const r of results) if (r.status === 'fulfilled') disposePrepared(r.value);
      return;
    }
    this.models = [];
    results.forEach((r, i) => {
      const model = models[i]!;
      if (r.status === 'fulfilled') this.models.push({ model, prepared: r.value });
      else this.report(r.reason, { stage: 'model', id: model.id });
    });
    this.batches.setModels(this.models.map((m) => m.prepared));
    if (this.lastView) this.update(this.lastView);
  }

  private write(trees: PlacedTree[], view: ViewState): void {
    const ctx = this.ctx;
    if (!ctx || !this.batches) return;
    this.anchor = view.center;
    const elevation = ctx.map.getTerrain()
      ? (p: LngLat) => ctx.map.queryTerrainElevation(p) ?? 0
      : undefined;
    const counts = this.batches.write(trees, this.anchor, elevation);
    this.stats = { ...this.stats, ...counts };
    if (!trees.length) this.stats = { ...this.stats, mapped: 0, scattered: 0 };
    ctx.requestRepaint();
  }

  private readonly onSourceData = (e: { sourceId?: string }): void => {
    if (e.sourceId !== this.opts.source || !this.lastView) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.lastView) this.update(this.lastView);
    }, SOURCE_DEBOUNCE_MS);
  };

  private reportSource(err: unknown): void {
    if (this.sourceErrorReported) return;
    this.sourceErrorReported = true;
    this.report(err, { stage: 'source' });
  }

  private report(err: unknown, ctx: { stage: 'source' | 'model'; id?: string }): void {
    if (this.opts.onError) this.opts.onError(err, ctx);
    else console.warn('[maplibre-landmarks trees]', ctx, err);
  }
}
```

`src/trees/TreesLayer.ts`:
```ts
import type { Theme } from '../core/theme';
import { ModuleLayer, type ModuleLayerOptions } from '../core/ModuleLayer';
import { TreesModule, type TreeStats, type TreesOptions, type TreesWind } from './TreesModule';

export interface TreesLayerOptions extends TreesOptions, ModuleLayerOptions {
  id: string;
}

/** MapLibre custom layer drawing instanced, wind-animated, theme-coloured 3D trees. */
export class TreesLayer extends ModuleLayer {
  private readonly trees: TreesModule;

  constructor(options: TreesLayerOptions) {
    const trees = new TreesModule(options);
    super(options.id, trees, options);
    this.trees = trees;
  }

  setWind(wind: TreesWind): void {
    this.trees.setWind(wind);
  }

  setTheme(theme: Theme): void {
    this.trees.setTheme(theme);
  }

  getStats(): TreeStats {
    return this.trees.getStats();
  }
}
```

`src/index.ts`: append:
```ts
export { TreesLayer, type TreesLayerOptions } from './trees/TreesLayer';
export {
  TreesModule,
  type TreeStats,
  type TreesOptions,
  type TreesWind,
} from './trees/TreesModule';
export { birch, conifer, deciduous, defaultImpostor } from './trees/models/procedural';
export { treeModelFromGLB, type GlbTreeOptions } from './trees/models/glb';
export type { TreeModel, TreeParts } from './trees/models/types';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/trees.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Full check.** Run
  `npx vitest run && npx tsc --noEmit && npx prettier --write src tests >/dev/null && npm run lint && npm run build`.
  Expected: every test passes, everything is clean, and the build succeeds. Report the bundle
  size; expect under 60 KB.

- [ ] **Step 6: Checkpoint.** Do not commit.

---

### Task 10: Demo, keyless browser test, measurement

**Files:**
- Modify: `demo/index.html`, `demo/main.ts`, `demo/vite.config.ts`
- Create: `demo/e2e-trees.html`, `demo/e2e-trees.ts`, `tests/browser/trees.pw.ts`

**Interfaces:**
- Consumes: `TreesLayer`, `setTheme`, `THEME_NAMES`, `type Theme`, `type TreeStats`,
  `LandmarksLayer`
- Produces: the test page globals `window.__trees`, `__map`, `__errors`, `__stats()`,
  `__setWind(s)` and `__setTheme(t)`, and the demo debug handle `window.__demo`.

- [ ] **Step 1: Write the failing browser test**

`tests/browser/trees.pw.ts`:
```ts
import { expect, test, type Page } from '@playwright/test';
import type {} from '../../demo/e2e-trees';

/** Share of green-dominant pixels and mean luminance of non-white pixels. */
const sample = (page: Page) =>
  page.evaluate(() => {
    const src = window.__map!.getCanvas();
    const c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(src, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let green = 0;
    let lum = 0;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const [r, g, b] = [d[i]!, d[i + 1]!, d[i + 2]!];
      if (r > 245 && g > 245 && b > 245) continue;
      n++;
      lum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (g > r + 8 && g > b + 8) green++;
    }
    return { green: green / (d.length / 4), lum: n ? lum / n : 255 };
  });

const idleWithin = (page: Page, ms: number) =>
  page.evaluate(
    (t) =>
      new Promise<boolean>((resolve) => {
        const map = window.__map!;
        const timer = setTimeout(() => resolve(false), t);
        map.once('idle', () => {
          clearTimeout(timer);
          resolve(true);
        });
        map.triggerRepaint();
      }),
    ms,
  );

test('draws mapped and scattered trees, animates wind and follows the theme', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  await page.goto('/e2e-trees.html');
  await page.waitForFunction(() => (window.__trees?.getStats().drawn ?? 0) > 0, null, {
    timeout: 30_000,
  });

  const stats = await page.evaluate(() => window.__stats());
  expect(stats.mapped).toBe(50);
  expect(stats.polygonsFilled).toBe(1); // park: no mapped trees
  expect(stats.polygonsSkipped).toBe(1); // forest: already full of mapped trees
  expect(stats.scattered).toBeGreaterThan(8);
  expect(stats.drawn).toBe(stats.mapped + stats.scattered);

  const day = await sample(page);
  expect(day.green).toBeGreaterThan(0.005);

  // Wind keeps repainting (never idle); calm lets the map go idle.
  expect(await idleWithin(page, 1500)).toBe(false);
  await page.evaluate(() => window.__setWind(0));
  expect(await idleWithin(page, 3000)).toBe(true);

  await page.evaluate(() => window.__setTheme('night'));
  await idleWithin(page, 3000);
  const night = await sample(page);
  expect(night.lum).toBeLessThan(day.lum * 0.8);

  expect(await page.evaluate(() => window.__errors)).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
```

Run: `npx playwright test tests/browser/trees.pw.ts --reporter=line`
Expected: FAIL. The page `/e2e-trees.html` does not exist yet (404, or a timeout waiting for
`__trees`).

- [ ] **Step 2: Create the keyless trees test page**

`demo/e2e-trees.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>e2e trees</title>
    <style>
      html,
      body,
      #map {
        margin: 0;
        width: 1024px;
        height: 768px;
      }
    </style>
  </head>
  <body>
    <div id="map"></div>
    <script type="module" src="./e2e-trees.ts"></script>
  </body>
</html>
```

`demo/e2e-trees.ts`:
```ts
import { Map as MlMap, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Feature } from 'geojson';
import { setTheme, TreesLayer, type Theme, type TreeStats } from '../src/index';

setWorkerUrl(workerUrl);

declare global {
  interface Window {
    __trees?: TreesLayer;
    __map?: MlMap;
    __errors: string[];
    __stats(): TreeStats;
    __setWind(strength: number): void;
    __setTheme(theme: Theme): void;
  }
}

const C: [number, number] = [2.2945, 48.8556];
const M = 111_195;
const kx = M * Math.cos((C[1] * Math.PI) / 180);
const at = (e: number, n: number): [number, number] => [C[0] + e / kx, C[1] + n / M];
const square = (e: number, n: number, size: number) => [
  at(e - size / 2, n - size / 2),
  at(e + size / 2, n - size / 2),
  at(e + size / 2, n + size / 2),
  at(e - size / 2, n + size / 2),
  at(e - size / 2, n - size / 2),
];

const features: Feature[] = [];
let id = 1;
// 30 mapped trees on a 40 m ring around the centre.
for (let i = 0; i < 30; i++) {
  const a = (i / 30) * 2 * Math.PI;
  features.push({
    type: 'Feature',
    id: id++,
    properties: { kind: 'tree' },
    geometry: { type: 'Point', coordinates: at(Math.cos(a) * 40, Math.sin(a) * 40) },
  });
}
// A 60 m forest 90 m west, already holding 20 mapped trees (≥ 25% of 3600/60 = 60): not scattered.
features.push({
  type: 'Feature',
  id: 200,
  properties: { kind: 'forest' },
  geometry: { type: 'Polygon', coordinates: [square(-90, 0, 60)] },
});
for (let i = 0; i < 20; i++) {
  features.push({
    type: 'Feature',
    id: id++,
    properties: { kind: 'tree' },
    geometry: {
      type: 'Point',
      coordinates: at(-110 + (i % 5) * 10, -20 + Math.floor(i / 5) * 10),
    },
  });
}
// An 80 m park 90 m east with no mapped trees: scattered (6400/400 ≈ 16 trees).
features.push({
  type: 'Feature',
  id: 100,
  properties: { kind: 'park' },
  geometry: { type: 'Polygon', coordinates: [square(90, 0, 80)] },
});

window.__errors = [];
const map = new MlMap({
  container: 'map',
  center: C,
  zoom: 17,
  pitch: 50,
  canvasContextAttributes: { preserveDrawingBuffer: true },
  style: {
    version: 8,
    sources: { t: { type: 'geojson', data: { type: 'FeatureCollection', features } } },
    layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#ffffff' } }],
  },
});
window.__map = map;
map.on('error', (e) => window.__errors.push(String(e.error?.message ?? e)));
map.once('load', () => {
  const trees = new TreesLayer({
    id: 'trees',
    source: 't',
    sourceLayers: { points: '', polygons: '' },
    minZoom: 15,
    theme: 'day',
    onError: (err, ctx) => window.__errors.push(`${ctx.stage}: ${String(err)}`),
  });
  window.__trees = trees;
  map.addLayer(trees);
});
window.__stats = () => window.__trees!.getStats();
window.__setWind = (strength) => window.__trees!.setWind({ strength });
window.__setTheme = (theme) => setTheme(map, theme);
```

`demo/vite.config.ts`: in `rollupOptions.input`, add
`trees: resolve(import.meta.dirname, 'e2e-trees.html'),` after the `e2e` entry.

- [ ] **Step 3: Run the browser tests**

Run: `npx tsc --noEmit && npm run test:browser`
Expected: 3 passed (the 2 existing tests plus the trees test). If a pixel assertion fails, take a
screenshot (`page.screenshot`) in a throwaway script, look at it, and debug with
`superpowers:systematic-debugging`. Do not loosen the thresholds without a ruling.

- [ ] **Step 4: Update the demo (theme selector, trees, wind, stats)**

`demo/index.html`: replace the line
`<label>Lighting <select id="lighting"> ... </select></label>` (the whole label, with its options)
with:
```html
      <label
        >Theme
        <select id="theme">
          <option>day</option>
          <option>dawn</option>
          <option>dusk</option>
          <option>night</option>
        </select>
      </label>
      <label>Wind <input id="wind" type="range" min="0" max="2" step="0.1" value="1" /></label>
      <p id="stats"></p>
```

`demo/main.ts`: replace the whole file with:
```ts
import {
  Map as MlMap,
  addProtocol,
  setWorkerUrl,
  type LayerSpecification,
  type StyleSpecification,
} from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { layers, namedFlavor } from '@protomaps/basemaps';
import { Protocol } from 'pmtiles';
import {
  LandmarksLayer,
  setTheme,
  TreesLayer,
  type LandmarkInfo,
  type Theme,
} from '../src/index';

setWorkerUrl(workerUrl);

const key = import.meta.env.VITE_PROTOMAPS_KEY as string | undefined;
const pmtilesUrl = import.meta.env.VITE_PMTILES_URL as string | undefined;
if (!key && !pmtilesUrl) {
  document.body.innerHTML =
    '<p class="missing">Set <code>VITE_PROTOMAPS_KEY</code> or <code>VITE_PMTILES_URL</code> in <code>.env.local</code> (see <code>.env.example</code>).</p>';
  throw new Error('No basemap tiles configured');
}
if (pmtilesUrl) addProtocol('pmtiles', new Protocol().tile);

/** Basemap flavour that matches each plugin theme. */
const FLAVOR: Record<Theme, 'light' | 'dark'> = {
  day: 'light',
  dawn: 'light',
  dusk: 'dark',
  night: 'dark',
};

/** Swap Protomaps' flat `buildings` fill for 3D extrusions so landmarks stand among real buildings. */
function withExtrudedBuildings(styleLayers: LayerSpecification[]): LayerSpecification[] {
  return styleLayers.map((l) =>
    l.id === 'buildings' && l.type === 'fill'
      ? {
          id: l.id,
          type: 'fill-extrusion',
          source: l.source,
          'source-layer': l['source-layer'],
          filter: l.filter,
          minzoom: 14,
          paint: {
            'fill-extrusion-color': l.paint?.['fill-color'] ?? '#d9d4ce',
            'fill-extrusion-height': ['coalesce', ['get', 'height'], 10],
            'fill-extrusion-base': ['coalesce', ['get', 'min_height'], 0],
            'fill-extrusion-opacity': 0.9,
          },
        }
      : l,
  );
}

function styleFor(theme: Theme): StyleSpecification {
  const flavor = FLAVOR[theme];
  return {
    version: 8,
    glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
    sprite: `https://protomaps.github.io/basemaps-assets/sprites/v4/${flavor}`,
    sources: {
      protomaps: {
        type: 'vector',
        url: pmtilesUrl
          ? `pmtiles://${pmtilesUrl}`
          : `https://api.protomaps.com/tiles/v4.json?key=${key}`,
        attribution:
          '<a href="https://protomaps.com">Protomaps</a> © <a href="https://openstreetmap.org">OpenStreetMap</a>',
      },
      terrain: {
        type: 'raster-dem',
        tiles: ['https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png'],
        encoding: 'terrarium',
        tileSize: 256,
        maxzoom: 15,
      },
    },
    layers: withExtrudedBuildings(layers('protomaps', namedFlavor(flavor), { lang: 'en' })),
  };
}

let theme: Theme = 'day';
let wind = 1;
const map = new MlMap({
  container: 'map',
  style: styleFor(theme),
  center: [2.2945, 48.8584],
  zoom: 16.5,
  pitch: 60,
  bearing: -20,
  hash: true,
});

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let landmarks: LandmarksLayer | undefined;
let trees: TreesLayer | undefined;
let channel: 'latest' | 'preview' = 'latest';

function renderList(models: LandmarkInfo[]) {
  $('models').innerHTML = models
    .map((m) => `<li>${m.name ?? m.id} <em>(${m.lod})</em><small>${m.attribution}</small></li>`)
    .join('');
}

const firstSymbol = () => map.getStyle().layers.find((l) => l.type === 'symbol')?.id;

function addLandmarks() {
  if (landmarks && map.getLayer(landmarks.id)) map.removeLayer(landmarks.id);
  landmarks = new LandmarksLayer({
    id: 'landmarks',
    channel,
    replaceBuildings: ['buildings'],
    onModelsChanged: renderList,
    onError: (err, ctx) => console.warn('[landmarks]', ctx, err),
  });
  map.addLayer(landmarks, firstSymbol());
}

function addTrees() {
  if (trees && map.getLayer(trees.id)) map.removeLayer(trees.id);
  trees = new TreesLayer({
    id: 'trees',
    source: 'protomaps',
    wind: { strength: wind },
    onError: (err, ctx) => console.warn('[trees]', ctx, err),
  });
  map.addLayer(trees, firstSymbol());
}

map.on('load', () => {
  setTheme(map, theme);
  addLandmarks();
  addTrees();
});
// A full (non-diffed) style swap drops custom layers: put them back.
map.on('style.load', () => {
  if (!map.getLayer('landmarks')) addLandmarks();
  if (!map.getLayer('trees')) addTrees();
});

$<HTMLSelectElement>('channel').onchange = (e) => {
  channel = (e.target as HTMLSelectElement).value as 'latest' | 'preview';
  addLandmarks();
};
$<HTMLSelectElement>('theme').onchange = (e) => {
  theme = (e.target as HTMLSelectElement).value as Theme;
  map.setStyle(styleFor(theme));
  setTheme(map, theme);
};
$<HTMLInputElement>('wind').oninput = (e) => {
  wind = Number((e.target as HTMLInputElement).value);
  trees?.setWind({ strength: wind });
};
$<HTMLInputElement>('terrain').onchange = (e) =>
  map.setTerrain(
    (e.target as HTMLInputElement).checked ? { source: 'terrain', exaggeration: 1 } : null,
  );

setInterval(() => {
  const s = trees?.getStats();
  if (s) {
    $('stats').textContent =
      `trees ${s.drawn} (near ${s.near}, far ${s.far}) · mapped ${s.mapped} · ` +
      `scattered ${s.scattered} · update ${s.updateMs.toFixed(1)} ms`;
  }
}, 1000);

// Debug handle for local measurement scripts.
(window as unknown as { __demo: object }).__demo = {
  map,
  get trees() {
    return trees;
  },
};
```

Run: `npx tsc --noEmit && npm run lint`. Expected: clean.

- [ ] **Step 5: Measure on real data**

Make sure the dev server runs with the keyless proxy. If `curl -s -o /dev/null -w "%{http_code}"
http://localhost:5179/` is not 200, start it in the background:
`VITE_PMTILES_URL=http://localhost:5179/protomaps-build/20261006.pmtiles npm run dev`.

Write this throwaway script **outside the repo** (in the session scratchpad) as
`measure-trees.mjs`:
```js
import { chromium } from '/Users/majid/maplibre-landmarks/node_modules/@playwright/test/index.mjs';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://localhost:5179/#16.6/48.8556/2.2980/-30/60');
await page.waitForFunction(() => (window.__demo?.trees?.getStats().drawn ?? 0) > 0, null, { timeout: 90000 });
await page.waitForTimeout(5000);
const stats = await page.evaluate(() => window.__demo.trees.getStats());
const frameMs = await page.evaluate(() => new Promise((res) => {
  let n = 0; const t0 = performance.now();
  const tick = () => { n++; if (performance.now() - t0 < 3000) requestAnimationFrame(tick); else res((performance.now() - t0) / n); };
  requestAnimationFrame(tick);
}));
await page.screenshot({ path: process.argv[2] });
console.log(JSON.stringify({ ...stats, frameMs: +frameMs.toFixed(1) }));
await browser.close();
```
Run: `node <scratchpad>/measure-trees.mjs <scratchpad>/trees.png`, then read the screenshot.
Expected:
- `drawn` is between 1 and 4000;
- `updateMs` is under 30;
- the screenshot shows trees on the Champ de Mars.

Report `updateMs`, `frameMs` (SwiftShader, CPU rendered; indicative only), `drawn` and
`scattered` to the user. If `updateMs` ≥ 30, report it and stop; do not add a Web Worker without
asking.

- [ ] **Step 6: Checkpoint.** Do not commit.

---

### Task 11: README and final verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document trees and themes**

In `README.md`, insert this section before `## Attribution and licences`:
````markdown
## Trees

```ts
import { TreesLayer, setTheme } from 'maplibre-landmarks';

map.addLayer(new TreesLayer({ id: 'trees', source: 'protomaps' }), 'pois');
setTheme(map, 'dusk'); // day | dawn | dusk | night: lights + tree/landmark palettes, map-wide
```

Trees come from Protomaps `pois` points with `kind=tree` (zoom 15+ tiles). Green `landuse` polygons
(`forest`, `wood`, `park` by default) are filled with seeded, stable trees only where mapped trees
are sparse. The nearest `maxTrees` (4000) are drawn from zoom 16, with cheap impostors beyond
`lodDistanceM` (300 m). Trees sway with `wind: { strength, directionDeg }` (`setWind`), and calm
wind stops the repaint loop.

| Option | Default | Description |
| --- | --- | --- |
| `source` | required | Vector (Protomaps schema) or GeoJSON source id |
| `sourceLayers` | `{ points: 'pois', polygons: 'landuse' }` | `''` for GeoJSON |
| `models` | `[deciduous, conifer, birch]` | Any `TreeModel` |
| `weights` | `{ deciduous: .6, conifer: .2, birch: .2 }` | Pick probability per model id |
| `maxTrees` / `minZoom` / `lodDistanceM` | `4000` / `16` / `300` | Budget |
| `scatter` | `{ forest: 1/60, wood: 1/60, park: 1/400 }` | Trees per m² by landuse kind; `false` = points only |
| `scatterSkipRatio` | `0.25` | Don't scatter a polygon whose mapped trees reach this share of its target |
| `wind` | `{ strength: 1, directionDeg: 250 }` | Direction the wind blows from |
| `theme` | — | Sets the map-wide theme |

Methods: `setWind(wind)`, `setTheme(theme)`, `getStats()`.

### Custom tree models

A model returns trunk and foliage geometry (metres, Y up, base at 0). Colours always come from the
theme palette, so every model follows `setTheme`.

```ts
import { treeModelFromGLB, type TreeModel } from 'maplibre-landmarks';

const palm = treeModelFromGLB('/models/palm.glb', { trunk: ['bark'], foliage: ['leaves'] });
const lollipop: TreeModel = {
  id: 'lollipop',
  build: (seed) => ({ trunk: myTrunkGeometry(seed), foliage: myCrownGeometry(seed) }),
};
map.addLayer(new TreesLayer({ id: 'trees', source: 'protomaps', models: [palm, lollipop] }));
```

The built-in procedural trees are adapted from the "maplibre-shaders" CodePen.
````

- [ ] **Step 2: Full verification**

Run:
```bash
npx prettier --write README.md >/dev/null
npx vitest run && npx tsc --noEmit && npm run lint && npm run build && npm run test:browser && npm pack --dry-run
```
Expected:
- every unit test passes;
- `tsc` and lint are clean;
- the build succeeds;
- 3 browser tests pass;
- the pack lists only `dist`, `README.md`, `LICENSE` and `package.json`.

- [ ] **Step 3: Checkpoint.** Do not commit. Summarise the results, the measurements from Task 10,
  and any rulings.
