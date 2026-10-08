# Roof shapes

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

## Every shape

<DemoFrame src="/demo/roofs-gallery.html" title="Roof shapes gallery" />

`extrusionLayer` also takes several layers (e.g. buildings and building parts in separate
source layers): each layer's own `source-layer` is read, and every one gets roofs and
shortened walls. `sourceLayer` is then only needed for layers without one.

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

**Overture's official tiles (no build step).** Each Overture release publishes worldwide
building tiles (PMTiles, z5–14) with these attributes and numeric feature ids, buildings and
building parts in separate layers. Most roof tags sit on parts, so give both wall layers:

```ts
import { addProtocol, type FillExtrusionLayerSpecification } from 'maplibre-gl';
import { Protocol } from 'pmtiles';
addProtocol('pmtiles', new Protocol().tile);

map.addSource('overture-buildings', {
  type: 'vector',
  url: 'pmtiles://https://overturemaps-extras-us-west-2.s3.amazonaws.com/tiles/2026-09-23.1/buildings.pmtiles',
});
const walls = {
  type: 'fill-extrusion',
  source: 'overture-buildings',
  minzoom: 14,
  paint: {
    'fill-extrusion-color': '#d9d4ce',
    'fill-extrusion-height': ['coalesce', ['get', 'height'], 10],
    'fill-extrusion-base': ['coalesce', ['get', 'min_height'], 0],
  },
} satisfies Omit<FillExtrusionLayerSpecification, 'id' | 'source-layer'>;
map.addLayer({
  ...walls,
  id: 'buildings-3d',
  'source-layer': 'building',
  filter: ['!=', ['get', 'has_parts'], true],
}); // outlines drawn by their parts are skipped
map.addLayer({ ...walls, id: 'building-parts-3d', 'source-layer': 'building_part' });
map.addLayer(
  new RoofsLayer({
    id: 'roofs',
    source: 'overture-buildings',
    extrusionLayer: ['buildings-3d', 'building-parts-3d'],
  }),
);
```

Tiles are large in dense cities (about 1.6 MB for a z14 tile of central Paris) and served from
Overture's US-West bucket; for production, cut your region with `pmtiles extract` and serve it
from your own CDN. Replace the release (`2026-09-23.1`) with a current one from
[Overture's docs](https://docs.overturemaps.org/examples/overture-tiles/). Data © Overture Maps
Foundation and OpenStreetMap contributors (ODbL).

**Your own tiles.** Any vector source with these attributes (or its own names mapped with
`fields`) and feature ids works; Overture keeps only 14 roof shapes and no `roof_angle`, so a
source built from raw OSM tags can draw more. See
[Roof attributes](./roof-attributes#getting-roof-data).

Full attribute and shape reference: [Roof attributes](./roof-attributes).

**OSM aliases.** `_` and `-` spellings are interchangeable. Drawn as the nearest shape:
`side_hipped` → hipped; `side_half-hipped` → half_hipped; `gabled_height_moved`,
`gabled_irregular` → saltbox; `double_saltbox`, `quadruple_saltbox` → mansard; `pitched` →
gabled; `lean_to`, `monopitch`, `shed` → skillion; `pyramid` → pyramidal; Overture's
`spherical` → dome. `flat`, `many` and unknown values get no roof. `sawtooth` draws ~8 m teeth
across the building; `roof_height` (or `roof_angle`) applies to one tooth.

Roof shapes for dome and onion, and the material colours, are derived from
[OSM Buildings](https://github.com/OSMBuildings/OSMBuildings) (BSD-2-Clause; see `LICENSE`).
