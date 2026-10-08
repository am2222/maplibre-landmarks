# maplibre-landmarks: Roof Shapes Design

Date: 2026-10-08
Status: Draft for review
Builds on: `2026-10-07-maplibre-landmarks-design.md` (core, building replacement),
`2026-10-07-label-occlusion-design.md` (exemption registry, label occlusion)

## 1. Goal

Draw real roof shapes (gabled, hipped, pyramidal, dome, …) on basemap buildings whose data says
what their roof is, on top of MapLibre's `fill-extrusion` walls. Any app can use it with any
vector source that follows a published attribute schema; a hosted tileset can come later as one
producer of that schema.

### Decisions made

- **Who it is for.** A library feature: the renderer plus a standard attribute schema any source
  can follow ("bring your own data"). We document a build recipe; hosting a tileset is a later,
  separate step.
- **Schema.** Overture Maps' building schema names (`roof_shape`, `roof_height`, …). Other
  sources map their names with a `fields` option.
- **Rendering.** Hybrid: MapLibre keeps drawing walls with `fill-extrusion`; a three.js
  `RoofsModule` on the shared core draws only non-flat roofs. Walls of roofed buildings are
  shortened by the roof height.
- **Untagged buildings stay flat.** No guessed roofs.
- **Split footprints.** Vector tiles cut buildings at tile edges; the module merges the pieces
  of each building (by feature id) back into one footprint before generating its roof.
- **Geometry.** Port OSMBuildings' roof generators (BSD-2-Clause, Copyright (c) 2018 Jan
  Marsch, OSM Buildings), with attribution in `LICENSE` and the README.

### Data facts (Paris, OSM via Overpass, 2026-10-08)

| Set                                   | Count   | Share                     |
| ------------------------------------- | ------- | ------------------------- |
| Buildings                             | 119,232 |                           |
| … with `roof:shape`                   | 4,080   | 3.4% (2,670 non-flat)     |
| Building parts                        | 7,111   |                           |
| … with `roof:shape`                   | 2,852   | 40% (2,467 non-flat)      |
| Tagged items with roof height/levels  | 4,138   | 61% of 6,798 tagged       |
| Tagged items with direction/orient.   | 887     | 13% of 6,798 tagged       |

Non-flat shapes by frequency: gabled 1,163; skillion 814; gambrel 653; hipped 600;
double_saltbox 336; pyramidal 319; mansard 302; round 189; dome 168; many 132;
quadruple_saltbox 122; saltbox 59; cone 49; side_hipped 45; half-hipped 18; onion 7; rarer
others under 10 each.

