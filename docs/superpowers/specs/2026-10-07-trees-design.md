# maplibre-landmarks: Trees and Theme Design

Date: 2026-10-07
Status: Draft for review
Builds on: `2026-10-07-maplibre-landmarks-design.md` (core, landmarks)

## 1. Goal

Add a tree layer to the plugin. It renders individual 3D trees on a Protomaps basemap with wind
animation, and the tree models are pluggable. Add a single shared **theme**
(`day | dawn | dusk | night`) that drives the lights and each module's palette, so that trees
and landmarks change together.

### Decisions made

- **Theme.** One theme is shared by the whole plugin and set per map. It controls the light rig
  and the module palettes. The app chooses the matching basemap flavor; the demo pairs them.
- **Models.** A single `TreeModel` interface. The built-in procedural models `conifer`,
  `deciduous` and `birch` are ported from the author's CodePen ("maplibre-shaders"). A
  `treeModelFromGLB` helper wraps asset files. The theme palette colours every model.
- **Budget.** Trees are shown from zoom 16. The nearest `maxTrees` (default 4000) are drawn.
  Trees further than `lodDistanceM` (default 300 m) use a cheap impostor.
- **Data.** Mapped trees come from Protomaps `pois` points with `kind=tree`. Trees are also
  scattered into green `landuse` polygons, decided per polygon: a polygon is filled only where
  mapped trees fall short of its target density.
- **Pipeline.** Everything runs on the main thread when the camera settles. Instancing is used.
  Wind and theme are shader uniforms.

### Data facts (verified on the 2026-10-06 Protomaps build)

- `pois` has `kind=tree` points with properties `kind` and `min_zoom` and a feature id. There is
  no species and no height. These points exist in z15 tiles only. One z15 tile over the Champ de
  Mars holds 2,556 trees. A Bois de Boulogne tile holds 470 trees plus 25 `forest` polygons.
- `landuse` kinds seen in the sampled tiles: `forest`, `wood`, `park`, `grass`, `meadow`, `scrub`,
  `garden`, `pitch`, and others.

### Non-goals

- Hiding trees that sit under landmark footprints.
- Grass, forest-canopy and water shader layers. Water remains a separate future module.
- Species inference.
- Web Worker processing. Add it only if measurement shows jank.
- Globe projection.

## 2. Theme (core)

`src/core/lighting.ts` becomes `src/core/theme.ts`:

```ts
export type Theme = 'day' | 'dawn' | 'dusk' | 'night';
export interface ThemeValues {
  sky: number; ground: number; hemi: number;            // hemisphere light
  sun: number; sunColor: number; sunDir: [number, number, number]; // directional, glTF axes
  palette: {
    foliage: number;        // base foliage colour (linear RGB hex)
    foliageJitter: number;  // 0..1 hue/lightness variation applied by instance tint
    trunk: number;
  };
}
export const THEMES: Record<Theme, ThemeValues>;
export function createLightRig(theme: Theme): LightRig; // unchanged behaviour
```

- `ThreeCore.setTheme(theme)` updates every rig, stores the theme (`core.theme`), and calls
  `themeChanged?.(theme)` on every module registered with the core. Modules register when they
  are added: `ModuleLayer` registers its module with the core in `onAdd` and unregisters it in
  `onRemove`.
- `LayerModule` gains `themeChanged?(theme: Theme): void`.
- New export `setTheme(map, theme)`. It looks up the map's core and calls `core.setTheme`. If no
  core exists yet, it stores a pending theme that the core adopts when it is created.
- Every module layer takes an optional `theme` option, which calls `setTheme` on add, and has a
  `setTheme(theme)` method. The most recent call wins.
- **Breaking rename (pre-release):** landmarks `lighting` / `setLighting` / `LightingPreset` /
  `LIGHTING` become `theme` / `setTheme` / `Theme` / `THEMES`.
- `dusk` values sit between `dawn` and `night`: warm, low sun with a blue-violet sky.

## 3. Trees module (`src/trees/`)

