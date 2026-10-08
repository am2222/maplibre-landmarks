# Volumetric fog

`FogLayer` fills the low air with drifting ground fog that wraps around buildings, roofs,
landmarks and trees, tinted by the theme and glowing toward the sun:

```ts
import { FogLayer } from 'maplibre-landmarks';

map.addLayer(new FogLayer({ id: 'fog' }), firstSymbolLayerId); // after the other 3D layers
```

| Option        | Default                        | Description                                                             |
| ------------- | ------------------------------ | ----------------------------------------------------------------------- |
| `density`     | `0.6`                          | Thickness (`setDensity` to change live)                                 |
| `height`      | `40`                           | Fog thickness above the ground (or the valley floor with terrain)       |
| `altitude`    | —                              | With terrain: absolute fog top in metres (overrides `height`)           |
| `coverage`    | `0.65`                         | 0–1: scattered banks to a full blanket (`setCoverage`)                  |
| `wind`        | `{ speed: 2, direction: 270 }` | m/s and bearing it drifts toward (`setWind`)                            |
| `slices`      | `32`                           | 8–64; more is smoother and costs fill rate                              |
| `radius`      | auto                           | Metres around the map centre that get fog (default grows with the view) |
| `color`       | theme                          | CSS colour override                                                     |
| `horizonHaze` | `true`                         | Also tint MapLibre's sky fog toward the horizon                         |
| `minZoom`     | `12`                           | Below this zoom nothing is drawn                                        |

The fog is drawn as camera-facing slices tested against the depth buffer, so buildings and
mountains hide the fog behind them. On flat maps it lies on the ground; with terrain it pools in
the valleys up to `height` above the lowest ground near the centre (or up to `altitude`), with
ridges and peaks rising out of it. It never covers labels. `setHeight`, `setAltitude`,
`setDensity`, `setCoverage` and `setWind` change it live.
