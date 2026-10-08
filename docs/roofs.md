# Roofs: tileset attributes and roof shapes

`RoofsLayer` draws real 3D roofs (gabled, hipped, domes, …) on top of your own `fill-extrusion`
buildings and shortens each building's walls by the roof it draws. It reads plain attributes from
a vector (or GeoJSON) source. This page lists the attributes a tileset needs, how each value is
read, and how every OpenStreetMap `roof:shape` value is drawn.

## Tileset requirements

- **A vector or GeoJSON source** with one feature per building outline and per building part
  (polygons or multipolygons).
- **Feature ids.** Every feature needs an id (numeric ids, or `promoteId` on the source).
  The layer uses them to shorten walls through feature state.
- **Attribute names follow Overture's building schema** by default. Other sources map their names
  with `fields`, e.g. `fields: { roof_shape: 'roof:shape', roof_angle: 'roof:angle' }`.
- **Your walls**: a `fill-extrusion` layer on the same source, passed as `extrusionLayer`.
  Give it `filter: ['!=', ['get', 'has_parts'], true]`, so outlines drawn by their parts don't
  hide those parts' roofs.

Only buildings with a recognised `roof_shape` (and a `height`) get a roof; every other building
keeps its flat extrusion.

## Attributes

| Attribute          | Required    | Type              | Meaning                                                                                 | OSM tag                                  | Overture column    |
| ------------------ | ----------- | ----------------- | --------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------ |
| `roof_shape`       | yes         | string            | Roof shape, see [Roof shapes](#roof-shapes)                                             | `roof:shape`                             | `roof_shape`       |
| `height`           | yes         | number (m)        | Top of the building or part, **including** its roof                                     | `height` (or `building:levels`, below)   | `height` (or `num_floors`, below) |
| `min_height`       | no (0)      | number (m)        | Bottom of the part (for parts that start above ground)                                  | `min_height` / `building:min_level`      | `min_height` (or `min_floor`) |
| `roof_height`      | no          | number (m)        | Height of the roof alone, eaves to top                                                  | `roof:height` (or `roof:levels`)         | `roof_height`      |
| `roof_angle`       | no          | number (°)        | Pitch of the roof faces; used only when there is no `roof_height`                       | `roof:angle`                             | —                  |
| `roof_direction`   | no          | number (°) or N/E | Compass bearing the main roof face looks toward                                         | `roof:direction`                         | `roof_direction`   |
| `roof_orientation` | no          | `along`/`across`  | Ridge along or across the longest side of the outline                                  | `roof:orientation`                       | `roof_orientation` |
| `roof_color`       | no          | CSS colour        | Roof colour                                                                             | `roof:colour`                            | `roof_color`       |
| `roof_material`    | no          | string            | Picks a roof colour when no `roof_color` is set                                         | `roof:material`                          | `roof_material`    |
| `facade_color`     | no          | CSS colour        | Wall colour (gable ends; the extrusion too with `wallColors: true`)                     | `building:colour`                        | `facade_color`     |
| `facade_material`  | no          | string            | Picks a wall colour when no `facade_color` is set                                       | `building:material`                      | `facade_material`  |
| `has_parts`        | recommended | boolean           | The outline is drawn by its `building:part`s: no roof of its own                        | derived (a part lies inside the outline) | `has_parts`        |

How values are read:

- **Numbers** may be numbers or numeric strings (`"12"`). Non-numeric values are ignored.
- **`height` must be greater than `min_height`**, or the building gets no roof.
- **`roof_height`** must be positive. It is capped at the part's full height span (a part that is
  all roof, like a spire, can be).
- **`roof_angle`** must be between 0 and 90 (exclusive).
- **`roof_direction`** takes degrees clockwise from north, or a 16-point compass value
  (`N`, `NNE`, … `NNW`).
