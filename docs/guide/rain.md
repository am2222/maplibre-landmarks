# Rain and thunderstorms

`RainLayer` brings rain to the map: streaks falling around the camera, an overcast sky and a
darker scene, lightning flashes with the odd bolt, and wet roofs.

```ts
import { RainLayer } from 'maplibre-landmarks';

// After the other 3D layers (and after a FogLayer), right under the labels.
map.addLayer(new RainLayer({ id: 'rain', intensity: 0.8 }), firstSymbolLayerId);
```

<DemoFrame src="/demo/?rain=0.8&panel=0#16.37/48.858435/2.294978/88.8/84" title="Rain over Paris" />

| Option        | Default                                | Description                                                              |
| ------------- | -------------------------------------- | ------------------------------------------------------------------------ |
| `intensity`   | `0.7`                                  | 0 (drizzle) to 1 (downpour): drops, streak opacity and how dark it gets  |
| `wind`        | `{ strength: 0.5, directionDeg: 250 }` | Slants the rain (1 ≈ 20°); the direction the wind blows from             |
| `lightning`   | `true`                                 | `false` for plain rain, or `{ intervalS: 10, bolts: 0.6 }`               |
| `darken`      | `0.45`                                 | How much the scene darkens under the clouds at full intensity            |
| `overcastSky` | `true`                                 | Grey MapLibre's sky (restored when the layer is removed)                 |
| `wet`         | `true`                                 | Wet roofs: darker and glossier on every `RoofsLayer` of the map          |
| `maxDrops`    | `15000`                                | Drops at full intensity                                                  |
| `minZoom`     | `10`                                   | Below this zoom no rain or flashes are drawn (the sky stays overcast)    |

Methods: `setIntensity(intensity)`, `setWind(wind)`, `setLightning(lightning)`, `strike(bolt?)`
and `getStats()` (`drops`, `strikes`, current `flash`).

## How it works

- **Rain** is a box of streaks between the camera and the ground it looks at, sized by the
  camera's distance, so it reads the same at every zoom. Drops are anchored to the ground, so
  they don't drift as the map pans, and buildings hide the rain behind them.
- **Overcast and lightning** share one full-screen pass that dims everything drawn under the
  layer and adds the flash on top. Labels are drawn after it, so they stay readable.
- **Strikes** come at random, `intervalS` apart on average, with one to three flickers each. A
  share of them (`bolts`) shows a jagged bolt to the ground ahead of the camera; the rest light
  up the clouds only. `strike()` sets one off now.
- **Wet roofs**: the layer tells the map's shared renderer how wet it is (`intensity`), and
  roofs turn darker and glossier. They dry again when the rain stops or the layer is removed.

The sky follows `setTheme`: rain clouds are grey by day and stay dark at night.
