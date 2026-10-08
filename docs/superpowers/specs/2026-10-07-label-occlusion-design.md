# maplibre-landmarks: Label Occlusion Design

Date: 2026-10-07
Status: Draft for review
Builds on: `2026-10-07-maplibre-landmarks-design.md` (core, landmarks, building replacement)

## 1. Goal

Basemap point labels (shops, restaurants, building names) currently draw through 3D landmarks
and extruded buildings. Add an opt-in `LabelOcclusion` layer that fades out labels hidden behind
3D content and keeps labels in front visible. A landmark never hides its own label, and labels
do not flicker while the camera moves.

### Decisions made

- **Which labels.** Point-placed symbol layers whose source layer is `pois`, `poi`,
  `buildings` or `building` (Protomaps and OpenMapTiles names). A `labelLayers` option replaces
  this auto-detection. Line labels (streets) and place/area names are never touched.
- **Packaging.** A standalone class the app adds with `map.addLayer`. It works without landmarks
  and is off unless added, because it changes label behaviour across the whole basemap.
- **Occluders.** Everything 3D already drawn into the depth buffer: landmark models, basemap
  `fill-extrusion` buildings and terrain. Limiting it to landmarks only would need a separate
  depth pass of our models, which is out of scope.
- **Technique.** WebGL2 occlusion queries (`ANY_SAMPLES_PASSED_CONSERVATIVE`), as in Clair.
  CPU ray casting was rejected as slow on detailed models and only approximate for extrusions
  and terrain. Reading back MapLibre's default depth buffer is not possible in WebGL.

### Non-goals

- Line labels, place labels, and labels of other symbol placements.
- Partial occlusion (a label half behind a building is decided by one probe point).
- WebGL1 support (MapLibre 5+ always uses WebGL2; without it the layer is a no-op).

## 2. Public API

```ts
import { LabelOcclusion } from 'maplibre-landmarks';

const occlusion = new LabelOcclusion({
  id: 'label-occlusion', // default
  labelLayers: undefined, // default: auto-detect (section 1)
  minZoom: 15, // below this every label is shown
  fadeMs: 180, // fade duration; 0 = instant
  maxLabels: 256, // labels probed at once, nearest to the screen centre first
  onError: console.warn, // shader or GL setup failures
});
map.addLayer(occlusion);
occlusion.refresh(); // force a re-scan (e.g. after the app changes label layers)
map.removeLayer(occlusion.id); // restores the original paint and clears all state
```

`LabelOcclusion` implements MapLibre's `CustomLayerInterface`. Where it is added does not matter:
it moves itself (section 3.1).

## 3. Components

All new code lives in `src/labels/`. Each unit is testable without a real GL context.

### 3.1 `LabelOcclusion` (the custom layer)

- `type: 'custom'`, `renderingMode: '3d'`.
- **Placement.** On add, and on every `styledata`, it ensures it sits after the last 3D layer
  (any `custom` 3D layer or `fill-extrusion`) and before the first `symbol` layer, using
  `map.moveLayer`. A re-entrancy guard prevents loops from its own move. Only after the 3D
  layers is the depth buffer complete when it probes.
- **Lifecycle.** `onAdd` registers it in a per-map registry (section 3.6), wraps label opacity
  (3.4) and subscribes to `move`, `moveend`, `idle`, `sourcedata`, `terrain`, `styledata`,
  `webglcontextlost` and `webglcontextrestored`. `onRemove` unsubscribes, deletes GL objects,
  restores paint and removes all feature-state it set.
- **Style swaps.** As with `ModuleLayer`, `setStyle` does not call `onRemove`; on `style.load`
  it re-wraps paint if the layer is still in the style, or tears down if it is gone.
- **Render.** In `render(gl, args)`: skip if below `minZoom`, if
  `args.defaultProjectionData.projectionTransition > 0`, or if `gl` is not a
  `WebGL2RenderingContext` or the context is lost. Otherwise hand the probes and
  `args.defaultProjectionData.mainMatrix` to the `OcclusionProbe` (3.3).

### 3.2 Label candidates (`candidates.ts`)

Pure functions, given a small map-like interface.

- `labelLayerIds(style, override?)`: the override filtered to layers that exist, or the
  auto-detected list from section 1 (symbol layers with `symbol-placement` absent or `point`).
- `collectCandidates(map, layerIds, maxLabels)`: `queryRenderedFeatures({ layers })`, keep Point
  features with an id, de-duplicate by `source/sourceLayer/id`, sort by screen distance from the
  centre and cap at `maxLabels`.
- **Probe height.** Each candidate gets `elevation = terrain(lngLat) + roof + 2.5 m`. `roof` is
  the height of an extruded building whose footprint contains the label, found with
  `queryRenderedFeatures(map.project(lngLat), { layers: <fill-extrusion layers> })` and a
  point-in-polygon test. The height comes from the feature's `render_height` or `height`
  property (falling back to `min_height` + 9 m, then 0). Results are cached by label key until the
  label moves or terrain changes; at most 48 new roof lookups run per scan.
