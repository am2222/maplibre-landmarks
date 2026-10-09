# Snow

`SnowLayer` lets it snow: soft flakes swaying down around the camera, a pale haze over the scene,
lighter grey snow clouds in the sky, and snow that settles on the tops of roofs.

```ts
import { SnowLayer } from 'maplibre-landmarks';

// After the other 3D layers (and after a FogLayer), right under the labels.
map.addLayer(new SnowLayer({ id: 'snow', intensity: 0.8 }), firstSymbolLayerId);
```

<DemoFrame src="/demo/?snow=0.8&panel=0#16.37/48.858435/2.294978/88.8/84" title="Snow over Paris" />

| Option        | Default                                | Description                                                               |
| ------------- | -------------------------------------- | ------------------------------------------------------------------------- |
| `intensity`   | `0.6`                                  | 0 (a few flakes) to 1 (heavy snowfall): flakes, opacity and haze          |
| `wind`        | `{ strength: 0.3, directionDeg: 250 }` | Drifts the flakes (1 ≈ 40°); the direction the wind blows from            |
| `haze`        | `0.25`                                 | How far the scene fades toward the snow haze at full intensity            |
| `overcastSky` | `true`                                 | Grey MapLibre's sky with snow clouds (restored when the layer is removed) |
| `settle`      | `40`                                   | Seconds for snow to build up on roofs; `0` at once, `false` never         |
| `maxFlakes`   | `20000`                                | Flakes at full intensity                                                  |
| `minZoom`     | `10`                                   | Below this zoom no flakes or haze are drawn (the sky stays overcast)      |

Methods: `setIntensity(intensity)`, `setWind(wind)` and `getStats()` (`flakes`, and `cover`: how
much snow lies on roofs now, 0–1).

## How it works

- **Flakes** fall slowly in a box between the camera and the ground it looks at, each swaying on
  its own. They keep their size on screen at every zoom, stay put as the map pans, and buildings
  hide the flakes behind them.
- **Haze** is one full-screen pass that fades everything under the layer toward a pale snow colour
  (bluish at night). Labels are drawn after it, so they stay sharp.
- **Settling**: the layer tells the map's shared renderer how much snow lies around, building up
  to `intensity` over `settle` seconds. `RoofsLayer` roofs turn white where they face up, while
  steep faces stay clear. When the snow stops (`setIntensity(0)`), it melts away as slowly. When
  the layer is removed, it is gone at once.

The basemap's ground and MapLibre's own flat-roofed extrusions don't change. Only roofs drawn by
a `RoofsLayer` collect snow.
