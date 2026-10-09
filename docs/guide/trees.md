# Trees

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
| `maxTrees` / `minZoom` / `lodDistanceM` | `4000` / `14` / `300`                       | Budget (trees appear with the 3D buildings at zoom 14)                    |
| `fullDensityZoom`                       | `16`                                        | Below it scattered trees are thinned: ¼ two zooms below, ½ one zoom below |
| `scatter`                               | `{ forest: 1/60, wood: 1/60, park: 1/400 }` | Trees per m² by landuse kind; `false` = points only                       |
| `density` | `0.6` | Share of scattered trees drawn (a fixed subset; mapped trees always) |
| `farCutoff` | `true` | Pitched views (past 45°) draw trees only to about three screen heights away, sinking them near the edge, and skip tiles beyond |
| `riseMs` | `400` | A newly shown tree rises from the ground over this time (`0`: appears at once) |
| `scatterSkipRatio`                      | `0.25`                                      | Don't scatter a tile piece whose mapped trees reach this share of its target |
| `wind`                                  | `{ strength: 1, directionDeg: 250 }`        | Direction the wind blows from                                             |
| `theme`                                 | —                                           | Sets the map-wide theme                                                   |

Methods: `setWind(wind)`, `setDensity(density)`, `setTheme(theme)`, `getStats()`.

## Custom tree models

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
