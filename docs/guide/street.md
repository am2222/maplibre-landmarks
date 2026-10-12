# Street furniture

`StreetFurnitureLayer` stands OpenStreetMap street furniture along the streets: benches, bins,
recycling containers, bollards, fire hydrants, post boxes, bike racks, drinking fountains,
vending machines, information boards, street cabinets and charging stations; Wallace-style
fountains, statues and busts on plinths, communication masts and storage tanks; and, from areas,
fountain basins with water, platforms and pier decks. Data comes from
the `infrastructure` layer of [Overture's base theme](https://docs.overturemaps.org/guides/base/),
the same source as the [power lines and street lamps](./power).

```ts
import { StreetFurnitureLayer } from 'maplibre-landmarks';

map.addLayer(new StreetFurnitureLayer({ id: 'street', source: 'overture-base' }));
```

Each kind is one instanced mesh, a simple low-poly shape in a muted colour. A prop faces its
OSM `direction` tag (degrees or compass points) when it has one; otherwise each turns its own
stable way.

- **Artworks**: only free-standing figures (`artwork_type` sculpture, statue or bust); murals and
  architecture are left out.
- **Communication masts** stand to their `height` tag (30 m when untagged).
- **Storage tanks** are sized by `height` and `diameter` (8 m and 10 m when untagged); one mapped
  as an outline becomes a cylinder of the same area. Underground tanks are left out.
- **Areas** (one mesh): fountain basins get a rim of their `height` (0.5 m) with water at 80% of
  it; platforms a slab 0.9 m high for rail, 0.2 m for bus stops, skipping indoor, underground and
  below-ground ones; piers a deck 0.6 m high (3 m wide when mapped as a line).

| Option        | Default            | Notes                                                       |
| ------------- | ------------------ | ----------------------------------------------------------- |
| `source`      | required           | Vector source with Overture's base schema                   |
| `sourceLayer` | `'infrastructure'` |                                                             |
| `minZoom`     | `16`               | The props are under 2 m tall                                |
| `maxPerKind`  | `1500`             | Nearest drawn per kind                                      |
| `kinds`       | all                | Subset of `PROP_KINDS`, e.g. `['bench', 'bollard']`         |
| `farCutoff`   | `true`             | Pitched views draw props only to about three screen heights |
| `areas`       | `true`             | Fountain basins, platforms and pier decks                   |
| `onError`     | —                  |                                                             |

Methods: `getStats()` (`total`, `byKind`, `areas`).