- **`roof_orientation`** other than `along` / `across` is ignored.
- **`has_parts`** accepts `true`, `1`, `"true"` or `"yes"`.
- **Shape names** are matched case-insensitively, and `_` / `-` are interchangeable
  (`half-hipped`, `half_hipped` and `Half-Hipped` are the same).

## Roof height

The roof is drawn inside the building's height: walls are shortened by the roof height, so the top
of the roof sits at `height`.

1. **`roof_height`** if set, capped at `height − min_height`.
2. Otherwise **`roof_angle`**, if set: `tan(angle) × run`, capped at `height − min_height`. The run
   is the horizontal distance one roof face covers:
   - gabled-family shapes, butterfly, crosspitched: half the width across the ridge;
   - skillion: the full width;
   - sawtooth: one tooth (the angle sets every tooth);
   - pyramidal, cone: the radius (half the shorter side).
   - Ignored for curved roofs (`dome`, `onion`, `round`), which have no single pitch.
3. Otherwise a **default** height: `tan(30°) ×` half the shorter side (half a tooth for sawtooth),
   or the radius for curved roofs. That is a 30° pitch for gabled-family roofs; a skillion, whose
   face spans the full width, comes out shallower. The default is capped at half of `height − min_height`, and a building
   whose default comes out under 0.5 m gets no roof.

## Roof direction and the ridge

Roofs are laid out on the outline's tight bounding box, with the ridge along one axis:

- With **`roof_direction`**, the main face looks toward that bearing and the ridge runs
  perpendicular to it. A skillion slopes down toward the bearing; sawtooth teeth slope down toward
  it, with their glazing facing away.
- Otherwise the ridge runs along the **longest side**, or across it with
  `roof_orientation=across`.
- `hipped`, `half_hipped`, `hipped_and_gabled` and `mansard` always put the ridge on the longer
  axis of the box, since their end slopes assume it.

## Roof shapes

### Drawn as their real shape

| `roof_shape`        | Drawn as                                                                                            | In Overture |
| ------------------- | --------------------------------------------------------------------------------------------------- | ----------- |
| `gabled`            | Two slopes meeting at a central ridge; vertical gable ends                                          | yes         |
| `saltbox`           | Gable with the ridge off-centre (moved by a third of the half-width), so one slope is longer        | yes         |
| `hipped`            | Four slopes; the ridge is shortened by the hips at each end                                         | yes         |
| `half_hipped`       | Gable ends up to half height, small hips above (jerkinhead)                                         | yes         |
| `hipped_and_gabled` | Hips up to half height, small vertical gables above (Dutch gable)                                   | no          |
| `gambrel`           | Barn roof: steep lower part on both long sides, shallower upper part; gable ends                    | yes         |
| `mansard`           | Gambrel profile on all four sides                                                                   | yes         |
| `skillion`          | One slope, high at the back, low toward `roof_direction`                                            | yes         |
| `round`             | Half-cylinder vault along the ridge (8 facets)                                                      | yes         |
| `bellcast_gable`    | Gable whose slopes flatten into a flare near the eaves                                              | no          |
| `butterfly`         | V shape: eaves at full height on both long sides, valley along the middle                          | no          |
| `crosspitched`      | Two crossing gables: gable ends on all four sides, meeting at a central peak                        | no          |
| `sawtooth`          | Repeated single slopes (~8 m teeth, whole number across the building) with near-vertical glazing   | yes         |
| `pyramidal`         | Slopes from every outline edge up to a central apex                                                 | yes         |
| `cone`              | Slopes from every outline point up to a central apex: a true cone on a round outline, and the whole footprint covered on any other | no          |
| `dome`              | Hemisphere-like dome on a circle inside the outline (corners of a square outline stay flat)                                                      | yes         |
| `onion`             | Onion dome (OSM Buildings profile)                                                                  | yes         |

Near-vertical faces (gable ends, the small gables of `hipped_and_gabled`, sawtooth glazing) take the
wall colour; sloped faces take the roof colour.

