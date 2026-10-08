# Volumetric Fog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `FogLayer` drawing drifting, theme-tinted ground fog that wraps around buildings and 3D models.

**Architecture:** N camera-facing quads at geometric distances (far to near, one draw call, depth-tested, no depth writes). Each fragment evaluates world-anchored, wind-scrolled 3D noise times an exponential height falloff and blends one slice of fog. A `FogModule` on the shared `ThreeCore` updates camera uniforms in the mesh's `onBeforeRender`, follows the theme, and optionally tints MapLibre's sky fog.

**Tech Stack:** TypeScript 6, three 0.186 (`ShaderMaterial`, GLSL with three's `colorspace_fragment`), MapLibre GL JS 6.13 (`getSky`/`setSky`), vitest 5, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-08-volumetric-fog-design.md`

## Global Constraints

- Work only in the worktree `/Users/majid/maplibre-landmarks-fog` (branch `feat/volumetric-fog`). **No commits** (user's global rule); leave changes in the worktree.
- Options and defaults: `density 0.6`, `height 30` m, `wind { speed: 2, direction: 270 }`, `slices 32` (clamped 8..64), `radius 1500` m, `color` (CSS, overrides theme), `horizonHaze true`, `minZoom 12`.
- Theme fog colours: day `#dfe5ea`, dawn `#efd4c4`, dusk `#a79cba`, night `#4e5873`.
- Noise period 4096 m horizontally; base cell 128 m; extinction `density × 0.004 /m`; nothing drawn above `6 × height`; fade between `0.75 × radius` and `radius`.
- Haze values: `fog-ground-blend 0.4`, `horizon-fog-blend 0.6`; restore only if still ours.
- Browser tests in the worktree run with a scratch Playwright config on port 5181 (the shared config reuses port 5179, which serves the main checkout).
- Checks: `npx tsc --noEmit`, `npx vitest run`, `npm run lint`, `npm run build`, Playwright via the scratch config.

## Review Focus

- **Low pitch / looking at the horizon:** slices must still cover the screen (off-centre projection), no edge-on banding. Covered by camera-facing quads with a 1.25 coverage margin; the browser test views at pitch 50.
- **Long sessions:** time and wind scroll must not lose float precision (wrapped in JS). Tested in Task 3 (`frame` wraps).
- **Panning across the 4096 m wrap:** noise must not jump (periodic noise + wrapped origin). Tested in Task 1 (`noiseOrigin`) and by the periodic hash in the shader (reviewed).
- **Theme switch while fog is on:** colour and haze follow. Tested in Task 3.
- **App changes the sky while fog is on:** removal must not overwrite it. Tested in Task 2.

---

### Task 1: Slice math, geometry and colours

**Files:**
- Create: `src/fog/slices.ts`, `src/fog/colors.ts`
- Test: `tests/unit/fogSlices.test.ts`

**Interfaces:**
- Produces: `MAX_SLICES = 64`; `NOISE_PERIOD_M = 4096`; `sliceDistances(cameraToCentre: number, radius: number, count: number): number[]` (nearest first); `buildSliceGeometry(count: number): BufferGeometry` (attributes `aCorner` (2), `aSlice` (1), dummy `position` (3); index far-first); `interface CameraBasis { position: Vector3; right: Vector3; up: Vector3; forward: Vector3; tanX: number; tanY: number }`; `cameraBasis(matrixWorld: Matrix4, projection: Matrix4): CameraBasis`; `noiseOrigin(origin: Origin): [number, number]`; `FOG_COLORS: Record<Theme, string>`; `fogColor(theme: Theme, override?: string): string`.

- [ ] **Step 1: Write the failing test**

`tests/unit/fogSlices.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Matrix4, PerspectiveCamera, Vector3 } from 'three';
import { fogColor, FOG_COLORS } from '../../src/fog/colors';
import {
  buildSliceGeometry,
  cameraBasis,
  noiseOrigin,
  NOISE_PERIOD_M,
  sliceDistances,
} from '../../src/fog/slices';

describe('fog slices', () => {
  it('spaces slices geometrically from near to far around the centre', () => {
    const d = sliceDistances(1000, 1500, 8);
    expect(d).toHaveLength(8);
    expect(d[0]).toBe(1);
    expect(d.at(-1)).toBeCloseTo(2500, 6);
    for (let i = 1; i < d.length; i++) expect(d[i]! / d[i - 1]!).toBeCloseTo(d[1]! / d[0]!, 9);
    expect(sliceDistances(5000, 1500, 4)[0]).toBe(3500);
  });

  it('builds one quad per slice, drawn far first', () => {
    const g = buildSliceGeometry(3);
    expect(g.getAttribute('aCorner').count).toBe(12);
    expect(g.getAttribute('aSlice').count).toBe(12);
    const index = Array.from(g.getIndex()!.array);
    expect(index).toHaveLength(18);
    const slice = g.getAttribute('aSlice');
    expect(slice.getX(index[0]!)).toBe(2);
    expect(slice.getX(index.at(-1)!)).toBe(0);
  });

  it('reads a unit camera basis and field of view from scaled matrices', () => {
    const cam = new PerspectiveCamera(60, 2, 1, 1000);
    cam.position.set(10, 20, 30);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    const scaled = cam.matrixWorld.clone().multiply(new Matrix4().makeScale(3, 3, 3));
    const b = cameraBasis(scaled, cam.projectionMatrix);
    expect(b.position.toArray()).toEqual([10, 20, 30]);
    expect(b.forward.length()).toBeCloseTo(1, 9);
    expect(b.forward.dot(new Vector3(-10, -20, -30).normalize())).toBeCloseTo(1, 9);
    expect(b.right.dot(b.forward)).toBeCloseTo(0, 9);
    expect(b.tanY).toBeCloseTo(Math.tan(Math.PI / 6), 9);
    expect(b.tanX).toBeCloseTo(2 * Math.tan(Math.PI / 6), 9);
  });

  it('wraps the noise origin to the noise period in metres', () => {
    const scale = 1 / 40075016;
    const [x, z] = noiseOrigin({ x: (5 * NOISE_PERIOD_M + 100) * scale, y: (3 * NOISE_PERIOD_M + 7) * scale, scale });
    expect(x).toBeCloseTo(100, 3);
    expect(z).toBeCloseTo(7, 3);
  });

  it('uses the theme colour unless overridden', () => {
    expect(fogColor('night')).toBe(FOG_COLORS.night);
    expect(fogColor('day', 'red')).toBe('#ff0000');
    expect(fogColor('day', 'not a colour')).toBe(FOG_COLORS.day);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/fogSlices.test.ts`
Expected: FAIL, cannot resolve `../../src/fog/colors`.

- [ ] **Step 3: Create `src/fog/colors.ts`**

```ts
import type { Theme } from '../core/theme';
import { parseColor } from '../roofs/colors';

/** Fog colour per theme (sRGB). */
export const FOG_COLORS: Record<Theme, string> = {
  day: '#dfe5ea',
  dawn: '#efd4c4',
  dusk: '#a79cba',
  night: '#4e5873',
};

/** The theme's fog colour, or a parseable CSS override. */
export function fogColor(theme: Theme, override?: string): string {
  return parseColor(override) ?? FOG_COLORS[theme];
}
```

- [ ] **Step 4: Create `src/fog/slices.ts`**

```ts
import { BufferGeometry, Float32BufferAttribute, Vector3, type Matrix4 } from 'three';
import type { Origin } from '../core/types';

export const MAX_SLICES = 64;
/** Horizontal period of the fog noise, metres (the noise tiles at exactly this period). */
export const NOISE_PERIOD_M = 4096;

/** Geometric slice distances (nearest first) covering the fog around the map centre. */
export function sliceDistances(cameraToCentre: number, radius: number, count: number): number[] {
  const near = Math.max(1, cameraToCentre - radius);
  const far = Math.max(near + 1, cameraToCentre + radius);
  const ratio = far / near;
  return Array.from({ length: count }, (_, i) => near * ratio ** (count > 1 ? i / (count - 1) : 0));
}

/** `count` unit quads (corners ±1) tagged with their slice; indices draw the far slice first. */
export function buildSliceGeometry(count: number): BufferGeometry {
  const corners: number[] = [];
  const slices: number[] = [];
  for (let s = 0; s < count; s++) {
    corners.push(-1, -1, 1, -1, 1, 1, -1, 1);
    slices.push(s, s, s, s);
  }
  const index: number[] = [];
  for (let s = count - 1; s >= 0; s--) {
    const b = s * 4;
    index.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const g = new BufferGeometry();
  g.setAttribute('aCorner', new Float32BufferAttribute(corners, 2));
  g.setAttribute('aSlice', new Float32BufferAttribute(slices, 1));
  // three sizes draws from `position`; the shader ignores it.
  g.setAttribute('position', new Float32BufferAttribute(new Array(count * 12).fill(0), 3));
  g.setIndex(index);
  return g;
}

export interface CameraBasis {
  position: Vector3;
  right: Vector3;
  up: Vector3;
  forward: Vector3;
  /** Tangents of the half field of view. */
  tanX: number;
  tanY: number;
}

/** Camera position and unit axes (its world matrix may carry a uniform scale). */
export function cameraBasis(matrixWorld: Matrix4, projection: Matrix4): CameraBasis {
  const e = matrixWorld.elements;
  const p = projection.elements;
  return {
    position: new Vector3(e[12], e[13], e[14]),
    right: new Vector3(e[0], e[1], e[2]).normalize(),
    up: new Vector3(e[4], e[5], e[6]).normalize(),
    forward: new Vector3(-e[8], -e[9], -e[10]).normalize(),
    tanX: 1 / p[0]!,
    tanY: 1 / p[5]!,
  };
}

/** The map origin in metres, wrapped to the noise period (float64, before reaching the GPU). */
export function noiseOrigin(origin: Origin): [number, number] {
  const wrap = (m: number) => ((m % NOISE_PERIOD_M) + NOISE_PERIOD_M) % NOISE_PERIOD_M;
  return [wrap(origin.x / origin.scale), wrap(origin.y / origin.scale)];
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx tsc --noEmit && npx vitest run tests/unit/fogSlices.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Format, leave uncommitted**

Run: `npx prettier --write src/fog tests/unit/fogSlices.test.ts`

---

### Task 2: Horizon haze

**Files:**
- Create: `src/fog/haze.ts`
- Test: `tests/unit/fogHaze.test.ts`

**Interfaces:**
- Consumes: `sameValue` (`src/core/expressions`).
- Produces: `type SkyMap = Pick<MlMap, 'getSky' | 'setSky'>`; `class Haze { constructor(map: SkyMap); apply(color: string): void; restore(): void; reset(): void }`.

- [ ] **Step 1: Write the failing test**

`tests/unit/fogHaze.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { Haze, type SkyMap } from '../../src/fog/haze';

function fakeMap(sky?: object) {
  const map = {
    sky: sky as object | undefined,
    getSky: () => map.sky,
    setSky: vi.fn((s?: object) => (map.sky = s)),
  };
  return map;
}
const asSky = (m: ReturnType<typeof fakeMap>) => m as unknown as SkyMap;

describe('Haze', () => {
  it('tints the sky fog and restores the previous sky', () => {
    const map = fakeMap({ 'sky-color': '#88aaff' });
    const haze = new Haze(asSky(map));
    haze.apply('#dfe5ea');
    expect(map.sky).toEqual({
      'sky-color': '#88aaff',
      'fog-color': '#dfe5ea',
      'fog-ground-blend': 0.4,
      'horizon-fog-blend': 0.6,
    });
    haze.apply('#4e5873'); // theme change
    expect(map.sky).toMatchObject({ 'sky-color': '#88aaff', 'fog-color': '#4e5873' });
    haze.restore();
    expect(map.sky).toEqual({ 'sky-color': '#88aaff' });
  });

  it('leaves a sky the app changed meanwhile', () => {
    const map = fakeMap();
    const haze = new Haze(asSky(map));
    haze.apply('#dfe5ea');
    map.sky = { 'fog-color': '#000000' };
    map.setSky.mockClear();
    haze.restore();
    expect(map.setSky).not.toHaveBeenCalled();
  });

  it('builds on a sky the app changed before the next tint, and reset forgets', () => {
    const map = fakeMap();
    const haze = new Haze(asSky(map));
    haze.apply('#dfe5ea');
    map.sky = { 'sky-color': '#123456' };
    haze.apply('#efd4c4');
    expect(map.sky).toMatchObject({ 'sky-color': '#123456', 'fog-color': '#efd4c4' });
    map.setSky.mockClear();
    haze.reset();
    haze.restore();
    expect(map.setSky).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/fogHaze.test.ts`
Expected: FAIL, cannot resolve `../../src/fog/haze`.

- [ ] **Step 3: Create `src/fog/haze.ts`**

```ts
import type { Map as MlMap, SkySpecification } from 'maplibre-gl';
import { sameValue } from '../core/expressions';

export type SkyMap = Pick<MlMap, 'getSky' | 'setSky'>;

const BLEND = { 'fog-ground-blend': 0.4, 'horizon-fog-blend': 0.6 };

/** Tints MapLibre's sky fog toward the horizon; restores the sky only if it is still ours. */
export class Haze {
  private original?: SkySpecification;
  private applied?: SkySpecification;

  constructor(private readonly map: SkyMap) {}

  apply(color: string): void {
    const current = this.map.getSky() ?? undefined;
    // First tint, or the app changed the sky since ours: that sky becomes the base.
    if (!this.applied || !sameValue(current ?? {}, this.applied)) this.original = current;
    const next = { ...(this.original ?? {}), 'fog-color': color, ...BLEND } as SkySpecification;
    this.map.setSky(next);
    this.applied = next;
  }

  restore(): void {
    if (this.applied && sameValue(this.map.getSky() ?? {}, this.applied)) {
      this.map.setSky(this.original);
    }
    this.applied = undefined;
  }

  /** Forget after a style swap without touching the (new) style. */
  reset(): void {
    this.applied = undefined;
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx tsc --noEmit && npx vitest run tests/unit/fogHaze.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Format, leave uncommitted**

Run: `npx prettier --write src/fog tests/unit/fogHaze.test.ts`

---

### Task 3: Shaders, `FogModule` and `FogLayer`

**Files:**
- Create: `src/fog/shaders.ts`, `src/fog/FogModule.ts`, `src/fog/FogLayer.ts`
- Modify: `src/index.ts`
- Test: `tests/unit/fogModule.test.ts`

**Interfaces:**
- Consumes: Task 1 and 2 exports; `THEMES`, `Theme` (`src/core/theme`); `LayerModule`, `ModuleContext`; `ModuleLayer`, `ModuleLayerOptions`; `bearingVector` (`src/roofs/geometry/frame`).
- Produces: `FOG_VERTEX`, `FOG_FRAGMENT` (strings); `interface FogWind { speed?: number; direction?: number }`; `interface FogOptions { density?: number; height?: number; wind?: FogWind; slices?: number; radius?: number; color?: string; horizonHaze?: boolean; minZoom?: number }`; `class FogModule implements LayerModule { constructor(options?: FogOptions); setDensity(density: number): void; setWind(wind: FogWind): void; readonly uniforms: FogUniforms; readonly mesh?: Mesh }`; `interface FogLayerOptions extends FogOptions, ModuleLayerOptions { id: string }`; `class FogLayer extends ModuleLayer { setDensity(d: number): void; setWind(w: FogWind): void }`.

- [ ] **Step 1: Write the failing test**

`tests/unit/fogModule.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { Color, PerspectiveCamera, Scene } from 'three';
import type { ModuleContext } from '../../src/core/LayerModule';
import { originAt } from '../../src/core/mercator';
import { FOG_COLORS } from '../../src/fog/colors';
import { FogModule } from '../../src/fog/FogModule';
import { view } from './helpers';

function fakeMap() {
  const handlers = new Map<string, () => void>();
  const map = {
    handlers,
    sky: undefined as object | undefined,
    terrain: null as object | null,
    on: vi.fn((t: string, fn: () => void) => handlers.set(t, fn)),
    off: vi.fn((t: string) => handlers.delete(t)),
    getSky: () => map.sky,
    setSky: vi.fn((s?: object) => (map.sky = s)),
    getTerrain: () => map.terrain,
    queryTerrainElevation: () => 42,
  };
  return map;
}

function setup(options = {}) {
  const map = fakeMap();
  const scene = new Scene();
  const module = new FogModule(options);
  module.onAdd({
    map,
    scene,
    core: { theme: 'day' },
    requestRepaint: vi.fn(),
  } as unknown as ModuleContext);
  return { map, scene, module };
}
const hex = (c: Color) => `#${c.getHexString()}`;

describe('FogModule', () => {
  it('adds a depth-tested, non-depth-writing slice mesh and tints the sky', () => {
    const { map, scene, module } = setup({ slices: 100 });
    expect(scene.children).toContain(module.mesh);
    const material = module.mesh!.material as { depthWrite: boolean; depthTest: boolean; transparent: boolean };
    expect(material).toMatchObject({ depthWrite: false, depthTest: true, transparent: true });
    expect(module.mesh!.geometry.getAttribute('aSlice').count).toBe(64 * 4); // clamped
    expect(hex(module.uniforms.uFogColor.value)).toBe(FOG_COLORS.day);
    expect(map.sky).toMatchObject({ 'fog-color': FOG_COLORS.day });
  });

  it('hides below minZoom and at zero density', () => {
    const { module } = setup({ minZoom: 14 });
    module.update(view({ zoom: 13 }));
    expect(module.mesh!.visible).toBe(false);
    module.update(view({ zoom: 16 }));
    expect(module.mesh!.visible).toBe(true);
    module.setDensity(0);
    expect(module.mesh!.visible).toBe(false);
    module.setDensity(0.9);
    expect(module.uniforms.uDensity.value).toBe(0.9);
    expect(module.mesh!.visible).toBe(true);
  });

  it('animates only with wind, wrapping time and scroll', () => {
    const { module } = setup({ wind: { speed: 10, direction: 90 } });
    expect(module.frame(1000)).toBe(true);
    expect(module.frame(1100)).toBe(true);
    expect(module.uniforms.uScroll.value.x).toBeCloseTo(1, 6); // 10 m/s east for 0.1 s
    for (let t = 1100; t < 1100 + 1e6; t += 100) module.frame(t); // 1000 s later
    expect(module.uniforms.uScroll.value.x).toBeLessThan(4096);
    expect(module.uniforms.uTime.value).toBeLessThan(1e4);
    module.setWind({ speed: 0 });
    expect(module.frame(1e7)).toBe(false);
  });

  it('follows the theme and the terrain, and anchors noise to the world', () => {
    const { map, module } = setup({ horizonHaze: true });
    module.themeChanged('night');
    expect(hex(module.uniforms.uFogColor.value)).toBe(FOG_COLORS.night);
    expect(map.sky).toMatchObject({ 'fog-color': FOG_COLORS.night });
    map.terrain = {};
    map.handlers.get('terrain')!();
    module.update(view());
    expect(module.uniforms.uGround.value).toBe(42);
    module.place(originAt([2.2945, 48.8584]));
    expect(module.uniforms.uOrigin.value.x).toBeGreaterThanOrEqual(0);
    expect(module.uniforms.uOrigin.value.x).toBeLessThan(4096);
  });

  it('updates camera uniforms right before drawing', () => {
    const { module } = setup({ radius: 500, slices: 8 });
    const camera = new PerspectiveCamera(50, 1, 1, 10000);
    camera.position.set(0, 800, 600);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    module.mesh!.onBeforeRender(null as never, null as never, camera, null as never, null as never, null as never);
    expect(module.uniforms.uCamPos.value.toArray()).toEqual([0, 800, 600]);
    expect(module.uniforms.uDist.value[0]).toBeCloseTo(500, 6); // 1000 m to the centre − 500
    expect(module.uniforms.uDist.value[7]).toBeCloseTo(1500, 6);
  });

  it('removes its mesh and gives the sky back', () => {
    const { map, scene, module } = setup();
    module.onRemove();
    expect(scene.children).toHaveLength(0);
    expect(map.sky).toBeUndefined();
    expect(map.handlers.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/fogModule.test.ts`
Expected: FAIL, cannot resolve `../../src/fog/FogModule`.

- [ ] **Step 3: Create `src/fog/shaders.ts`**

```ts
/** Camera-facing slice: placed at its distance along the view axis, covering the frustum. */
export const FOG_VERTEX = /* glsl */ `
attribute vec2 aCorner;
attribute float aSlice;
uniform vec3 uCamPos;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec3 uForward;
uniform vec2 uTan;
uniform float uDist[64];
varying vec3 vWorld;
varying float vThickness;

void main() {
  int i = int(aSlice + 0.5);
  float d = uDist[i];
  vThickness = i > 0 ? d - uDist[i - 1] : uDist[1] - uDist[0];
  vec3 w = uCamPos + uForward * d
    + uRight * (aCorner.x * d * uTan.x * 1.25)
    + uUp * (aCorner.y * d * uTan.y * 1.25);
  vWorld = w;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}
`;

/** One slice of fog: height falloff × world-anchored, wind-scrolled noise, sun glow. */
export const FOG_FRAGMENT = /* glsl */ `
uniform vec3 uCamPos;
uniform vec3 uForward;
uniform vec3 uFogColor;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform vec2 uOrigin;
uniform vec2 uScroll;
uniform float uGround;
uniform float uHeight;
uniform float uDensity;
uniform float uRadius;
uniform float uTime;
varying vec3 vWorld;
varying float vThickness;

float hash(vec3 p) {
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}

// Value noise that tiles every 'period' cells horizontally.
float vnoise(vec3 p, float period) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  vec3 per = vec3(period, 1.0e5, period);
  float a = hash(mod(i, per));
  float b = hash(mod(i + vec3(1.0, 0.0, 0.0), per));
  float c = hash(mod(i + vec3(0.0, 1.0, 0.0), per));
  float d = hash(mod(i + vec3(1.0, 1.0, 0.0), per));
  float e = hash(mod(i + vec3(0.0, 0.0, 1.0), per));
  float g = hash(mod(i + vec3(1.0, 0.0, 1.0), per));
  float h = hash(mod(i + vec3(0.0, 1.0, 1.0), per));
  float k = hash(mod(i + vec3(1.0, 1.0, 1.0), per));
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, g, u.x), mix(h, k, u.x), u.y), u.z);
}

float fbm(vec3 p) {
  // 128 m cells: periods 32, 64 and 128 cells all equal 4096 m.
  return (0.5 * vnoise(p, 32.0) + 0.25 * vnoise(p * 2.0, 64.0) + 0.125 * vnoise(p * 4.0, 128.0)) / 0.875;
}

void main() {
  float h = vWorld.y - uGround;
  if (h > 6.0 * uHeight) discard;
  float heightTerm = exp(-max(h, 0.0) / uHeight);
  vec2 xz = mod(vWorld.xz + uOrigin - uScroll, 4096.0);
  float n = fbm(vec3(xz.x / 128.0, vWorld.y / 50.0 + uTime * 0.02, xz.y / 128.0));
  float fade = 1.0 - smoothstep(0.75 * uRadius, uRadius, length(vWorld.xz));
  vec3 ray = normalize(vWorld - uCamPos);
  float sigma = uDensity * 0.004 * heightTerm * mix(0.35, 1.65, n) * fade;
  float alpha = 1.0 - exp(-sigma * vThickness / max(dot(ray, uForward), 0.2));
  if (alpha < 0.002) discard;
  float glow = 0.35 * pow(max(dot(ray, uSunDir), 0.0), 6.0);
  gl_FragColor = vec4(mix(uFogColor, uSunColor, glow), alpha);
  #include <colorspace_fragment>
}
`;
```

- [ ] **Step 4: Create `src/fog/FogModule.ts`**

```ts
import {
  Color,
  Mesh,
  ShaderMaterial,
  Vector2,
  Vector3,
  type BufferGeometry,
  type Camera,
  type IUniform,
} from 'three';
import type { LayerModule, ModuleContext } from '../core/LayerModule';
import { THEMES, type Theme } from '../core/theme';
import type { Origin, ViewState } from '../core/types';
import { bearingVector } from '../roofs/geometry/frame';
import { fogColor } from './colors';
import { Haze } from './haze';
import { FOG_FRAGMENT, FOG_VERTEX } from './shaders';
import {
  buildSliceGeometry,
  cameraBasis,
  MAX_SLICES,
  NOISE_PERIOD_M,
  noiseOrigin,
  sliceDistances,
} from './slices';

export interface FogWind {
  /** Metres per second. */
  speed?: number;
  /** Compass bearing the wind blows toward, degrees. */
  direction?: number;
}

export interface FogOptions {
  density?: number;
  height?: number;
  wind?: FogWind;
  slices?: number;
  radius?: number;
  color?: string;
  horizonHaze?: boolean;
  minZoom?: number;
}

export interface FogUniforms {
  [name: string]: IUniform;
  uCamPos: IUniform<Vector3>;
  uRight: IUniform<Vector3>;
  uUp: IUniform<Vector3>;
  uForward: IUniform<Vector3>;
  uTan: IUniform<Vector2>;
  uDist: IUniform<number[]>;
  uFogColor: IUniform<Color>;
  uSunColor: IUniform<Color>;
  uSunDir: IUniform<Vector3>;
  uOrigin: IUniform<Vector2>;
  uScroll: IUniform<Vector2>;
  uGround: IUniform<number>;
  uHeight: IUniform<number>;
  uDensity: IUniform<number>;
  uRadius: IUniform<number>;
  uTime: IUniform<number>;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Drifting, theme-tinted ground fog drawn as camera-facing slices. */
export class FogModule implements LayerModule {
  readonly uniforms: FogUniforms;
  mesh?: Mesh<BufferGeometry, ShaderMaterial>;
  private ctx?: ModuleContext;
  private haze?: Haze;
  private theme: Theme = 'day';
  private density: number;
  private speed: number;
  private direction: number;
  private readonly slices: number;
  private readonly radius: number;
  private zoomOk = true;
  private lastFrame?: number;
  private lastView?: ViewState;

  constructor(private readonly options: FogOptions = {}) {
    this.density = Math.max(0, options.density ?? 0.6);
    this.speed = Math.max(0, options.wind?.speed ?? 2);
    this.direction = options.wind?.direction ?? 270;
    this.slices = clamp(Math.round(options.slices ?? 32), 8, MAX_SLICES);
    this.radius = Math.max(100, options.radius ?? 1500);
    this.uniforms = {
      uCamPos: { value: new Vector3() },
      uRight: { value: new Vector3(1, 0, 0) },
      uUp: { value: new Vector3(0, 1, 0) },
      uForward: { value: new Vector3(0, 0, -1) },
      uTan: { value: new Vector2(1, 1) },
      uDist: { value: new Array<number>(MAX_SLICES).fill(0) },
      uFogColor: { value: new Color() },
      uSunColor: { value: new Color() },
      uSunDir: { value: new Vector3(0, 1, 0) },
      uOrigin: { value: new Vector2() },
      uScroll: { value: new Vector2() },
      uGround: { value: 0 },
      uHeight: { value: Math.max(1, options.height ?? 30) },
      uDensity: { value: this.density },
      uRadius: { value: this.radius },
      uTime: { value: 0 },
    };
  }

  onAdd(ctx: ModuleContext): void {
    this.ctx = ctx;
    const material = new ShaderMaterial({
      vertexShader: FOG_VERTEX,
      fragmentShader: FOG_FRAGMENT,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      depthTest: true,
    });
    const mesh = new Mesh(buildSliceGeometry(this.slices), material);
    mesh.frustumCulled = false;
    mesh.onBeforeRender = (_renderer, _scene, camera) => this.updateCamera(camera);
    this.mesh = mesh;
    ctx.scene.add(mesh);
    if (this.options.horizonHaze ?? true) this.haze = new Haze(ctx.map);
    this.themeChanged((ctx.core as { theme?: Theme }).theme ?? 'day');
    ctx.map.on('terrain', this.onTerrain);
    this.applyVisibility();
  }

  update(view: ViewState): void {
    this.lastView = view;
    this.zoomOk = view.zoom >= (this.options.minZoom ?? 12);
    this.updateGround();
    this.applyVisibility();
  }

  place(origin: Origin): void {
    const [x, z] = noiseOrigin(origin);
    this.uniforms.uOrigin.value.set(x, z);
  }

  frame(timeMs: number): boolean {
    const dt = this.lastFrame === undefined ? 0 : Math.min(0.1, (timeMs - this.lastFrame) / 1000);
    this.lastFrame = timeMs;
    const [wx, wz] = bearingVector(this.direction);
    const scroll = this.uniforms.uScroll.value;
    const wrap = (v: number) => ((v % NOISE_PERIOD_M) + NOISE_PERIOD_M) % NOISE_PERIOD_M;
    scroll.set(wrap(scroll.x + wx * this.speed * dt), wrap(scroll.y + wz * this.speed * dt));
    this.uniforms.uTime.value = (this.uniforms.uTime.value + dt) % 1e4;
    return this.speed > 0 && !!this.mesh?.visible;
  }

  themeChanged(theme: Theme): void {
    this.theme = theme;
    const color = fogColor(theme, this.options.color);
    const t = THEMES[theme];
    this.uniforms.uFogColor.value.set(color);
    this.uniforms.uSunColor.value.setHex(t.sunColor);
    this.uniforms.uSunDir.value.set(...t.sunDir).normalize();
    this.haze?.apply(color);
    this.ctx?.requestRepaint();
  }

  styleChanged(attached: boolean): void {
    this.haze?.reset();
    if (attached) this.haze?.apply(fogColor(this.theme, this.options.color));
  }

  setDensity(density: number): void {
    this.density = Math.max(0, density);
    this.uniforms.uDensity.value = this.density;
    this.applyVisibility();
    this.ctx?.requestRepaint();
  }

  setWind(wind: FogWind): void {
    if (wind.speed !== undefined) this.speed = Math.max(0, wind.speed);
    if (wind.direction !== undefined) this.direction = wind.direction;
    this.ctx?.requestRepaint();
  }

  onRemove(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.map.off('terrain', this.onTerrain);
    if (this.mesh) {
      ctx.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
    }
    this.haze?.restore();
    this.mesh = undefined;
    this.ctx = undefined;
  }

  private readonly onTerrain = (): void => {
    this.updateGround();
    this.ctx?.requestRepaint();
  };

  /** Fog base: the terrain under the map centre (one height for the whole view), or 0. */
  private updateGround(): void {
    const map = this.ctx?.map;
    const center = this.lastView?.center;
    if (!map || !center) return;
    this.uniforms.uGround.value = map.getTerrain() ? (map.queryTerrainElevation(center) ?? 0) : 0;
  }

  private applyVisibility(): void {
    if (this.mesh) this.mesh.visible = this.zoomOk && this.density > 0;
  }

  /** Camera uniforms for this frame (three has just set the camera's matrices). */
  private updateCamera(camera: Camera): void {
    const b = cameraBasis(camera.matrixWorld, camera.projectionMatrix);
    const u = this.uniforms;
    u.uCamPos.value.copy(b.position);
    u.uRight.value.copy(b.right);
    u.uUp.value.copy(b.up);
    u.uForward.value.copy(b.forward);
    u.uTan.value.set(b.tanX, b.tanY);
    const toCentre = b.position.distanceTo(new Vector3(0, u.uGround.value, 0));
    const d = sliceDistances(toCentre, this.radius, this.slices);
    for (let i = 0; i < MAX_SLICES; i++) u.uDist.value[i] = d[Math.min(i, d.length - 1)]!;
  }
}
```

- [ ] **Step 5: Create `src/fog/FogLayer.ts` and export**

```ts
import { ModuleLayer, type ModuleLayerOptions } from '../core/ModuleLayer';
import { FogModule, type FogOptions, type FogWind } from './FogModule';

export interface FogLayerOptions extends FogOptions, ModuleLayerOptions {
  id: string;
}

/** Volumetric ground fog. Add it after the other 3D layers so it blends over them. */
export class FogLayer extends ModuleLayer {
  private readonly fog: FogModule;

  constructor(options: FogLayerOptions) {
    const fog = new FogModule(options);
    super(options.id, fog, { minZoom: options.minZoom ?? 12, ...options });
    this.fog = fog;
  }

  setDensity(density: number): void {
    this.fog.setDensity(density);
  }

  setWind(wind: FogWind): void {
    this.fog.setWind(wind);
  }
}
```

Append to `src/index.ts`:

```ts
export { FogLayer, type FogLayerOptions } from './fog/FogLayer';
export { FogModule, type FogOptions, type FogWind } from './fog/FogModule';
```

- [ ] **Step 6: Run it to verify it passes**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS (all, including 6 new `FogModule` tests).

- [ ] **Step 7: Format and lint, leave uncommitted**

Run: `npx prettier --write src tests/unit && npm run lint`

---

### Task 4: Browser test, demo controls, README

**Files:**
- Modify: `demo/e2e.ts` (add `window.__addFog`), `demo/index.html`, `demo/main.ts`, `README.md`
- Create: `tests/browser/fog.pw.ts`; scratch `playwright.fog.local.ts` (deleted after use)

**Interfaces:**
- Consumes: `FogLayer` (Task 3); e2e globals.
- Produces: `window.__addFog(options: object): void`.

- [ ] **Step 1: Write the failing browser test**

`tests/browser/fog.pw.ts`:

```ts
import { expect, test, type Page } from '@playwright/test';
import type {} from '../../demo/e2e';
import { findTarget } from './target';

/** Share of canvas pixels in the lower half that are clearly magenta (the test fog colour). */
const magenta = (page: Page) =>
  page.evaluate(() => {
    const src = window.__map!.getCanvas();
    const c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(src, 0, 0);
    const d = ctx.getImageData(0, c.height / 2, c.width, c.height / 2).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i]! > d[i + 1]! + 30 && d[i + 2]! > d[i + 1]! + 30) n++;
    }
    return n / (d.length / 4);
  });

test('fog compiles, tints the street level and gives the sky back', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const target = await findTarget();
  await page.goto('/e2e.html');
  await page.evaluate((t) => window.__start(t as never), target);
  await page.waitForFunction(() => window.__state.models.length > 0, null, { timeout: 45_000 });
  expect(await magenta(page)).toBeLessThan(0.001);

  await page.evaluate(() =>
    window.__addFog({ color: '#ff00ff', density: 3, height: 60, wind: { speed: 0 } }),
  );
  await page.waitForFunction(
    () =>
      (window.__map!.getSky() as Record<string, unknown> | undefined)?.['fog-color'] ===
      '#ff00ff',
  );
  await page.waitForTimeout(500);
  expect(await magenta(page)).toBeGreaterThan(0.05);

  await page.evaluate(() => window.__map!.removeLayer('fog'));
  expect(await page.evaluate(() => window.__map!.getSky()?.['fog-color'])).toBeUndefined();
  expect(errors.filter((e) => /WebGL|shader|THREE/i.test(e))).toEqual([]);
});
```

- [ ] **Step 2: Create the scratch Playwright config and run it red**

`playwright.fog.local.ts` (worktree root, deleted in Step 7):

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/browser',
  testMatch: '**/*.pw.ts',
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:5181',
    viewport: { width: 1024, height: 768 },
    launchOptions: {
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    },
  },
  webServer: {
    command: 'npx vite --config demo/vite.config.ts --port 5181',
    url: 'http://localhost:5181/e2e.html',
    reuseExistingServer: false,
  },
});
```

Run: `npx playwright test --config playwright.fog.local.ts fog`
Expected: FAIL, `window.__addFog is not a function`.

- [ ] **Step 3: Add `__addFog` to `demo/e2e.ts`**

- Add `FogLayer` to the import from `'../src/index'`.
- Add to the `Window` interface: `/** Add a fog layer (test options). */ __addFog(options: object): void;`
- Append:

```ts
window.__addFog = (options) => {
  window.__map!.addLayer(new FogLayer({ id: 'fog', minZoom: 0, ...options }));
};
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx playwright test --config playwright.fog.local.ts fog`
Expected: PASS. If the magenta share stays near 0, take a screenshot before changing thresholds: check the slice distances (camera to centre vs radius) and that the mesh is visible (zoom ≥ minZoom).

- [ ] **Step 5: Demo controls**

In `demo/index.html`, after the Trees checkbox:

```html
      <label><input type="checkbox" id="show-fog" /> Fog</label>
      <label
        >Fog density
        <input id="fog-density" type="range" min="0" max="2" step="0.05" value="0.6"
      /></label>
```

In `demo/main.ts`: add `FogLayer` to the `'../src/index'` import, and append:

```ts
let fog: FogLayer | undefined;
function addFog() {
  if (fog && map.getLayer(fog.id)) map.removeLayer(fog.id);
  fog = new FogLayer({
    id: 'fog',
    density: Number($<HTMLInputElement>('fog-density').value),
  });
  map.addLayer(fog, firstSymbol());
}
$<HTMLInputElement>('show-fog').onchange = () => {
  if (isOn('show-fog')) addFog();
  else {
    remove('fog');
    fog = undefined;
  }
};
$<HTMLInputElement>('fog-density').oninput = (e) =>
  fog?.setDensity(Number((e.target as HTMLInputElement).value));
map.on('style.load', () => {
  if (isOn('show-fog') && !map.getLayer('fog')) addFog();
});
```

- [ ] **Step 6: README**

After the "Roof shapes" section (before "## Trees"), add:

````md
### Volumetric fog

`FogLayer` fills the low air with drifting ground fog that wraps around buildings, roofs,
landmarks and trees, tinted by the theme and glowing toward the sun:

```ts
import { FogLayer } from 'maplibre-landmarks';

map.addLayer(new FogLayer({ id: 'fog' }), firstSymbolLayerId); // after the other 3D layers
```

| Option        | Default                          | Description                                          |
| ------------- | -------------------------------- | ---------------------------------------------------- |
| `density`     | `0.6`                            | Thickness (`setDensity` to change live)              |
| `height`      | `30`                             | Metres over which the fog thins out                  |
| `wind`        | `{ speed: 2, direction: 270 }`   | m/s and bearing it drifts toward (`setWind`)         |
| `slices`      | `32`                             | 8–64; more is smoother and costs fill rate           |
| `radius`      | `1500`                           | Metres around the map centre that get fog            |
| `color`       | theme                            | CSS colour override                                  |
| `horizonHaze` | `true`                           | Also tint MapLibre's sky fog toward the horizon      |
| `minZoom`     | `12`                             | Below this zoom nothing is drawn                     |

The fog is drawn as camera-facing slices tested against the depth buffer, so buildings hide
the fog behind them; it does not follow terrain shape and never covers labels.
````

- [ ] **Step 7: Full check, clean up, leave uncommitted**

Run: `npx prettier --write demo README.md tests && npx tsc --noEmit && npx vitest run && npm run lint && npm run build && npx playwright test --config playwright.fog.local.ts && rm playwright.fog.local.ts`
Expected: all green (unit, lint, build, all browser tests on port 5181), scratch config removed.