Consequences: building **parts** carry most of the detail and must be first-class input;
39% of tagged roofs have no height, so a default is needed; Overture's `roof_shape` enumeration
(to be confirmed in the plan's first task) lacks the saltbox variants common in Paris, so OSM
values outside it are accepted too.

### Non-goals

- Guessing roofs for untagged buildings.
- Drawing walls ourselves (windows, facade textures). The roof generator stays independent of
  who draws walls, so this remains possible later.
- Hosting a tileset. The recipe (section 9) is the only data deliverable.
- Roof shapes beyond section 3's list (e.g. `many`, `apse_gabled`); they stay flat.

## 2. Public API

```ts
import { RoofsLayer } from 'maplibre-landmarks';

map.addLayer(
  new RoofsLayer({
    id: 'roofs',
    source: 'buildings', // vector source with the schema's attributes and feature ids
    sourceLayer: 'building', // its building (and building part) layer
    extrusionLayer: 'buildings-3d', // the app's fill-extrusion layer drawing the walls
    fields: {}, // optional: { roof_shape: 'roof:shape', ... } for differently named sources
    minZoom: 15,
    maxBuildings: 2000, // nearest roofed buildings drawn at once
    wallColors: false, // true: colour walls from facade_color / facade_material
    onError: console.warn,
  }),
);
```

`RoofsLayer` is a `ModuleLayer` (the existing core adapter) wrapping a `RoofsModule`, like
`LandmarksLayer`. `map.removeLayer('roofs')` restores the extrusion layer's paint.

## 3. Attribute schema

Names follow Overture's building schema. Units are metres and degrees.

| Field             | Meaning                                                                     |
| ----------------- | --------------------------------------------------------------------------- |
| `height`          | Top of the building including its roof (OSM/Overture semantics)             |
| `min_height`      | Bottom of the part (for parts raised off the ground)                        |
| `roof_shape`      | Shape name (below)                                                          |
| `roof_height`     | Height of the roof alone                                                    |
| `roof_direction`  | Compass bearing the roof faces (OSM `roof:direction` semantics)             |
| `roof_orientation`| `along` / `across`: ridge parallel / perpendicular to the longest side      |
| `roof_color`      | CSS colour                                                                  |
| `roof_material`   | Material name (colour table, section 5)                                     |
| `facade_color`    | CSS colour (walls, only with `wallColors`)                                  |
| `facade_material` | Material name (walls, only with `wallColors`)                               |

**Feature ids are required** (numeric ids in the tiles, or `promoteId` on the source). Features
without an id get no roof; one warning is reported per source.

**Shape values.** Lower-cased, `-` read as `_`. Drawn shapes: `gabled`, `hipped`, `half_hipped`,
`pyramidal`, `cone`, `dome`, `onion`, `round`, `skillion`, `gambrel`, `mansard`. Mapped:
`saltbox` → `gabled`; `double_saltbox`, `quadruple_saltbox` → `mansard`; `side_hipped` →
`hipped`; `pyramid` → `pyramidal`. Anything else, including `flat`, is flat (no roof drawn,
walls untouched).

**Roof height default** when `roof_height` is missing or not positive:

- pitched shapes (`gabled`, `hipped`, `half_hipped`, `skillion`, `gambrel`, `mansard`,
  `pyramidal`, `cone`): half the footprint's shorter oriented side × tan 30°;
- `dome`, `onion`, `round`: the footprint's radius (half the shorter side);
- always capped at half of `height − min_height`, and at least 0.5 m; a roof that cannot fit
  is skipped (flat).

## 4. Footprints

- On add and when the camera settles (the `ModuleLayer` debounce), read
  `querySourceFeatures(source, { sourceLayer })`. Keep Polygon/MultiPolygon features with an id
  and a drawn shape (after `fields` mapping and normalisation).
- Group pieces by id and union them with `polygon-clipping` (new dependency, MIT). Tile pieces
  overlap in the tile buffer, so the union closes the seams.
- Cache merged footprints per id together with a signature of the pieces they were built from;
  rebuild only ids whose pieces changed.
- Keep the `maxBuildings` roofed buildings nearest the map centre.
- Skip buildings whose footprint centroid lies in an exempt landmark footprint
  (`exemptionsFor(map)`), and re-run on `onExemptionsChanged`.

## 5. Roof geometry

- Port `src/triangulate/roofs/index.js`, `src/triangulate/roofs/Tools.js` and
  `src/triangulate/split.js` from OSMBuildings into `src/roofs/geometry/` as pure TypeScript
  functions. Input: footprint rings in local metres (centred on the footprint centroid, X east,
  Z south, glTF axes like the landmarks), wall-top height, roof height, shape, direction,
  orientation, colour. Output: `{ positions, normals, colors }` triangle arrays.
- Ridge shapes (`gabled`, `hipped`, `half_hipped`, `gambrel`, `mansard`, `skillion`) need a
  single ring: footprints with holes or several polygons fall back to a flat roof at the wall
  top (as OSMBuildings does). Degenerate input (fewer than 3 distinct points, zero area)
  yields no roof.
- **Colour:** `roof_color` if it parses; otherwise the material table (ported from
  OSMBuildings: `roof_tiles` `#f08060`, `slate` `#666666`, `metal` `#aaaaaa`, `copper`
  `#a0e0d0`, …, with its aliases); otherwise `#b9a99a`.

## 6. Rendering (`RoofsModule`)

- A `LayerModule` on the shared `ThreeCore`, so lighting and theme match the landmarks.
- All drawn roofs are merged into one `BufferGeometry` (vertex colours,
  `MeshStandardMaterial`), positioned relative to a batch anchor (the first building's
  centroid) for float precision; `place(origin)` positions the batch like a landmark.
  Per-building triangles are cached by id; a camera update only re-merges.
- **Heights.** Each roof's base is its wall top, `height − roofHeight` above the ground
  (`roofHeight` as resolved in section 3).
  On terrain, the ground is `queryTerrainElevation(centroid)`, matching MapLibre's per-feature
  centroid elevation for extrusions; elevations follow the same refresh rules as the landmark
  elevation cache (terrain change, debounced terrain tile loads).
- Below `minZoom` or during a globe transition nothing is drawn (the existing `ModuleLayer`
  guards).

## 7. Walls

- Feature-state key `landmarks:roof` holds the roof height the module actually drew for that
  building (id); buildings without a drawn roof have no state.
- The extrusion layer's `fill-extrusion-height` is wrapped once to subtract it:
  `original − coalesce(feature-state landmarks:roof, 0)`. It cannot drop below the base, as
  roof heights are capped at half the building (section 3). Zoom curves
  stay top-level (each output is wrapped). This adds a general `mapOutputs(value, fn)` to
  `src/core/expressions.ts`; `scaleBy` is rebuilt on it.
- The wrap follows the label-opacity pattern: a wrapper of ours already present is peeled off
  rather than doubled, a value the app replaced is re-wrapped, and removal restores the original
  only if our wrapper is still in place. `BuildingReplacement` adopts the same "restore only if
  still ours" rule, so the two wrappers on one layer can be added and removed in any order.
- `wallColors: true` wraps `fill-extrusion-color` as
  `coalesce(to-color(facade_color), <material colour>, original)` per output.

## 8. Integration

- **Landmarks:** roofs inside landmark footprints are skipped (section 4), so nothing floats
  over a sinking, replaced building.
- **Label occlusion:** roofs write depth, and `LabelOcclusion` already places itself after 3D
  custom layers, so labels behind roofs fade without changes.
- **Exports:** `RoofsLayer`, `RoofsModule`, `RoofsOptions`, `ROOF_STATE`.

## 9. Data recipe

`scripts/buildings/overture-to-pmtiles.sh <west> <south> <east> <north> <out.pmtiles>`:

1. DuckDB reads the latest Overture release's `building` and `building_part` types for the
   bounding box and selects the section 3 fields.
2. Each row gets a numeric `fid` (a stable 53-bit hash of the Overture id).
3. `tippecanoe` writes one `building` layer (`--use-attribute-for-id=fid`, buildings and parts
   together) into PMTiles, zoom 13–15, with the tile buffer kept so footprint unions close.

The README documents the schema, the script, and a Planetiler/OSM alternative for sources that
need OSM roof values outside Overture's enumeration (e.g. `double_saltbox`).

## 10. Error handling

| Situation                                  | Behaviour                                              |
| ------------------------------------------ | ------------------------------------------------------ |
| Source, source layer or extrusion missing  | Reported once via `onError`; module idles until present |
| Features without ids                       | No roofs for them; one warning per source              |
| Unknown / unsupported shape                | Flat (no roof, walls untouched)                        |
| Geometry failure for one building          | That building stays flat; reported once per id         |
| Legacy function in extrusion paint         | Walls not wrapped (warning); roofs not drawn for it    |
| Style swap                                 | Same as other modules: re-wrap on a diffed swap, tear down when dropped |
| Removal                                    | Paint restored if still ours, feature-state cleared, meshes disposed |

## 11. Testing

- **Unit (vitest, node):**
  - `mapOutputs` / `scaleBy` / wall wrap and restore (including two wrappers in either order).
  - Schema: `fields` mapping, value normalisation and mapping, default roof heights and caps.
  - Footprint merge: a building cut into two overlapping tile pieces unions into one polygon;
    pieces without ids are skipped; cache reuse when pieces are unchanged.
  - Roof generators (one test per drawn shape): vertex count bounds, ridge or apex position
    and height, ridge direction from `roof_direction` / `roof_orientation`, normals pointing
    up-ish, holes falling back to flat.
  - Module: feature-state written only for drawn roofs and cleared on removal; exempt
    footprints skipped; `maxBuildings` cap; terrain base heights.
- **Browser (Playwright):** the e2e page gains a GeoJSON source with a gabled building spanning
  a z16 tile seam (`promoteId`) and a fill-extrusion layer. With `RoofsLayer` added, the roof
  batch holds exactly one ridge for that building at the expected height, the building's wall
  is shortened via `landmarks:roof`, and removing the layer restores the paint.
