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
  the approaches follow the ground.
- **Shape**: a deck with a light edge band over a tapered girder, with edge lines and a dashed
  centre line on roads (rails on railways). Approaches lower than 2.5 m are solid embankments
  (nothing passes under them); higher, they stand open on piers like the bridge, so the roads they
  cross stay clear. No parapets.
- **Piers**: round columns under a cap, two under decks wider than 12 m, about every 30 m where
  the deck clears the ground by more than 2 m. They stand clear of the other roads and railways
  below: a pier moves up to 12.5 m along the deck to find a free spot, or is left out (the span
  grows longer).
- **Linked bridges**: a road joining two bridges, shorter than the two ramps between them would
  need, is raised with them instead of dipping between two ramps.
- **Tiles**: source tiles are read at least 1 km from the view centre, past the far cutoff, and the
  last 64 tiles to leave the view are kept, so a bridge whose segment runs out of the loaded tiles
  can still be placed.
- **Width**: `width_rules` where tagged, else by class (motorway 12 m … footway 3 m, rail 6 m).

## Roads on the ground and tunnels

- **Road surfaces** (`groundRoads`, off by default): every road and railway within 800 m of the
  view centre (the nearest 2500) drawn in 3D too, following the terrain: asphalt with edge lines
  and a dashed centre line, lighter paths, railways with their rails. Bigger roads lie a few
  centimetres over smaller ones where they overlap, and a patch covers each junction (a connector
  where roads meet from three or more directions), with no markings across it. Hide the basemap's
  road lines with `replaceLayers` while it is on. It costs more than flat lines: thousands of
  stretches in a city view.
- **Tunnels**: segments flagged `is_tunnel` are not drawn. Where a road or railway goes into one
  from the ground, it drops into a cutting (about 6.4 m for roads, 7.9 m for railways, over the
  bridges' 10 % average grade): the road descending between retaining walls whose coping stands a
  little above the ground, to a portal whose top meets the ground, its opening dark. With terrain,
  the cutting is only as deep as the ground ahead does not already rise over the tunnel: a tunnel
  into a hillside gets its portal and no cutting.
- **Short tunnels** (under 60 m: galleries, covered stretches, toll canopies) stay on the level,
  covered by a concrete box.
- **Seeing into a cutting**: the flat map writes no depth, so the layer draws the ground around
  each cutting (and over the tunnel) into the depth buffer only, hiding what lies below the
  ground; terrain does write depth, so the cutting's opening is cleared to far depth first, to show
  the trench through it. A 3D building standing right between the camera and a cutting's opening
  can show the trench through itself.

Hide the basemap's tunnel lines with `replaceLayers`.

Not yet: lane counts.

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
| `groundRoads`   | `false`     | Roads on the ground in 3D too; `{ radius, maxSegments }` (800 m, 2500) |
| `tunnels`       | `true`      | Cuttings and portals at tunnel mouths, covers over short tunnels   |
| `replaceLayers` | —           | The app's flat layers this draws instead (bridges, tunnels, ground roads), hidden while on |
| `onError`       | —           |                                                                    |

Methods: `getStats()` (`bridges`, `approaches`, `ground`, `junctions`, `portals`, `covers`,
`triangles`, `highest`).
