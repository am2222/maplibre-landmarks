# Power lines

`PowerLinesLayer` draws the power grid: steel pylons and poles where they are mapped, with
three sagging wires per span between them. Data comes from
[Overture's base theme](https://docs.overturemaps.org/guides/base/) (OpenStreetMap power
features), whose prebuilt tiles carry an `infrastructure` layer.

```ts
import { PowerLinesLayer } from 'maplibre-landmarks';

map.addSource('overture-base', {
  type: 'vector',
  url: 'pmtiles://https://overturemaps-extras-us-west-2.s3.amazonaws.com/tiles/2026-09-23.1/base.pmtiles',
});
map.addLayer(new PowerLinesLayer({ id: 'power', source: 'overture-base' }));
```

(`pmtiles://` needs the [pmtiles](https://github.com/protomaps/PMTiles) protocol, as for the
roof tiles.) MapLibre loads a source's tiles only when a style layer uses it: give the source
any layer, for example an invisible line layer on `infrastructure`.

## How it is built

- **Supports** come from `power_tower` (pylons) and `power_pole` (poles) points, heights from
  their OSM `height` tag (in `source_tags`), else 30 m for pylons and 10 m for poles.
- **Spans** join consecutive supports along each `power_line` / `minor_line`. Tiles simplify
  lines (towers on a straight run drop out of the geometry) but keep the points, so supports
  are ordered along the line. A span cut by a tile edge is joined to the first tower of the same
  line straight ahead in the next tile. A line without mapped supports hangs from its vertices, except those in water.
- Supports are turned across their line; wires hang from the arm tips and the top, sagging 3% of
  the span.
- Buried `cable`s and substations are left out.

## Options

| Option         | Default            | Notes                                                              |
| -------------- | ------------------ | ------------------------------------------------------------------ |
| `source`       | required           | Vector source with Overture's base schema                          |
| `sourceLayer`  | `'infrastructure'` |                                                                    |
| `minZoom`      | `14`               |                                                                    |
| `maxSupports`  | `2000`             | Nearest supports drawn                                             |
| `farCutoff`    | `true`             | Pitched views draw supports only to about three screen heights away |
| `water` | same source, `'water'` | Water polygons: a line without mapped supports gets no pole in water; `false` turns it off |
| `onError`      | —                  |                                                                    |

Methods: `getStats()` (`supports`, `spans`, `tallest`).
