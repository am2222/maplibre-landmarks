# maplibre-landmarks: Volumetric Fog Design

Date: 2026-10-08
Status: Revision 2 approved by the user (2026-10-08); revision 1 approved by delegation (the user asked for the design to be planned and approved without
waiting; decisions below are recorded so they can be revisited)
Builds on: `2026-10-07-maplibre-landmarks-design.md` (core, modules, theme)

## 1. Goal

A `FogLayer` that fills the low air of the city with drifting, theme-tinted ground fog: thick
near street level, thinning with height, wrapping around buildings, landmark models, roofs and
trees, and glowing slightly toward the sun. It is a plugin layer like the others: opt-in,
removable, sharing the three.js core and theme.

### Decisions made (delegated)

- **Technique: view-aligned slices.** The fog is drawn as N camera-facing quads at increasing
  distance from the camera (far to near, one draw call). Each fragment computes its world
  position, evaluates fog density there and blends one slice's worth of fog. Every slice is
  depth-tested against MapLibre's depth buffer, so buildings occlude fog behind them and fog in
  front of a building correctly covers it. Rejected:
  - *Horizontal slices*: break up into visible layers when viewed edge-on (low pitch).
  - *Ray marching a box*: a custom layer cannot read MapLibre's depth buffer, so a ray cannot
    stop at a building; fog would be painted over buildings with full thickness.
  - *MapLibre's built-in sky fog only*: distance haze, not volumetric. It is kept as an
    optional complement for the horizon (`horizonHaze`).
- **Density model:** exponential height falloff above the ground (the terrain elevation at the
  map centre, or 0), modulated by animated 3D noise, faded out beyond a radius around the map
  centre.
- **Noise anchored to the world:** noise coordinates are in equator metres (mercator units ×
  the Earth's circumference): the fragment's local ground metres times the latitude factor of
  the map centre, plus the map origin, wrapped to a 4096 m period with a noise that tiles at
  exactly that period. A point keeps its noise when the centre pans in any direction, and the
  noise never jumps at the wrap.
- **Colour:** a fog colour per theme (overridable), plus a forward-scattering glow in the sun's
  colour toward the theme's sun direction.
- **No depth writes:** fog never hides labels or interferes with label occlusion probes.

### Non-goals

- Fog following terrain shape (the base is one height for the whole view).
- Shadows inside the fog, light shafts, per-light scattering.
- Fog over labels (MapLibre draws labels after all 3D content).

## 2. Public API

```ts
import { FogLayer } from 'maplibre-landmarks';

const fog = new FogLayer({
  id: 'fog',
  density: 0.6, // 0..1+ extinction scale (0.6 ≈ visibility ~ 600 m at street level)
  height: 30, // metres: e-folding height of the fog above the ground
  wind: { speed: 2, direction: 270 }, // m/s and compass bearing the wind blows toward
  slices: 32, // 8..64 quads; more is smoother and costs fill rate
  radius: 1500, // metres around the map centre where fog is drawn
  color: undefined, // CSS colour; default follows the theme
  horizonHaze: true, // also tint MapLibre's sky fog toward the horizon
  minZoom: 12,
});
map.addLayer(fog, firstSymbolLayerId); // add after the other 3D layers so it blends over them
fog.setDensity(0.9);
fog.setWind({ speed: 4, direction: 90 });
map.removeLayer('fog'); // restores the sky it changed
```

`FogLayer` is a `ModuleLayer` wrapping a `FogModule` (like `TreesLayer`). It follows the
map-wide theme (`setTheme(map, theme)`) through `themeChanged`.

## 3. Components (`src/fog/`)

### 3.1 Slices (`slices.ts`, pure)

- `sliceDistances(cameraToCentre, radius, count)`: geometric distances from
  `max(1, cameraToCentre − radius)` to `cameraToCentre + radius`, nearest first; more slices
  near the camera where detail shows.
- `buildSliceGeometry(count)`: one `BufferGeometry` with `count` quads; attributes `aCorner`
  (−1/+1 corners) and `aSlice` (slice index); indices ordered **far slice first**, so blending
  composites back to front within the single draw call.
- `cameraBasis(matrixWorld, projectionMatrix)`: camera position (local metres), unit right / up /
  forward vectors, and the tangents of the half field of view from the projection matrix. The
  core's camera has a real world matrix (split projection/view), which may carry a uniform
  scale, so vectors are normalised.
- `noiseOrigin(origin)`: the map origin in metres, wrapped to `[0, 4096)` in float64.

### 3.2 Shaders (`shaders.ts`)

- **Vertex:** world position = camera + forward·d + right·d·(x·tanX·1.25 + offX) +
  up·d·(y·tanY·1.25 + offY), where `off` is the projection's off-centre shift (map padding), for
  the slice's distance `d` (looked up from a `uDist[64]` uniform array), then three's
  `projectionMatrix * viewMatrix`. Passes world position and the slice's thickness (distance
  to the next nearer slice) to the fragment shader.
