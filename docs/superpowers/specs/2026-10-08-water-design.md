# maplibre-landmarks: Animated Water Design

Date: 2026-10-08
Status: Draft for review
Builds on: `2026-10-07-maplibre-landmarks-design.md` (core, modules, theme)
Branch: `feat/water` (worktree `/Users/majid/maplibre-landmarks-water`, from `main` 228dcce)

## 1. Goal

A `WaterLayer` that draws the basemap's water as animated, lit 3D water: waves with sky
reflection and sun glints, rivers and canals flowing downstream, calmer lakes, a swelling sea,
bright pools, foam and lighter shallows along shorelines. It follows the theme and terrain.

### Decisions made

- **Look: stylised animated water (option A).** Reflections of 3D content (option B) are a later,
  separate run, with a performance comparison first.
- **Technique: our own three.js water surface** drawn by a custom layer placed right above
  MapLibre's water fill, so roads, bridges and labels still draw on top. Rejected: animated
  fill patterns (tiled, flat, no light or flow); a screen-space effect (a custom layer cannot read
  what MapLibre drew).
- **Terrain: yes.** Lakes, sea and pools are flat at their lowest shoreline elevation; rivers and
  canals follow the ground per vertex.
- **No paint changes, nothing hidden:** the layer only draws over MapLibre's water.

### Data facts (Protomaps build 20261008)

`water` source layer:

| Geometry | `kind`                                | `kind_detail` / notes                           |
| -------- | ------------------------------------- | ----------------------------------------------- |
| Polygon  | `water`, `ocean`, `swimming_pool`     | `lake`, `river`, `basin`, `canal`               |
| Line     | `river`, `canal` (streams, ditches)   | Drawn in OSM flow direction                     |
| Point    | `fountain`, `water`                   | Fountains and water-name label points           |

No depth, width or speed attributes.

### Non-goals

- Reflections of buildings or 3D models (option B, later run).
- Refraction of the riverbed, caustics, boat wakes, real tides.
- Water lines (streams) as 3D water; they stay MapLibre lines.

## 2. Public API

```ts
import { WaterLayer } from 'maplibre-landmarks';

map.addLayer(
  new WaterLayer({
    id: 'water',
    source: 'protomaps', // vector source with a water layer
    sourceLayer: 'water',
    minZoom: 12,
    waves: 1, // wave strength multiplier (0 = still)
    maxTriangles: 300_000, // nearest water first beyond this
    colors: {}, // optional per-style CSS overrides: { sea, lake, river, pool }
    onError: console.warn,
  }),
  waterFillLayerId, // insert right after MapLibre's water fill (before roads)
);
water.setWaves(0.5);
```

## 3. Components (`src/water/`)

### 3.1 Styles (`styles.ts`)

`waterStyle(properties)` → `'sea' | 'lake' | 'river' | 'pool' | null`:

- `kind: ocean` → `sea`
- `kind: swimming_pool`, `kind_detail: basin`, `kind: fountain` (polygons) → `pool`
- `kind_detail: river | canal` → `river`
- other water polygons (`lake`, reservoirs, unknown) → `lake`
- non-polygons → `null`

Per style (theme-independent shape, theme-tinted colour): wave scale (sea 40 m, lake 12 m,
river 8 m, pool 1.5 m), amplitude (sea 1, lake 0.45, river 0.6, pool 0.25), speed and colours
(deep / shallow) with defaults per theme; `colors` overrides the shallow/base colour.

### 3.2 Geometry (`geometry.ts`, pure)

