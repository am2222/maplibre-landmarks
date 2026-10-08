# Getting started

## Install

```sh
npm install maplibre-landmarks maplibre-gl three
```

`maplibre-gl` (6.13 or newer) and `three` (0.186 or newer) are peer dependencies: your app brings
its own copies. Every layer is a MapLibre custom layer; import only the ones you use (the package
is tree-shakable).

## First map

```ts
import { Map } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { LandmarksLayer, setTheme } from 'maplibre-landmarks';

const map = new Map({ container: 'map', style: 'https://…/style.json', center: [2.2945, 48.8584], zoom: 16, pitch: 60 });

map.on('load', () => {
  map.addLayer(
    new LandmarksLayer({ id: 'landmarks', replaceBuildings: ['buildings'] }),
    'pois', // below the labels
  );
  setTheme(map, 'day'); // day | dawn | dusk | night: lights and palettes for every layer
});
```

## Without a bundler

The package is a single ES module. Map `maplibre-gl` and `three` with an import map:

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/maplibre-gl@6.13.0/dist/maplibre-gl.css" />
<script type="importmap">
  {
    "imports": {
      "maplibre-gl": "https://cdn.jsdelivr.net/npm/maplibre-gl@6.13.0/+esm",
      "three": "https://cdn.jsdelivr.net/npm/three@0.186.0/build/three.module.js",
      "maplibre-landmarks": "https://cdn.jsdelivr.net/npm/maplibre-landmarks/+esm"
    }
  }
</script>
<script type="module">
  import { Map } from 'maplibre-gl';
  import { LandmarksLayer } from 'maplibre-landmarks';
</script>
```

## The layers

| Layer            | What it draws                                         | Guide                                 |
| ---------------- | ----------------------------------------------------- | ------------------------------------- |
| `LandmarksLayer` | Open Landmarks 3D models in place of basemap buildings | [Landmarks](./landmarks)              |
| `RoofsLayer`     | Real roof shapes on your `fill-extrusion` buildings    | [Roof shapes](./roofs)                |
| `TreesLayer`     | Instanced trees from the basemap's landcover           | [Trees](./trees)                      |
| `FogLayer`       | Drifting ground and valley fog                         | [Volumetric fog](./fog)               |
| `WaterLayer`     | Animated, lit water over the basemap's water           | [Water](./water)                      |
| `LabelOcclusion` | Hides labels behind 3D content                         | [Landmarks](./landmarks#label-occlusion) |

## Attribution and licences

Open Landmarks models are **CC BY 4.0** (artistic contributions) and contain OpenStreetMap-derived
data under **ODbL 1.0**; some models include other sources (e.g. IGN LiDAR HD, Licence Ouverte 2.0).
The layer adds the required attribution to MapLibre's attribution control automatically and exposes
it via `getAttribution()`. See https://open-landmarks.benmaps.fr/licenses/.

This library is MIT licensed. It is not affiliated with Open Landmarks or benmaps.fr.