- **Exemptions.** Candidates inside any exempt footprint (3.6) are marked exempt: never probed,
  always shown.
- **Scheduling.** Re-scan 250 ms after the last scan during `move`, 60 ms after `moveend`, on
  `idle` when something changed, 150 ms after `sourcedata` with content, and 100 ms after a
  `terrain` change (which also clears the roof cache). Labels no longer found are shown and
  dropped.

### 3.3 GPU probe (`OcclusionProbe.ts`)

Owns the GL resources for one context: a program, a VAO, a vertex buffer and a pool of query
objects.

- **Shaders.** The vertex shader positions `a_pos` with `u_matrix` and sets `gl_PointSize`
  (4 CSS px × devicePixelRatio). The fragment shader writes nothing visible.
- **Precision.** Positions are uploaded in mercator units relative to the first candidate and
  the translation is folded into the matrix in float64, so probes stay exact at high zoom.
- **Draw.** For each non-exempt candidate with no query in flight whose position changed or
  whose last answer has arrived, draw one point inside
  `beginQuery(ANY_SAMPLES_PASSED_CONSERVATIVE)` / `endQuery`. Colour writes and depth writes are
  off; depth test is on with `LEQUAL`. The previous program, VAO, buffer binding, colour mask,
  depth mask, depth test and depth func are saved before and restored after.
- **Results.** A `requestAnimationFrame` loop polls in-flight queries with
  `QUERY_RESULT_AVAILABLE`, reads `QUERY_RESULT` only when available and returns the query to
  the pool. A result for an out-of-date position is discarded and the label re-probed.
  Re-probing every frame keeps visibility current while panning.
- **Context loss.** Drop all GL handles and in-flight queries (their results are lost) and show
  every label. Rebuild lazily on the next render after `webglcontextrestored`.

### 3.4 Label opacity (`src/core/expressions.ts`)

- Move `scaleBy` (zoom-curve-safe multiplication) from `landmarks/replacement.ts` into a shared
  `src/core/expressions.ts`; building replacement keeps using it.
- For each label layer, `text-opacity` and `icon-opacity` become
  `scaleBy(original ?? 1, ['coalesce', ['feature-state', 'landmarks:label'], 1])`. Legacy
  function objects cannot be wrapped: that layer/property is skipped with a warning. Originals
  are kept and restored on removal.

### 3.5 Fades

Each label's visibility (1 shown, 0 hidden) is animated with the existing `Tweens` helper
(`landmarks/fade.ts`) over `fadeMs`. It is written with `setFeatureState` only when its value
changes. The fade loop runs only while something is animating.

### 3.6 Working with landmarks

- A per-map exemption registry (`src/labels/exemptions.ts`, `WeakMap`-based like
  `acquireCore`). Owners register a provider, `setExemptionSource(map, owner, () => polygons)`,
  and call `notifyExemptionsChanged(map)` when their set changes. `LabelOcclusion` pulls
  `exemptionsFor(map)` on every scan and re-scans on notification. Pulling means either layer
  may be added first and nothing is missed.
- `LandmarksModule` registers on add and unregisters on remove. Its provider returns the
  footprints (`footprintOf(entry, 0)`) of landmarks whose building hand-over is in progress or
  done, and it notifies when that set changes.

## 4. Error handling

| Situation                         | Behaviour                                                 |
| --------------------------------- | --------------------------------------------------------- |
| No WebGL2                         | No-op; labels unchanged                                   |
| Shader compile/link failure       | Reported through `onError` (default `console.warn`); no-op |
| Context lost                      | All labels shown; rebuild after restore                   |
| Label layer missing or legacy fn  | Skipped (warning for legacy functions)                    |
| Below `minZoom`, globe transition | All labels shown, no probing                              |
| `remove` / layer dropped by style | Paint restored, feature-state cleared, GL objects deleted |

## 5. Testing

- **Unit (vitest, node).**
  - `labelLayerIds`: auto-detection (Protomaps and OpenMapTiles names, line placement excluded)
    and override filtering.
  - `scaleBy` after the move, and the `text-opacity`/`icon-opacity` wrap and restore.
  - Candidates: de-duplication, cap, roof lookup with point-in-polygon, roof cache, exemptions.
  - `OcclusionProbe` against a fake WebGL2 context: queries issued once per candidate, results
    read only when available, stale results discarded, query reuse, GL state restored, context
    loss.
  - Fades: feature-state written only on change; the fade loop stops when settled.
  - Landmarks integration: exemptions set when a landmark shows and cleared when it leaves.
- **Browser (Playwright, swiftshader).** The e2e page gains a symbol layer with two label points,
  one behind the landmark (from the camera) and one in front. With `LabelOcclusion` added, the
  label behind reaches visibility 0 and the one in front stays 1. Removing the layer restores
  the paint and clears the state.