- For each water polygon (local metres around its own centroid, as the roofs do):
  - triangulate it (three's `ShapeUtils.triangulateShape`, holes included);
  - add a **shore band**: an inset ring 6 m inside each ring (outer shrinks, holes grow; clamped
    for small polygons) stitched to the original ring. Vertex attribute `shore` is 1 on the
    shoreline and 0 from the inset ring inwards.
- Per vertex attributes: position, `shore`, `style` (0..3), `flow` (vec2, see 3.3).
- Tile pieces are not merged: water is drawn opaque, so overlaps in tile buffers do not show.
- Small polygons (area < 4 m²) and degenerate rings are skipped.

### 3.3 Flow (`flow.ts`, pure)

- River and canal **lines** from the same layer give segments (in flow direction).
- Each vertex of a `river` polygon gets the unit direction of the nearest segment (grid index,
  search radius 300 m); none found → `(0, 0)` (still water).

### 3.4 Heights

- **Flat maps:** y = 0.
- **Terrain:** `lake`, `sea`, `pool` polygons: y = lowest terrain elevation sampled at their
  shoreline vertices (up to 64 samples); `river`: y per vertex from the terrain. Both + 0.3 m to
  avoid flicker against the draped fill. Refreshed when the camera settles and when terrain tiles
  arrive (as the roofs do).

### 3.5 Shader (`shaders.ts`)

- **Normals:** sum of 4 directional sine waves (per-style scale, rotated) plus 2 octaves of
  world-anchored value noise; river waves are scrolled along `flow` (2 m/s scaled by style speed).
  Anchoring as the fog (equator-metre noise frame, wrapped period) so patterns do not slide.
- **Colour:** mix(deep, shallow, shore) per style; foam where `shore` > 0.85 modulated by noise;
  Fresnel (Schlick, F0 0.02) mix toward the theme sky colour; sun specular (Blinn-Phong, exponent
  per style) in the theme sun colour; output through three's colour space conversion.
- Opaque, depth-tested, depth-writing (water is the ground).

### 3.6 `WaterModule` / `WaterLayer`

- `LayerModule` on the shared core, like the roofs: rebuild from `querySourceFeatures` on
  `update` and on `sourcedata` for its source (150 ms debounce); per-tile-piece geometry cached
  by a signature; pieces nearest the map centre first, capped at `maxTriangles`
  (default 300 000).
- One merged `BufferGeometry` positioned relative to an anchor (float precision, as the roofs).
- `frame()` advances time and keeps animating while visible and `waves > 0`.
- `themeChanged` updates sky, sun and water colours; `setWaves(n)`.
- `onRemove` disposes geometry and material and removes listeners.
- `WaterLayer` extends `ModuleLayer` (`minZoom` default 12).

### 3.7 Demo

A **Water** checkbox (on by default); the Paris (Seine) and Chamonix (Arve, lakes) presets
show it. Inserted after the Protomaps water fill layer.

## 4. Error handling

| Situation                             | Behaviour                                       |
| ------------------------------------- | ----------------------------------------------- |
| Source or source layer missing        | Reported once; module idles until present       |
| Geometry failure for one piece        | Piece skipped; reported once                    |
| Triangle budget exceeded              | Farthest pieces dropped (nearest kept)          |
| No terrain data yet                   | y = 0 until DEM tiles arrive, then refreshed    |
| Style swap / removal                  | Same lifecycle as other modules                 |

## 5. Testing

- **Unit:** `waterStyle` mapping; shore band (inset ring, attribute values, holes, tiny polygons);
  triangulated area equals polygon area; nearest-flow assignment; lake flat height vs river
  per-vertex heights; module rebuild on `sourcedata`, triangle budget, theme and `setWaves`
  uniforms, removal.
- **Browser:** the shader compiles (no WebGL errors); pixels over the Seine change between two
  frames (animation); removing the layer leaves no errors.

## Plan-time revisions (2026-10-08)

- **Shore band as ribbons (replaces the stitched inset ring of 3.2).** An inset copy of a whole
  ring self-intersects on concave shorelines and breaks triangulation. Instead the body is the
  triangulated polygon (opaque, `shore` 0) and each real shoreline edge gets its own quad ribbon,
  6 m wide (at most 0.2·√area for small polygons), `shore` 1 at the edge and 0 inward, drawn
  blended over the body with alpha = `shore`. Overlaps at concave corners only tint slightly.
- **Tile cuts are not shorelines.** Vector tiles clip big water polygons into pieces. An
  axis-aligned edge whose point 0.5 m outward lies inside another water piece is a cut (or a join
  with another water body) and gets no ribbon or foam.
- **No depth writing (replaces "depth-writing" in 3.5).** With terrain, MapLibre drapes the layers
  after ours (roads, bridges) at ground depth; water written 0.3 m above the ground would hide
  them. The water depth-tests against the ground but does not write depth.
- **Flat water clears the ground it covers (replaces "lowest shoreline elevation" in 3.4).** The
  DEM dips below the water surface along shores (Lake Annecy: shore samples 438 m, lake surface
  447 m), which buried the water under the draped ground. Each piece samples the ground at up
  to 64 triangle centres inside it and takes the upper quartile. Pieces linked across a tile cut
  (the cut test finds the piece on the other side) with identical properties form one water body
  at the highest of their levels, so tile seams show no steps. Touching bounds are not enough:
  unnamed lakes all share their properties, and bounds-grouping lifted Lake Annecy to a
  mountain lake's level.
- **Depth bias along the line of sight.** MapLibre's terrain mesh can sit above
  `queryTerrainElevation`; the vertex shader moves each water vertex toward the camera by
  3 m + 2% of its distance (same pixel, nearer depth), so flat water is not buried by that error
  while ridges in front still hide it.