### Aliases (drawn as the nearest shape)

| `roof_shape`                                 | Drawn as      | Notes                                                                    |
| -------------------------------------------- | ------------- | ------------------------------------------------------------------------ |
| `spherical`                                  | `dome`        | Overture's name for a dome                                               |
| `pyramid`                                    | `pyramidal`   | Synonym                                                                  |
| `pitched`                                    | `gabled`      | Synonym                                                                  |
| `lean_to`, `monopitch`, `shed`               | `skillion`    | Synonyms                                                                 |
| `side_hipped`                                | `hipped`      | OSM doesn't say which end is hipped, so both ends are                    |
| `side_half-hipped`                           | `half_hipped` | Same, both ends                                                          |
| `gabled_height_moved`, `gabled_irregular`    | `saltbox`     | Uneven gable; no OSM tag says where the ridge sits, so a fixed offset is used |
| `double_saltbox`, `quadruple_saltbox`        | `mansard`     | Close, not exact                                                         |

### No roof (the building keeps its flat extrusion)

| `roof_shape`                      | Why                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------- |
| `flat`                            | Already right: the extrusion's top is the roof                                  |
| `many`, `mixed`, `mix`, `multi`   | Discouraged in OSM; such buildings are normally drawn by their `building:part`s |
| `gabled_row`                      | Undefined in OSM                                                                |
| anything else, or missing         | Unknown values (including typos like `2 faces (pitched)`) are ignored           |

## Colours

- **`roof_color` / `facade_color`** accept `#rgb`, `#rrggbb`, CSS colour names (`red`,
  `darkslategray`, …), and `rgb()` / `hsl()`. Named colours are parsed literally (`red` is `#ff0000`).
- **Materials** pick a colour when no colour is set (palette from OSM Buildings):

  | Material (aliases)                                                                 | Colour    |
  | ---------------------------------------------------------------------------------- | --------- |
  | `roof_tiles` (`tile`, `tiles`, `rooftiles`)                                        | `#f08060` |
  | `brick` (`bricks`)                                                                 | `#cc7755` |
  | `slate` (`slates`)                                                                 | `#666666` |
  | `tar_paper` (`asphalt`, `bitumen`, `tar`, `roofingfelt`, `shingle`, `shingles`)    | `#333333` |
  | `metal` (`steel`)                                                                  | `#aaaaaa` |
  | `copper`                                                                           | `#a0e0d0` |
  | `concrete`, `plaster` (`plastered`)                                                | `#999999` |
  | `stone` (`block`, `masonry`, `granite`, `sandstone`, `paving_stones`)              | `#996666` |
  | `glass` (`glas`, `glassfront`)                                                     | `#e8f8f8` |
  | `wood`                                                                             | `#deb887` |
  | `plants` (`grass`, `thatch`)                                                       | `#009933` |
  | `canvas` (`sheet`, `sheets`, `tent`), `panel` (`panels`)                           | `#fff8f0` |
  | `bronze` / `silver` / `gold`                                                       | `#ffeecc` / `#cccccc` / `#ffcc00` |

- **Defaults**: roofs `#b9a99a`; walls and gable ends use the layer's `gableColor` (`#d9d4ce`).
- **Roof faces are toned down** as OSM Buildings does: every roof colour (tagged, from a material,
  or the default) is drawn at 70 % of its HSL saturation, so `red` becomes a brick red. Each
  building's roof lightness also shifts by ±0.03 or ±0.06 (stable for its feature id), so rows of
  identical roofs stay distinguishable. Wall-coloured faces (gable ends, glazing) are left as
  tagged, so they keep matching the extrusion walls.

## Building a tileset