```
TreesLayer.ts       public ModuleLayer subclass
TreesModule.ts      LayerModule: update → collect → select → write; frame → uTime; themeChanged
collect.ts          mapped tree points + per-polygon scatter (cache), Protomaps-schema queries
scatter.ts          seeded hash, jittered global grid, polygon area / point-in-polygon, fill rule
select.ts           nearest-N, LOD split, deterministic model/variant/scale/rotation/tint pick
batches.ts          InstancedMesh per (model × variant) + per-model impostor; anchor group
material.ts         shared themed + wind material (onBeforeCompile patch), uniforms
models/types.ts     TreeModel, TreeParts
models/procedural.ts  conifer, deciduous, birch, defaultImpostor
models/glb.ts       treeModelFromGLB
```

### 3.1 Public API

```ts
new TreesLayer({
  id: string,
  source: string,                               // vector or geojson source id
  sourceLayers?: { points?: string; polygons?: string }, // default { points: 'pois', polygons: 'landuse' }; '' = none (GeoJSON)
  models?: TreeModel[],                         // default [deciduous, conifer, birch]
  weights?: Record<string, number>,             // default { deciduous: .6, conifer: .2, birch: .2 }
  maxTrees?: number,                            // default 4000
  minZoom?: number,                             // default 16
  lodDistanceM?: number,                        // default 300
  scatter?: Record<string, number> | false,     // trees per m²; default { forest: 1/60, wood: 1/60, park: 1/400 }
  scatterSkipRatio?: number,                    // default 0.25 (skip if mapped ≥ 25% of target)
  wind?: { strength?: number; directionDeg?: number }, // default { strength: 1, directionDeg: 250 } (from)
  theme?: Theme,
  onError?: (err: unknown, ctx: { stage: 'source' | 'model'; id?: string }) => void,
})
layer.setWind({ strength?, directionDeg? })
layer.setTheme(theme)
layer.getStats(): { mapped; scattered; drawn; near; far; updateMs; polygonsFilled; polygonsSkipped } // numbers
```

Exports: `TreesLayer`, `conifer`, `deciduous`, `birch`, `treeModelFromGLB`, `setTheme`, and the
types `TreeModel`, `TreeParts`, `Theme`.

### 3.2 Model contract

```ts
interface TreeParts {
  trunk: BufferGeometry; foliage: BufferGeometry;  // metres, glTF axes, base at y = 0
  trunkTone?: number; foliageTone?: number;        // brightness multipliers on the theme palette (default 1)
}
interface TreeModel {
  id: string;
  variants?: number;                         // default 4
  build(seed: number): TreeParts | Promise<TreeParts>;
  impostor?(): TreeParts | Promise<TreeParts>; // default: defaultImpostor(bounds of variant 0)
}
```

- For each model, the plugin builds `variants` seeds. Each variant is merged into a single
  non-indexed `BufferGeometry` with these attributes:
  - `position` and `normal` (flat);
  - `aPart`, which is 0 for trunk and 1 for foliage;
  - `aShade`, a per-vertex value in 0.85–1.15 taken from a hash of the face, so faceted shading
    is preserved, multiplied by the part's tone. Tones keep species readable under any theme
    (birch: `trunkTone` 2.4, `foliageTone` 1.25; conifer: `foliageTone` 0.8);
  - `aHeight`, which is `position.y / variantHeight`.
- Procedural models are ported from the pen with the same seeded RNG (mulberry32) and the same
  shapes, but they return geometry only, no materials or colours. Triangle budget: at most 400
  per variant and at most 24 per impostor. To stay in budget, the procedural builders merge their
  primitives into the two parts. The pen's conifer cones keep 6–8 sides; deciduous and birch
  lobes are detail-0 icospheres.
- `defaultImpostor(height, radius, conical)`: a 6-sided cone (12 triangles, all foliage) when
  `model.id` contains "conifer"; otherwise an octahedron crown on an open 3-sided trunk
  (14 triangles).
- `treeModelFromGLB(url, { id?: string; foliage: string[]; trunk: string[]; fetch? })` (the id
  defaults to the file name without extension) loads the GLB with the shared `parseGlb` and merges meshes by material name into the two
  parts. Unnamed or unlisted materials count as foliage. The GLB is used as a single variant. If
  loading fails, the model is dropped, its weight is redistributed proportionally to the others,
  and the failure is reported through `onError({ stage: 'model', id })`.