- **Fragment:**
  - Each slice stands for the ray segment from the previous (nearer) slice to itself, of length
    `thickness / max(dot(rayDir, forward), 0.2)`, with heights `ha` (near end) and `hb` (this
    slice) above `uGround`.
  - **Below ground:** flat MapLibre layers (background, fills) write no depth, so slices continue
    under street level. The segment is clipped to its part above ground (`h ≥ 0`); fully
    underground slices are discarded. Terrain and buildings stop slices with their own depth.
  - Nothing is drawn when the whole segment is above `6 × uHeight`.
  - **Exact height integral:** `∫ exp(−h / H) ds` along the segment (h is linear in s), i.e.
    `len × H × (exp(−ha/H) − exp(−hb/H)) / (hb − ha)`. Slices near the ground point can be
    hundreds of metres apart; a point sample at street level would count the densest fog for
    the whole segment and bury the ground.
  - noise: 3-octave value-noise fbm, periodic in 4096 m horizontally, of
    `(world.xz + uOrigin − scroll) / 128 m` and `world.y / 50 m`, remapped to `0.35 … 1.65`.
  - `fade` = 1 − smoothstep(0.75·radius, radius, horizontal distance from the map centre).
  - `alpha = 1 − exp(−density × 0.004 × noise × fade × integral)`; discard when `< 0.002`.
  - colour: `mix(uFogColor, uSunColor, 0.35 × pow(max(dot(rayDir, uSunDir), 0), 6))`, converted
    to the output colour space.

### 3.3 Colours (`colors.ts`)

Fog colour per theme (sRGB): day `#dfe5ea`, dawn `#efd4c4`, dusk `#b7aec8`, night `#5d6888`
(revision 2).
The `color` option overrides it for every theme.

### 3.4 Horizon haze (`haze.ts`)

With `horizonHaze`, the layer sets MapLibre's sky `fog-color` to the fog colour and
`fog-ground-blend: 0.4`, `horizon-fog-blend: 0.6`. It remembers the previous sky and, on removal,
restores it only if the sky still carries its own values (restore-if-ours, like the paint
wrappers). Theme changes update the colour.

### 3.5 `FogModule`

- `onAdd`: builds the slice mesh (`ShaderMaterial`, transparent, `depthWrite: false`,
  `depthTest: true`, normal blending, `frustumCulled = false`) and adds it to its scene; applies
  the theme and horizon haze.
- `onBeforeRender` (three hook on the mesh, where the camera matrices of this frame are set):
  computes the camera basis, the camera-to-centre distance and the slice distances, and
  updates the uniforms.
- `place(origin)`: updates `uOrigin` and the noise scale (world anchor).
- `update(view)`: below `minZoom` the mesh is hidden; ground height = terrain elevation at the
  centre when terrain is on, else 0 (refreshed on `terrain` and when terrain tiles arrive).
- `frame(time)`: advances the noise time; returns `true` (keep animating) while wind speed > 0.
- `themeChanged(theme)`: fog colour, sun colour and direction from the theme.
- `onRemove`: removes and disposes the mesh, restores the sky.

## 4. Error handling

| Situation                              | Behaviour                                         |
| -------------------------------------- | ------------------------------------------------- |
| `slices` outside 8..64                 | Clamped                                           |
| `density` ≤ 0                          | Mesh hidden (nothing drawn)                       |
| Below `minZoom`, globe transition      | Not drawn (existing `ModuleLayer` guards)         |
| Unparseable `color`                    | Theme colour used                                 |
| Sky changed by the app while fog is on | Left alone on removal (restore only if ours)      |

## 5. Testing

- **Unit (vitest):** slice distances (range, monotonic, geometric); slice geometry (counts,
  attributes, far-first index order); camera basis from a known matrix (position, unit vectors,
  tangents, with a scaled world matrix); noise origin wrap; theme colours; haze set and
  restore-if-ours; module lifecycle with a fake core (mesh added and removed, hidden below
  `minZoom` and at density 0, `frame` keeps animating only with wind, `setDensity` / `setWind` /
  theme update uniforms).
- **Browser (Playwright):** the e2e page adds a `FogLayer` over the landmark scene: the shader
  compiles (no WebGL errors), the street-level part of the canvas moves toward the fog colour
  compared with the same view without fog, and removing the layer restores the sky.


