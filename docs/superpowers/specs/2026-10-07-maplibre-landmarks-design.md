# maplibre-landmarks — Design (v1: landmarks)

Date: 2026-10-07
Status: Draft for review

## 1. Goal

A public, open-source TypeScript plugin for MapLibre GL JS that renders the
[Open Landmarks](https://open-landmarks.benmaps.fr) 3D landmark models on a
Protomaps basemap. It is built around a shared 3D core so later modules
(procedural/animated trees with wind, 3D water) plug into the same renderer.

v1 ships the core and the landmarks module only.

### Decisions already made

- Basemap: Protomaps (`@protomaps/basemaps` styles and schema).
- The package is public (npm, MIT). It contains no Clair code and has no
  dependency on Clair's licence.
- Rendering: our own MapLibre `CustomLayerInterface` with Three.js drawing
  into MapLibre's WebGL context. We do not use a third-party bridge plugin or
  a separate overlay canvas.
- Data: the Open Landmarks public API (no key).

### Non-goals for v1

Trees, water, globe projection, picking, and custom landmark providers. The
interfaces below leave room for each of them.

## 2. Package

- Name: `maplibre-landmarks` (working name; check npm availability before
  publishing).
- ESM only, TypeScript strict mode, built with Vite library mode plus
  `vite-plugin-dts`.
- Peer dependencies: `maplibre-gl >=6.0.0`, `three >=0.170.0`. The versions
  current at design time are 6.13.0 and 0.186.1.
- Node 22 for development.

## 3. Architecture

```
src/
  core/
    ThreeCore.ts        one per map: THREE.WebGLRenderer on MapLibre's GL context, scene root, lights
    mercator.ts         lng/lat + metres → mercator model matrix; glTF axis remap
    LayerModule.ts      module contract
  landmarks/
    LandmarksLayer.ts   public CustomLayerInterface
    catalogue.ts        channel pointer → catalogue (pure, fetch injected)
    discovery.ts        view → padded z12 cells → wanted entries (pure)
    loader.ts           GLB fetch/decompress/parse, LRU cache, dispose
    residency.ts        wanted set → resident models; LOD swap; abort
    replacement.ts      basemap building suppression via `distance` filters
    attribution.ts      attribution strings for visible models
  index.ts
demo/
tests/
```

### 3.1 ThreeCore

- There is one instance per `maplibregl.Map`, held in a module-level
  `WeakMap<Map, ThreeCore>`. It is reference-counted by the modules attached
  to that map, and the last `onRemove` disposes it.
- It owns a `THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl })`
  with `autoClear = false`, a `THREE.Camera` whose `projectionMatrix` is set
  each frame, and the shared lights (a hemisphere light plus a directional
  "sun") with `day | dawn | night` presets.
- `render(module, mainMatrix)`:
  - computes a per-frame **origin** at the map center;
  - calls `module.place(origin)` so the module positions its objects in
    metres relative to that origin;
  - sets the camera projection to `mainMatrix × originMatrix`, computed in
    float64;
  - calls `renderer.resetState()`, renders the module's scene, then calls
    `renderer.resetState()` again so MapLibre's GL assumptions hold.

  Rebasing to the center keeps vertex coordinates small, which avoids
  float32 jitter at zoom 17 and above. (The MapLibre Babylon example warns
  about this jitter.)
- Each module gets its own `THREE.Scene` with its own light rig. Lights
  can't have two parents, so they aren't shared, but `setLighting` updates
  every scene.
- It requires WebGL2. If WebGL2 is missing, the core reports a single error
  and each module disables itself.

### 3.2 LayerModule contract

```ts
interface ModuleContext {
  map: maplibregl.Map;
  core: ThreeCore;
  scene: THREE.Scene;          // module's own scene (lights included)
  requestRepaint(): void;
}

interface ViewState { zoom: number; bounds: [w: number, s: number, e: number, n: number]; pitch: number; bearing: number; center: [lng: number, lat: number]; }

interface LayerModule {
  id: string;
  onAdd(ctx: ModuleContext): void;
  update(view: ViewState): void;        // after camera settles (debounced moveend)
  place(origin: Origin): void;          // position objects in metres relative to origin, every frame
  frame?(timeMs: number): boolean;      // per-frame animation; true = needs another frame
  onRemove(): void;
}
```

Each public layer class (e.g. `LandmarksLayer`) is a `CustomLayerInterface`
(`type: 'custom'`, `renderingMode: '3d'`) that wraps one `LayerModule` and
renders only that module's group. Because of this, each module can be placed
independently in the style's layer order (`beforeId`). The layer calls
`map.triggerRepaint()` only when `frame()` returns true or when content changes.

### 3.3 Mercator placement (`mercator.ts`)

- The scene uses glTF axes in metres (X east, Y up, Z south) relative to
  an `Origin { x, y, z, scale }`, where `x`, `y`, `z` are mercator units and
  `scale` is mercator units per metre.
  - `localPosition(origin, anchor, elevationM)` → `[x, y, z]` in metres.
  - `cameraMatrix(mainMatrix, origin)` = `mainMatrix × M`, where `M` maps
    local `(x, y, z)` to mercator `(ox + x·s, oy + z·s, oz + y·s)`. This
    swaps glTF's Y-up/Z-south into mercator's z-up/y-south.
- The axis swap has determinant −1 in coordinate terms. This is correct and
  intended, because mercator (east, south, up) is physically left-handed
  while glTF (east, up, south) is right-handed, so the swap preserves real
  geometry. No mirror is added. A unit test asserts the axis directions
  (east → +x, south → +y, up → +z). If face culling looks inverted in the
  browser test, fix it with `renderer`/material face-side settings, never
  by mirroring geometry. Current models are `doubleSided: true`, so this
  is low-risk.
- Heading is baked into the GLBs and is never applied.
- Terrain: in `place()`, which runs every frame for at most `maxResident`
  models, if `map.getTerrain()` is set, the anchor elevation is
  `map.queryTerrainElevation(anchor) ?? 0`. Otherwise it is 0.

## 4. Landmarks module

### 4.1 Public API

```ts
new LandmarksLayer({
  id: string,
  channel?: 'latest' | 'preview',          // default 'latest'
  catalogueUrl?: string,                   // pinned catalogue; overrides channel
  baseUrl?: string,                        // default 'https://open-landmarks.benmaps.fr'
  replaceBuildings?: string[],             // basemap layer ids to suppress; default []
  replacementInsetM?: number,              // default 1.5
  maxResident?: number,                    // default 8
  maxCached?: number,                      // default 12
  maxCacheBytes?: number,                  // default 32 * 1024 * 1024
  lighting?: 'day' | 'dawn' | 'night',     // default 'day'
  fetch?: typeof fetch,                    // injectable for tests
  onError?: (err: unknown, ctx: { stage: 'catalogue' | 'cell' | 'model'; id?: string }) => void,
  onModelsChanged?: (visible: LandmarkInfo[]) => void,
})

layer.setLighting(preset)
layer.getVisibleModels(): LandmarkInfo[]
layer.getAttribution(): string
```

`LandmarkInfo` is `{ id, revision, name?, anchor, lod: 'low' | 'detail', attribution }`.

### 4.2 Catalogue (`catalogue.ts`)

- `resolveCatalogue(opts)` works as follows. With `catalogueUrl`, it fetches
  that URL directly. Otherwise it fetches `${baseUrl}/api/v1/${channel}.json`,
  reads `catalogue`, and fetches it.
- A `null` release or catalogue returns `null`, and the module then stays
  inert without reporting an error.
- It parses `bounds`, `maxHeightM`, `index.zoom` (expected to be 12; any
  other value is used as given), `index.template`, `index.occupied`
  (converted to a `Set<string>`), and `attribution`.
- All relative URLs are resolved against `baseUrl`.
- Cell responses have the shape `{ schemaVersion, release, assets: Entry[] }`.
  Each entry carries `id`, `revision`, `name`, `anchor`, `minZoom`,
  `detailZoom`, `bounds` ([w, s, e, n] in lng/lat), `lods.{low,detail}` (each
  `{ url, bytes, gzip?: { url, bytes } }`), `replacementFootprint` (a GeoJSON
  Polygon or MultiPolygon, or null) and `attribution`. Unknown fields are
  ignored.
- Each GLB carries its own colours (`baseColorFactor`). The catalogue's
  `materialLibrary` is ignored in v1.
- At design time `latest` has 24 approved models and `preview` has 71.

### 4.3 Discovery (`discovery.ts`)

These are pure functions with fetch injected.

1. `cellsForView(view, catalogue)`: takes the view bounds and pads them by
   `padM = min(5000, 200 + maxHeightM · tan(min(pitch, 85°)))` metres. If
   the padded view misses `catalogue.bounds` entirely, it returns `[]`.
   Otherwise it enumerates the z12 XYZ cells (handling the antimeridian, with
   x wrapped mod 2^z) and intersects the result with `occupied`.
2. Cell JSON is fetched through an in-memory cache keyed by `x/y`. 404
   responses are cached as empty.
3. Entries are merged and deduplicated by `id + revision`.
4. Entries are kept when `zoom >= entry.minZoom` and `entry.bounds`
   intersects the padded bounds.
5. Entries are sorted by great-circle distance from the center and cut to
   `maxResident`.
6. The wanted LOD is `detail` when `zoom >= detailZoom`, else `low`.
7. If `zoom < 14` (`DISCOVERY_MIN_ZOOM`), discovery short-circuits: no
   fetches happen and the wanted set is empty.

Discovery runs on add and on `moveend` (debounced 150 ms). A run superseded
by a newer one is aborted.

### 4.4 Loader (`loader.ts`)

- It fetches `lods[lod].gzip.url` and decompresses it with
  `DecompressionStream('gzip')`. If that API is missing or the request fails,
  it fetches `lods[lod].url` (the raw GLB).
- It parses with `GLTFLoader.parseAsync`. No Draco or Meshopt decoder is
  registered.
- Resident models are the wanted set. Loads that are in flight for entries no
  longer wanted are aborted.
- LOD swap: the current mesh stays in the scene until the replacement has
  parsed. The two are then swapped within one frame.
- LRU cache of parsed scenes for non-resident models, bounded by `maxCached`
  and `maxCacheBytes` (sized from the GLB byte length). Eviction calls
  `dispose()` on geometries and materials.
- Material base colours are preserved. Only light intensities come from the
  preset.

### 4.5 Building replacement (`replacement.ts`)

Revised 2026-10-07 after measuring. Filter-based replacement (`setFilter` with `distance`) made
MapLibre re-parse every tile of the whole basemap source on each model-set change (2–4× tile
re-parses, +2–3 s per pan). Replacement now uses **feature-state**, as Clair does:

- Hidden set = the entry's `basemapReplacement.featureIds` (ids Open Landmarks computed for a
  Protomaps snapshot; OSM-derived and stable across builds) ∪ basemap building features whose ring
  centre falls inside the inset footprint (`replacementFootprint`, or `bounds` as a fallback; outer
  rings inset by `replacementInsetM`, holes grown by it).