### 3.3 Collect (`collect.ts`, `scatter.ts`)

- `collectMapped(map, source, layer)`: runs `querySourceFeatures` with
  `filter: ['==', ['get', 'kind'], 'tree']` and keeps Point geometries. Results are de-duplicated
  by feature id; a feature without an id is keyed by its rounded coordinates.
- `collectPolygons(map, source, layer, kinds)`: returns the Polygon and MultiPolygon pieces of
  `landuse` features whose `kind` is a key of `scatter`, grouped by feature id. Pieces without
  an id are skipped.
- **Scatter**, per polygon id and kind with density `d` (trees per m²):
  - The cell size is `1 / √d` metres on a global grid anchored at mercator (0, 0), converted to
    mercator units at the polygon's latitude rounded to the nearest degree, so every piece of a
    polygon uses the same grid. Polygons whose bbox exceeds 250,000 cells are not scattered.
  - Each grid cell `(i, j)` gets one candidate point: the cell origin plus a jitter of
    `hash(i, j, kindSalt)` in [0.1, 0.9]. The point is kept if it lies inside any piece of the
    polygon (holes respected). Points are keyed by `kind:i:j`, so overlap between tile buffers
    cannot produce duplicates.
  - **Fill rule:** target = Σ piece area × `d`. If the mapped trees inside the polygon's pieces
    reach `scatterSkipRatio × target` or more, the polygon is not scattered.
  - Results are cached per `kind:id` together with a piece-geometry hash, so they are recomputed
    when more pieces load. The cache is an LRU holding at most 512 polygons.

### 3.4 Select (`select.ts`)

- Candidates are mapped trees (`id`) and scatter points (`kind:i:j`). The distance to the view
  center is computed for each. The result is sorted, the nearest `maxTrees` are kept, and
  candidates further than `lodDistanceM` are marked far.
- Each tree is assigned, from `h = hash(key)`:
  - a model via the weights (cumulative distribution);
  - a variant (`hash2 % variants`);
  - a scale (`0.8 + 0.4 · hash3`);
  - a Y rotation (`2π · hash4`);
  - a tint (`hash5`).

  The same tree always looks the same.

### 3.5 Batches (`batches.ts`)

- One `InstancedMesh` per (model, variant) for near trees and one per model for far trees. Each
  has capacity `maxTrees` and `frustumCulled = false`; only the draw count changes.
- Per-instance attribute `aTint` is an `InstancedBufferAttribute(Float32Array(maxTrees), 1)`.
- Instance matrices are stored in metres relative to the **batch anchor**, which is the view
  center at update time. All batches live under one `anchor` Group. `place(origin)` sets the
  anchor's position to `localPosition(origin, anchor, 0)` once per frame. Terrain elevation is
  added per instance at update time when `map.getTerrain()` is set.
- Writes happen only in `update`. Wind and theme never rewrite instance data.

### 3.6 Material (`material.ts`)

- A single shared `MeshStandardMaterial({ flatShading: true, roughness: 0.9 })`, patched with
  `onBeforeCompile`. Its uniforms are `uTime`, `uWindDir` (vec2 in local XZ, pointing downwind),
  `uWindStrength`, `uFoliage`, `uFoliageJitter` and `uTrunk`. `customProgramCacheKey` returns
  `'trees-v1'`.
- **Colour:**
  `diffuseColor.rgb = mix(uTrunk, foliageTinted, aPart) * aShade`, where `foliageTinted` shifts
  `uFoliage` in lightness and hue by `(aTint - 0.5) * uFoliageJitter`.
- **Wind** (applied after `instanceMatrix`, in local metres):
  - `phase = dot(instanceOrigin.xz, vec2(0.13, 0.07))`;
  - `sway = (sin(uTime * 1.1 + phase) * 0.6 + sin(uTime * 2.3 + phase * 1.7) * 0.4) * uWindStrength`;
  - `bend = sway * 0.05 * aHeight * y`, where `y` is the vertex height in metres after the
    instance transform. The bend is 0 at the base and grows quadratically up the tree;
  - `pos.xz += uWindDir * (bend + 0.15 * uWindStrength * aHeight)`. The second term is a steady
    lean that is zero at the base.
  - Foliage only: `pos.xz += 0.05 * uWindStrength * sin(uTime * 6.0 + phase * 3.0 + position.y)`.
