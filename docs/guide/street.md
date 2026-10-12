# Street furniture

`StreetFurnitureLayer` stands OpenStreetMap street furniture along the streets: benches, bins,
recycling containers, bollards, fire hydrants, post boxes, bike racks, drinking fountains,
vending machines, information boards, street cabinets and charging stations. Data comes from
the `infrastructure` layer of [Overture's base theme](https://docs.overturemaps.org/guides/base/),
the same source as the [power lines and street lamps](./power).

```ts
import { StreetFurnitureLayer } from 'maplibre-landmarks';

map.addLayer(new StreetFurnitureLayer({ id: 'street', source: 'overture-base' }));
```

Each kind is one instanced mesh, a simple low-poly shape in a muted colour. A prop faces its
OSM `direction` tag (degrees or compass points) when it has one; otherwise each turns its own
stable way.

| Option        | Default            | Notes                                                       |
| ------------- | ------------------ | ----------------------------------------------------------- |
| `source`      | required           | Vector source with Overture's base schema                   |
| `sourceLayer` | `'infrastructure'` |                                                             |
| `minZoom`     | `16`               | The props are under 2 m tall                                |
| `maxPerKind`  | `1500`             | Nearest drawn per kind                                      |
| `kinds`       | all                | Subset of `PROP_KINDS`, e.g. `['bench', 'bollard']`         |
| `farCutoff`   | `true`             | Pitched views draw props only to about three screen heights |
| `onError`     | —                  |                                                             |

Methods: `getStats()` (`total`, `byKind`).
