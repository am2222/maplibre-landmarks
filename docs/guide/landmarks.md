# Landmarks

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

## Options

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


## Label occlusion

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