- Flagged features get `setFeatureState({source, sourceLayer, id}, {'landmarks:hidden': true})`,
  which is a repaint only. Features without an id cannot be hidden.
- The paint of each `replaceBuildings` layer is wrapped once (`fill` → `fill-opacity`;
  `fill-extrusion` → `fill-extrusion-height` and `-base`, because `fill-extrusion-opacity` does not
  support feature-state) as `['case', ['boolean', ['feature-state', 'landmarks:hidden'], false], 0,
  original]`. This costs one re-parse when the layer is added; the original paint is restored on
  remove.
- When new tiles of the target source load (`sourcedata`, debounced 100 ms), the set is re-scanned.
- After a style swap, `styleChanged` forgets the wrapped paint and hidden set and re-applies them if
  the layer is still attached.

### 4.6 Errors

- Every failure goes to `onError(err, ctx)`. The default is `console.warn`.
- A failed model is skipped for the current discovery run and retried on the
  next one. One bad model never affects the others.
- AbortErrors are swallowed.

### 4.7 Attribution

`getAttribution()` returns the unique attributions of the visible models plus
the catalogue attribution, "© OpenStreetMap contributors" and a link to the
Open Landmarks licences page. If the map has an `AttributionControl`, the
layer adds this text through the style source attribution mechanism. It
registers an empty GeoJSON source carrying the `attribution` text, plus an
invisible `fill` layer so that MapLibre counts the source as used. Both are
re-created only when the text changes, and removed on `onRemove`.

