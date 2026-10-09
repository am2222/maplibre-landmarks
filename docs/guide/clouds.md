# Volumetric clouds

`CloudsLayer` hangs a deck of puffy clouds over the map. They drift with the wind, are lit by the
theme's sun, and cast soft shadows that move across the streets and buildings below.

```ts
import { CloudsLayer } from 'maplibre-landmarks';

// After the other 3D layers, so the shadows fall on them.
map.addLayer(new CloudsLayer({ id: 'clouds', coverage: 0.5 }), firstSymbolLayerId);
```

<DemoFrame src="/demo/?clouds=0.5&panel=0#16.37/48.858435/2.294978/88.8/84" title="Clouds over Paris" />

| Option      | Default                              | Description                                                     |
| ----------- | ------------------------------------ | --------------------------------------------------------------- |
| `coverage`  | `0.45`                               | 0 (clear sky) to 1 (overcast)                                   |
| `density`   | `1`                                  | How thick the clouds look                                       |
| `base`      | `1500`                               | Cloud base, metres above the ground under the map centre       |
| `thickness` | `900`                                | Depth of the cloud deck, metres                                 |
| `wind`      | `{ speed: 8, directionDeg: 250 }`    | m/s, and the direction the wind blows from                      |
| `flyThrough` | `true` | Zooming out flies up through the clouds; `false` fades them out before the camera reaches them |
| `shadows`   | `0.35`                               | Shadow darkness 0–1; `false` for none                           |
| `steps`     | `16`                                 | Ray-march steps through the deck (4–32): smoother but costlier  |
| `radius`    | `60000`                              | Metres around the camera that have clouds                       |
| `minZoom`   | `9`                                  | Below this zoom nothing is drawn                                |

Methods: `setCoverage(coverage)`, `setDensity(density)`, `setAltitude(base, thickness?)`,
`setWind(wind)` and `setShadows(shadows)`.

## How it works

- **The deck** is ray-marched: every sky pixel steps through the layer of air between `base` and
  `base + thickness`, sampling noise anchored to the map (the clouds stay put as you pan, and drift
  only with the wind). Each step is lit by one sample toward the sun, so cloud tops glow and
  undersides are shaded. Clouds are brighter looking toward the sun.
- **Flying through.** Zooming out takes the camera up through the deck: from above, the clouds
  and their shadows drift over the map. Around the crossing (zoom 13.5–14.5 with the default
  height) the view goes milky, as inside a real cloud. With `flyThrough: false` the deck fades
  away as the camera nears it instead, leaving only the shadows.
- **Shadows** look up from the ground toward the sun through the same noise. They are drawn over
  everything under the layer in screen space, so 3D buildings darken with the ground around them.
  On terrain they are cast onto a flat ground at the map centre's height, so they slide a little on
  slopes.
- **Depth**: towers and mountains in front of the clouds hide them.

Clouds are ray-marched per pixel and are the most expensive layer here: lower `steps` on weak GPUs.