- `frame(t)` sets `uTime = t / 1000` and returns `strength > 0 && drawn > 0`.

### 3.7 Module lifecycle

- `onAdd`: build the variant geometries for every model. Async GLB models join the batches when
  they resolve, followed by a re-select. Create the batches, apply the current theme palette, and
  run the first `update`.
- `update(view)`: below `minZoom`, every draw count is set to 0. Otherwise collect, then select,
  then write, then `requestRepaint()`. The duration is recorded in `getStats().updateMs`. A
  missing source or source layer, or a `querySourceFeatures` throw, is reported once per layer
  instance through `onError({ stage: 'source' })` and produces zero trees.
- `themeChanged(theme)`: set the palette uniforms and `requestRepaint()`.
- `styleChanged(attached)`: nothing tied to the style. Trees read the source on the next `update`.
  When attached, the module calls `update` again after `style.load`.
- `sourcedata` events for `source` (debounced 200 ms) re-run `update(lastView)`, so trees appear
  when tiles finish loading rather than on the next pan.
- `onRemove`: dispose all geometries, the material and the batches, clear the caches, and stop
  listening.

## 4. Demo

- Add a **Theme** selector (day, dawn, dusk, night). day and dawn use the Protomaps `light`
  flavor; dusk and night use `dark`. The selector rebuilds the style with the new flavor, calls
  `map.setStyle(newStyle)` (diffed), and then `setTheme(map, theme)`. The extruded-buildings swap
  is re-applied to the new style.
- Add a `TreesLayer` with source `protomaps`, inserted before the first symbol layer and after
  the landmarks layer.
- Add a **Wind** slider (0–2) and a tree stats line (drawn, near, far, update ms).

## 5. Testing

**Unit tests (Vitest):**
- `scatter`:
  - deterministic;
  - independent of how the polygon is split into pieces (one polygon vs. the same polygon cut
    into two pieces gives an identical set);
  - density within ±15% on a 200 m square;
  - holes respected;
  - fill rule skips at and above the ratio and fills below it.
- `collect`: de-duplication by id, kind filtering, configurable source layers (GeoJSON source
  with no source layer).
- `select`: nearest-N, LOD split at the boundary, weighted pick distribution within ±5% over
  10,000 keys, stable per key.
- `procedural`: each model is deterministic per seed, produces valid non-empty parts with no NaN,
  stays within the triangle budgets, and has its base at y ≈ 0.
- `batches`: draw counts per batch, anchor placement, tint attribute written.
- `material`: the `onBeforeCompile` patch inserts the wind/colour chunks into the shader strings,
  and the uniforms are shared.
- `theme`:
  - `setTheme(map, …)` updates the rigs, calls `themeChanged` on the trees and landmarks modules,
    and applies a theme set before the core existed;
  - the renamed landmarks API works.
- `glb`: a tiny GLB fixture (two materials, `bark` and `leaves`) is split into parts; a failing
  URL drops the model and redistributes the weights.
- `TreesModule`: `frame()` returns false when there is no wind or no trees; the source error is
  reported once; stats are correct.

**Browser tests (Playwright, no key):** a GeoJSON source with about 30 tree points plus a
`park` polygon containing no mapped trees and a `forest` polygon full of mapped trees, under a
`theme` of `day`. Checks:
- green-dominant pixels near the tree points;
- the park is scattered and the full forest is not (from `getStats` and a pixel probe);
- with wind > 0, two frames 200 ms apart differ; with wind = 0, there is no further repaint;
- `setTheme(map, 'night')` darkens the sampled foliage pixel;
- no console errors.

**Measurement (demo, real data, Champ de Mars at z16.6 pitch 60):** report `updateMs` and the
average frame time over 3 s with wind on. Budget: `updateMs` < 30 ms on the development machine.
If the budget is missed, report it to the user rather than silently adding a worker.