## 5. Future modules (shape only, not built in v1)

- **Trees:** a `TreeSource` interface with two implementations:
  - `PoiTreeSource` reads `pois` points with `kind=tree` or `natural=tree`.
  - `PolygonScatterSource` reads Protomaps `landuse`/`natural` polygons (wood,
    forest, park, …) and places deterministic seeded random points per
    feature, keyed by a feature id or geometry hash, so they are stable
    across pans.

  Rendering uses one `InstancedMesh` per tree species. Wind is a vertex shader
  injected via `onBeforeCompile`, with a sway amplitude proportional to local
  height and driven by `uTime`, `uWindDir` and `uWindStrength` plus a
  per-instance phase attribute. `frame()` returns true only while trees are
  visible and wind is non-zero.
- **Water:** a module over the Protomaps `water` polygons with an animated
  surface material.
- **Landmark providers:** extract the catalogue and discovery logic behind a
  `LandmarkProvider` interface so that self-hosted GLB sets can be added.

## 6. Testing

- **Unit tests** (Vitest, Node) cover:
  - catalogue resolution, including the null release and pinned URLs;
  - cell enumeration, including edges and the antimeridian;
  - padding, occupied filtering, deduplication, minZoom, distance sort and
    the `maxResident` cap;
  - the mercator matrix: axis directions and metre scale;
  - the loader: gzip with raw fallback, abort, LRU eviction calling dispose,
    and keeping the old LOD until the new one is ready;
  - replacement filter composition and restoration.

  Fixtures recorded from the live API (one catalogue, one cell, one small
  GLB) make the tests run offline and deterministically.
