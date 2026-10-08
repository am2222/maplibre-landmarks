# maplibre-landmarks

3D landmark models from [Open Landmarks](https://open-landmarks.benmaps.fr) for
[MapLibre GL JS](https://maplibre.org), rendered with [Three.js](https://threejs.org).
Built for Protomaps basemaps, with a shared 3D core ready for future tree and water layers.

## Install

```bash
npm install maplibre-landmarks maplibre-gl three
```

## Usage

```ts
import { Map } from 'maplibre-gl';
import { LandmarksLayer } from 'maplibre-landmarks';

map.on('load', () => {
  map.addLayer(
    new LandmarksLayer({
      id: 'landmarks',
      channel: 'latest', // or 'preview' for drafts, or catalogueUrl to pin a release
      replaceBuildings: ['buildings'], // Protomaps building layer to hide under loaded models
    }),
    'pois', // beforeId: draw below labels
  );
});
```

### Options

| Option                        | Default                             | Description                                                                                                     |
| ----------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `id`                          | required                            | Layer id                                                                                                        |
| `channel`                     | `'latest'`                          | `'latest'` (approved) or `'preview'` (includes drafts)                                                          |
| `catalogueUrl`                | —                                   | Pinned catalogue path or URL; overrides `channel`                                                               |
| `baseUrl`                     | `https://open-landmarks.benmaps.fr` | API origin                                                                                                      |
| `replaceBuildings`            | `[]`                                | Basemap layer ids whose buildings hand over to loaded models (extrusions sink into the ground, flat fills fade) |
| `replacementInsetM`           | `1.5`                               | Footprint inset so neighbours sharing a wall stay visible                                                       |
| `maxResident`                 | `8`                                 | Models kept on the GPU                                                                                          |
| `maxCached` / `maxCacheBytes` | `12` / 32 MB                        | Parsed models kept off-screen                                                                                   |
| `theme`                       | —                                   | `'day'`, `'dawn'`, `'dusk'` or `'night'`; sets the map-wide theme (see `setTheme`)                              |
| `fadeMs`                      | `400`                               | Model fade-in/out and building hand-over duration; `0` swaps instantly                                          |
| `minZoom`                     | `14`                                | Below this zoom nothing is drawn                                                                                |
| `dracoDecoderPath`            | —                                   | Folder with three's `draco_decoder` files; enables Draco-compressed models                                      |
| `ktx2TranscoderPath`          | —                                   | Folder with three's `basis_transcoder` files; enables KTX2 textures                                             |
| `onModelsChanged`             | —                                   | Called with the visible models (id, name, LOD, attribution)                                                     |
| `onError`                     | `console.warn`                      | `(err, { stage, id? })`                                                                                         |

Methods: `setTheme(theme)`, `getVisibleModels()`, `getAttribution()`.

Models appear from zoom 15 (as declared per model), swap to the detail LOD at each model's
`detailZoom`, follow terrain when `map.setTerrain` is on (their footing stretches down onto
sloping ground so the downhill side never floats), and require the flat (mercator) view; globe
projection switches to mercator well before landmark zooms. When a replaced layer is a
`fill-extrusion`, models also wait for that layer's `minzoom`, so a landmark never stands alone
among flat buildings.

Building replacement uses feature-state, not filters, so panning never re-parses basemap tiles. It
hides the Protomaps feature ids Open Landmarks lists for each model, plus any building whose centre
lies inside the model's footprint. It works on `fill` and `fill-extrusion` layers whose features have
ids (Protomaps buildings do). Use `replaceBuildings` on only one `LandmarksLayer` per basemap layer.

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

| Option        | Default             | Description                                        |
| ------------- | ------------------- | -------------------------------------------------- |
| `id`          | `'label-occlusion'` | Layer id                                           |
| `labelLayers` | auto                | Symbol layer ids to manage                         |
| `minZoom`     | `15`                | Below this zoom every label is shown               |
| `fadeMs`      | `180`               | Fade duration                                      |
| `maxLabels`   | `256`               | Labels tested at once, nearest to the centre first |
| `onError`     | `console.warn`      | Shader or GL setup failures                        |

It works without `LandmarksLayer`, moves itself after the 3D layers, needs WebGL2 (otherwise it
does nothing), and `map.removeLayer(id)` restores the label paint.

MapLibre cannot restore custom layers after a lost WebGL context: re-add `LandmarksLayer` and
`LabelOcclusion` on `webglcontextrestored`. Re-adding is safe; label paint is never wrapped twice.

`map.setStyle(...)` is handled: with the default diff the layer survives and re-applies building
replacement and attribution to the new style; with `{ diff: false }` the layer is dropped and cleans
up after itself (add it again after `style.load`).

### Roof shapes

`RoofsLayer` draws real roofs (gabled, hipped, mansard, dome, …) on top of your own
`fill-extrusion` buildings, from any vector source that follows Overture's building schema:

```ts
import { RoofsLayer } from 'maplibre-landmarks';

map.addLayer(
  new RoofsLayer({
    id: 'roofs',
    source: 'buildings', // needs feature ids (numeric ids or promoteId)
    sourceLayer: 'building',
    extrusionLayer: 'buildings-3d', // your walls; shortened by the roof drawn on each building
  }),
);
```

| Attribute                            | Meaning                                                                                                                                                                                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `height`, `min_height`               | Building / part top (incl. roof) and bottom, metres                                                                                                                                                                                     |
| `roof_shape`                         | `gabled`, `saltbox`, `hipped`, `half_hipped`, `hipped_and_gabled`, `gambrel`, `mansard`, `skillion`, `round`, `bellcast_gable`, `butterfly`, `crosspitched`, `sawtooth`, `pyramidal`, `cone`, `dome`, `onion` (plus OSM aliases, below) |
| `roof_height`                        | Roof alone; default from a 30° pitch (or the radius for domes)                                                                                                                                                                          |
| `roof_angle`                         | Pitch in degrees, used when there is no `roof_height` (OSM `roof:angle`; not in Overture)                                                                                                                                               |
| `roof_direction`, `roof_orientation` | Bearing the roof faces; `along` / `across` the longest side                                                                                                                                                                             |
| `roof_color`, `roof_material`        | Roof colour; material picks a colour when no colour is tagged                                                                                                                                                                           |
| `facade_color`, `facade_material`    | Walls, with `wallColors: true`                                                                                                                                                                                                          |
| `has_parts`                          | Outline drawn by its parts: no roof of its own                                                                                                                                                                                          |

Draw walls only for outlines without parts, or each outline's box hides its parts' roofs:
add `filter: ['!=', ['get', 'has_parts'], true]` to your extrusion layer.

Other sources map their names with `fields`, e.g. `fields: { roof_shape: 'roof:shape' }`.
Buildings without a roof shape keep their flat extrusion. Options: `minZoom` (15),
`maxBuildings` (2000), `wallColors` (false), `gableColor` (`#d9d4ce`), `onError`.

**Data.** Two scripts build a tileset for a bounding box, both writing the attributes above:

- `scripts/buildings/overture-to-pmtiles.sh <west> <south> <east> <north> out.pmtiles` reads
  Overture (DuckDB + tippecanoe). Overture keeps only 14 roof shapes (e.g. it folds
  `double_saltbox` into `saltbox`, has no `side_hipped` or `butterfly`) and no `roof_angle`.
- `node scripts/buildings/osm-to-pmtiles.mjs <west> <south> <east> <north> out.pmtiles` reads
  OSM through Overpass (tippecanoe only), keeping every raw `roof:shape` and `roof:angle`. It
  falls back to 3 m per `building:levels` / `roof:levels`, and sets `has_parts` when a
  `building:part` lies inside the outline. Keep boxes small (a town centre); set `OVERPASS_URL`
  for another server. Data © OpenStreetMap contributors (ODbL).

Full attribute and shape reference: [`docs/roofs.md`](docs/roofs.md).

**OSM aliases.** `_` and `-` spellings are interchangeable. Drawn as the nearest shape:
`side_hipped` → hipped; `side_half-hipped` → half_hipped; `gabled_height_moved`,
`gabled_irregular` → saltbox; `double_saltbox`, `quadruple_saltbox` → mansard; `pitched` →
gabled; `lean_to`, `monopitch`, `shed` → skillion; `pyramid` → pyramidal; Overture's
`spherical` → dome. `flat`, `many` and unknown values get no roof. `sawtooth` draws ~8 m teeth
across the building; `roof_height` (or `roof_angle`) applies to one tooth.

Roof shapes for dome, onion, cone and pyramid, and the material colours, are derived from
[OSM Buildings](https://github.com/OSMBuildings/OSMBuildings) (BSD-2-Clause; see `LICENSE`).

## Trees

```ts
import { TreesLayer, setTheme } from 'maplibre-landmarks';

map.addLayer(new TreesLayer({ id: 'trees', source: 'protomaps' }), 'pois');
setTheme(map, 'dusk'); // day | dawn | dusk | night: lights + tree/landmark palettes, map-wide
```

Trees come from Protomaps `pois` points with `kind=tree` (zoom 15+ tiles). Green `landuse` polygons
(`forest`, `wood`, `park` by default) are filled with seeded, stable trees only where mapped trees
are sparse. The nearest `maxTrees` (4000) are drawn from zoom 16, with cheap impostors beyond
`lodDistanceM` (300 m). The `source` must be used by at least one style layer (MapLibre only loads
tiles for used sources; a basemap source always is). Trees sway with `wind: { strength, directionDeg }` (`setWind`), and calm
wind stops the repaint loop.

| Option                                  | Default                                     | Description                                                               |
| --------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------- |
| `source`                                | required                                    | Vector (Protomaps schema) or GeoJSON source id                            |
| `sourceLayers`                          | `{ points: 'pois', polygons: 'landuse' }`   | `''` for GeoJSON                                                          |
| `models`                                | `[deciduous, conifer, birch]`               | Any `TreeModel`                                                           |
| `weights`                               | `{ deciduous: .6, conifer: .2, birch: .2 }` | Pick probability per model id                                             |
| `maxTrees` / `minZoom` / `lodDistanceM` | `4000` / `16` / `300`                       | Budget                                                                    |
| `scatter`                               | `{ forest: 1/60, wood: 1/60, park: 1/400 }` | Trees per m² by landuse kind; `false` = points only                       |
| `scatterSkipRatio`                      | `0.25`                                      | Don't scatter a polygon whose mapped trees reach this share of its target |
| `wind`                                  | `{ strength: 1, directionDeg: 250 }`        | Direction the wind blows from                                             |
| `theme`                                 | —                                           | Sets the map-wide theme                                                   |

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

## Attribution and licences

Open Landmarks models are **CC BY 4.0** (artistic contributions) and contain OpenStreetMap-derived
data under **ODbL 1.0**; some models include other sources (e.g. IGN LiDAR HD, Licence Ouverte 2.0).
The layer adds the required attribution to MapLibre's attribution control automatically and exposes
it via `getAttribution()`. See https://open-landmarks.benmaps.fr/licenses/.

This library is MIT licensed. It is not affiliated with Open Landmarks or benmaps.fr.

## Development

```bash
npm install
npm test               # unit tests
npm run test:browser   # Playwright, uses the live Open Landmarks API
cp .env.example .env.local   # add a Protomaps key for the demo
npm run dev            # demo at http://localhost:5179
npm run build
```

## Extending

`ModuleLayer` + `LayerModule` let other 3D content share the same Three.js renderer:
implement `onAdd`, `update(view)`, `place(origin)`, optional `frame(time)` and `onRemove`, and
wrap it in `new ModuleLayer(id, module)`. Coordinates are metres in glTF axes (X east, Y up, Z south)
relative to the per-frame `origin`; use `localPosition(origin, lngLat, elevation)`.
