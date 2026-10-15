# Raised roads

`RoadsLayer` lifts the roads and railways that leave the ground into 3D: bridges as decks on
piers, and the roads leading onto them ramping up as embankments, so an overpass rises from the
street instead of within its own length. Roads on the ground stay with the basemap. Data comes
from [Overture's transportation theme](https://docs.overturemaps.org/guides/transportation/),
whose prebuilt tiles carry a `segment` layer of roads and railways.

```ts
import { RoadsLayer } from 'maplibre-landmarks';

map.addSource('overture-transportation', {
  type: 'vector',
  url: 'pmtiles://https://overturemaps-extras-us-west-2.s3.amazonaws.com/tiles/2026-09-23.1/transportation.pmtiles',
});
map.addLayer(
  new RoadsLayer({
    id: 'roads',
    source: 'overture-transportation',
    // Protomaps' flat bridge roads, hidden while the decks are shown.
    replaceLayers: ['roads_bridges_major', 'roads_bridges_major_casing'],
  }),
);
```

(`pmtiles://` needs the [pmtiles](https://github.com/protomaps/PMTiles) protocol, as for the
roof tiles.) MapLibre loads a source's tiles only when a style layer uses it, and past the
source's last zoom it keeps only the source layers a style layer draws: give the source an
invisible layer on both `segment` and `connector`.

```ts
map.addLayer({
  id: 'road-segments',
  type: 'line',
  source: 'overture-transportation',
  'source-layer': 'segment',
  paint: { 'line-opacity': 0 },
});
map.addLayer({
  id: 'road-connectors',
  type: 'circle',
  source: 'overture-transportation',
  'source-layer': 'connector',
  paint: { 'circle-opacity': 0, 'circle-radius': 0 },
});
```

::: tip Whole tiles past zoom 14
Overture's tiles stop at zoom 14. MapLibre 6 slices them into smaller tiles over the next four
zooms (`zoomLevelsToOverscale`, 4 by default), so a long segment arrives in short pieces and a
bridge partway along it can be placed only when its connectors are in view (the layer warns once
when this happens). Create the map with a high `zoomLevelsToOverscale` to overscale the tiles
whole, as MapLibre did before version 6:

```ts
const map = new maplibregl.Map({ container: 'map', style, zoomLevelsToOverscale: 30 });
```
:::

## How it is built

- **Bridges**: a segment's `road_flags` / `rail_flags` mark `is_bridge` over all of it, or over a
  `between` range of its length. Tiles cut segments at their edges, so the pieces of each segment
  are stitched back together first. A range over part of a segment is a share of its full length,
  which the loaded tiles may not show: it is placed from the segment's `connectors` (their share
  along it, and where the `connector` layer puts them) and its real ends, and waits while fewer
  than two of those are loaded. A bridge mapped as several segments is one deck,
  as long as the pieces share a level and nothing else meets them where they join.
- **Approaches**: from each end of a bridge, the ground roads of the same kind that carry on from
  it (the straightest within 35° where several meet the end) are followed through simple joins,
  until a junction or as far as the ramp needs. Underpasses (`level` below 0) are never
  approaches. Where no approach is found, the bridge ramps within its own length (at most a
  third of it at each end), and short bridges stay lower.
- **Height**: level × 6 m (`level_rules`, OSM's `layer`; a bridge is at least 1), reached with
  ramps of 10 % on average (15 % at the steepest), so a level-1 ramp is 60 m. The bridge runs
  straight between the ground at its two ends (it spans a valley rather than following it down);
  the embankments follow the ground.
- **Shape**: embankments have solid sides down to the ground, the bridge a 1.2 m deck with piers
  every 30 m where it clears the ground by more than 2 m; parapets grow with the height.
- **Width**: `width_rules` where tagged, else by class (motorway 12 m … footway 3 m, rail 6 m).

Not yet: road surfaces on the ground, lane markings, and tunnels.

## Options

| Option          | Default     | Notes                                                              |
| --------------- | ----------- | ------------------------------------------------------------------ |
| `source`        | required    | Vector source with Overture's transportation schema                |
| `sourceLayer`   | `'segment'` |                                                                    |
| `connectorLayer` | `'connector'` | Places bridges along segments only partly loaded                 |
| `minZoom`       | `15`        |                                                                    |
| `maxBridges`    | `400`       | Nearest bridges (with their approaches) drawn                      |
| `farCutoff`     | `true`      | Pitched views draw only to about three screen heights away         |
| `rail`          | `true`      | Railways too                                                       |
| `replaceLayers` | —           | The app's flat bridge layers, hidden while this layer is on        |
| `onError`       | —           |                                                                    |

Methods: `getStats()` (`bridges`, `approaches`, `triangles`, `highest`).