- **Browser test** (Playwright) opens the demo at the Eiffel Tower at z17 and
  checks:
  - `onModelsChanged` reports at least one model;
  - there are non-background pixels near the anchor;
  - there are no console errors;
  - removing the layer restores the building filter.

## 7. Demo

`demo/` is a Vite page with:

- a Protomaps basemap (`@protomaps/basemaps` `layers('protomaps',
  namedFlavor('light'), { lang: 'en' })`). Tiles come from
  `VITE_PROTOMAPS_KEY` (`https://api.protomaps.com/tiles/v4.json?key=…`, a
  free key) or `VITE_PMTILES_URL` (your own `.pmtiles`, via the `pmtiles`
  protocol). There is no keyless public tile URL; the demo shows a message
  if neither variable is set.
- `LandmarksLayer` inserted before the first symbol layer;
- a panel with a channel toggle (latest or preview), a lighting preset, a
  terrain toggle and a list of loaded models with attributions.

The demo defaults to `latest`, which has 24 approved models. The
`preview` channel can be selected in the panel.

## 8. Tooling and docs

- `npm run dev | build | test | test:browser | lint`.
- ESLint and Prettier.
- MIT licence.
- The README covers the API, the data licences (models CC BY 4.0, spatial
  data ODbL 1.0) and the attribution obligations.