## 6. Revision 2: landscape-aware, realistic fog (approved 2026-10-08)

Revision 1 measured fog height from the ground under the map centre and discarded everything
below it. With terrain on, valleys below the centre got no fog and the fog showed as a faint
blob on the slope; from above, a thin uniform layer read as a colour filter. Revision 2 replaces
the density model (sections 3.2 and 3.5 where they conflict).

### 6.1 Fog layer with a top surface

- The fog fills everything below a **top altitude** (absolute metres), with a soft edge of
  `soft = max(8, 0.35 × height)` metres. The top billows: it rises and falls by up to `soft`
  with the noise.
- **Without terrain:** the ground plane is at 0, `top = height`, and the part of each slice's
  segment below 0 is clipped (flat MapLibre layers write no depth).
- **With terrain:** `top = altitude ?? valleyFloor + height`, where `valleyFloor` is the lowest
  terrain elevation on a 6 × 6 grid over the visible bounds (plus the centre), refreshed when the
  camera settles and when terrain tiles arrive. No clipping: terrain depth stops the slices. Fog
  pools in valleys; ridges and peaks stand out of it.
- **Exact integral:** along each slice segment the altitude is linear, so the fill
  `clamp((top − alt) / soft, 0, 1)` integrates in closed form with the antiderivative of
  `clamp(t, 0, 1)`: `F(t) = 0 (t ≤ 0), t²/2 (0 < t < 1), t − 1/2 (t ≥ 1)`; mean fill =
  `(F(tb) − F(ta)) / (tb − ta)`.

### 6.2 Banks and light

- **Coverage** (`0..1`, default `0.65`): the fbm noise is thresholded with
  `smoothstep(1 − coverage − 0.2, 1 − coverage + 0.2, n)`, giving dense banks and gaps.
- **Noise scale follows the zoom:** cell = `2^clamp(23 − zoom, 7, 10)` metres (128 m at z16, 1024 m
  at z13 and below), set when the camera settles; all cell sizes divide the 4096 m period.
- **Light:** the fog colour is brightened near its top (×1.08) and dimmed deep inside (×0.82),
  plus the forward sun glow. Theme colours are raised so fog glows at dusk and night: dusk
  `#b7aec8`, night `#5d6888` (day and dawn unchanged).
- **Radius:** default `max(1500, 1.5 × camera-to-centre distance)`, so zoomed-out mountain views
  are covered; an explicit `radius` is used as given.

### 6.3 API changes

- `height` (default `40`): fog thickness above the ground or valley floor.
- `altitude` (optional): absolute top in metres with terrain; overrides `height`.
- `coverage` (default `0.65`).
- New setters: `setHeight(m)`, `setAltitude(m | undefined)`, `setCoverage(c)`.

### 6.4 Demo

- Hillshading shown with terrain; `maxPitch: 85`.
- View buttons: **Paris** (city fog, terrain off) and **Chamonix** (terrain on, valley fog).

### 6.5 Testing

- Unit: `fogFill` (TypeScript mirror of the shader integral) against a numeric integral;
  `valleyFloor` grid minimum; module top, clip, cell, radius and setter uniforms.
- Browser: the existing fog tests still hold on flat maps; visual check of Paris and Chamonix.


## 7. Revision 3: horizontal layers with dithered depth (2026-10-08)

Camera-facing slices showed contour bands over terrain: where a slice plane cuts the ground,
pixels in front get that slice's share of fog and pixels behind get none, so every slice made a
visible step (one slice held most of the valley fog, about 12% of the distance apart).

- **Geometry:** `slices` horizontal layers (squares of `radius` around the map centre) at the
  centres of equal altitude bands from the ground (0, or the valley floor with terrain) up to
  `top + soft`. Each layer stands for its band of air: path `step / max(|ray.y|, 0.02)`. With the
  fog only where it can exist, each layer carries a few metres to a few tens of metres of fog
  height, so terrain cutting the stack makes small steps.
- **Dithered depth:** each pixel offsets its layer's altitude inside the band by interleaved
  gradient noise, moves along its ray to that altitude, and writes that point's depth
  (`gl_FragDepth`), so the remaining steps become fine grain. The fragment shader declares
  `projectionMatrix` (three only provides `viewMatrix` to fragment shaders).
- **Draw order:** layers farthest from the camera's altitude first (back to front), re-indexed
  only when the camera crosses a layer. Layers are double-sided (seen from above and below).
- Camera-facing basis, slice distances and the padding offset are no longer used by the fog
  (fog above the camera and map padding are handled by world-space layers).
