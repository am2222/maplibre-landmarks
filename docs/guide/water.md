# Water

`WaterLayer` draws the basemap's water as animated, lit water: waves, sky reflection and sun
glints, rivers flowing downstream, calmer lakes, a swelling sea, bright pools, and foam along
shorelines. It follows the theme and the terrain.

```ts
import { WaterLayer } from 'maplibre-landmarks';

// After the basemap's water fill and river lines (in Protomaps, right after `water_river`), so
// piers, roads, bridges and labels draw on top.
map.addLayer(new WaterLayer({ id: 'water-3d' }), 'landuse_pedestrian');
```

| Option         | Default       | Description                                                |
| -------------- | ------------- | ---------------------------------------------------------- |
| `source`       | `'protomaps'` | Vector source with a water layer (or a GeoJSON source)     |
| `sourceLayer`  | `'water'`     | Source layer of a vector source                            |
| `waves`        | `1`           | Wave strength, 0 = still (`setWaves` to change live)       |
| `maxTriangles` | `300000`      | Beyond this, the water farthest from the centre is dropped |
| `colors`       | theme         | Per-style CSS overrides: `{ sea, lake, river, pool }`      |
| `minZoom`      | `12`          | Below this zoom nothing is drawn                           |

Styles come from Protomaps' `kind` / `kind_detail`: `ocean` is sea; `swimming_pool`, `fountain`
and basins are pools; rivers and canals flow along the nearest river line; everything else is a
lake. With terrain, lakes, sea and pools lie flat just above the ground sampled inside them
(one level per water body across tile seams) and rivers follow the ground.