Two scripts build a PMTiles tileset (source layer `building`, zooms 13–15, feature ids set) with
exactly the attributes above. Both need [tippecanoe](https://github.com/felt/tippecanoe) ≥ 2.17.

### From Overture

```sh
scripts/buildings/overture-to-pmtiles.sh <west> <south> <east> <north> out.pmtiles [release]
```

Reads Overture's `building` and `building_part` types with DuckDB. Good for large areas. A
building without `height` gets `num_floors × 3 m` plus its `roof_height` (if any); one without
`min_height` gets `min_floor × 3 m`. Overture
limits `roof_shape` to 14 values (`dome`, `flat`, `gabled`, `gambrel`, `half_hipped`, `hipped`,
`mansard`, `onion`, `pyramidal`, `round`, `saltbox`, `sawtooth`, `skillion`, `spherical`), so
OSM-only shapes such as `side_hipped`, `butterfly`, `crosspitched` or `hipped-and-gabled` arrive as
one of these or not at all, and there is no `roof_angle`.

### From OpenStreetMap

```sh
node scripts/buildings/osm-to-pmtiles.mjs <west> <south> <east> <north> out.pmtiles
```

Reads OSM through the Overpass API (`building=*` and `building:part=*` ways and multipolygon
relations). It keeps every raw `roof:shape` value and `roof:angle`. Keep boxes small (a town
centre); public Overpass servers are often busy, so it retries three servers, and `OVERPASS_URL`
picks another. Data © OpenStreetMap contributors, ODbL.

How OSM tags become attributes:

| Attribute          | From                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `height`           | `height` (metres; `ft` and `'` converted). Else `building:levels × 3 m` plus the roof height                                          |
| `min_height`       | `min_height`, else `building:min_level × 3 m`                                                                                         |
| `roof_shape`       | `roof:shape`, trimmed and lower-cased (aliases resolved when drawn)                                                                   |
| `roof_height`      | `roof:height`, else `roof:levels × 3 m`                                                                                               |
| `roof_angle`       | `roof:angle`                                                                                                                          |
| `roof_direction`   | `roof:direction` (degrees or compass, as tagged)                                                                                      |
| `roof_orientation` | `roof:orientation`                                                                                                                    |
| `roof_color`       | `roof:colour`                                                                                                                         |
| `roof_material`    | `roof:material`                                                                                                                       |
| `facade_color`     | `building:colour`                                                                                                                     |
| `facade_material`  | `building:material`                                                                                                                   |
| `has_parts`        | `true` on an outline when a `building:part` (its centroid) lies inside it                                                             |
| feature id         | way id × 2, relation id × 2 + 1                                                                                                       |

### Your own source

Any source works if it carries the attributes above under these names, or under its own names
mapped with `fields`. A source straight from OSM tags, for example:

```ts
new RoofsLayer({
  id: 'roofs',
  source: 'osm-buildings',
  sourceLayer: 'building',
  extrusionLayer: 'osm-buildings-3d',
  fields: {
    roof_shape: 'roof:shape',
    roof_height: 'roof:height',
    roof_angle: 'roof:angle',
    roof_direction: 'roof:direction',
    roof_orientation: 'roof:orientation',
    roof_color: 'roof:colour',
    roof_material: 'roof:material',
    facade_color: 'building:colour',
    facade_material: 'building:material',
  },
});
```

`height` must still be in metres and include the roof, and `has_parts` must be computed (OSM has
no such tag).

## Sources

- [OSM wiki: Key:roof:shape](https://wiki.openstreetmap.org/wiki/Key:roof:shape)
- [OSM wiki: Simple 3D Buildings](https://wiki.openstreetmap.org/wiki/Simple_3D_Buildings)
- [Overture building schema](https://docs.overturemaps.org/schema/reference/buildings/building/)
- [Overture `roof_shape` values](https://docs.overturemaps.org/schema/reference/buildings/types/roof_shape/)
- Dome and onion profiles and the material palette:
  [OSM Buildings](https://github.com/OSMBuildings/OSMBuildings) (BSD-2-Clause)
