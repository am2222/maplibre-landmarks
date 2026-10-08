# maplibre-landmarks v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a public TypeScript MapLibre GL JS plugin that renders the Open Landmarks 3D models on a Protomaps basemap, using a shared Three.js core that future tree and water modules can plug into.

**Architecture:**
- Each module is a MapLibre `CustomLayerInterface` (`ModuleLayer`) wrapping a GL-free `LayerModule`.
- One reference-counted `ThreeCore` per map owns a single `THREE.WebGLRenderer` on MapLibre's GL context. Every frame it rebases coordinates to the map center, so vertex coordinates stay small and don't jitter in float32.
- The landmarks module is split into pure, testable pieces:
  - catalogue resolution
  - z12 cell discovery
  - GLB loading and the LRU cache
  - residency, i.e. the wanted set → resident models, including LOD swaps
  - basemap building replacement
  - attribution

**Tech Stack:**
- TypeScript (strict), Vite library mode with `vite-plugin-dts`
- Vitest for unit tests (Node 22), Playwright for the browser test (Chromium/SwiftShader)
- three ≥0.170 (GLTFLoader), maplibre-gl ≥6
- `@maplibre/maplibre-gl-style-spec` (`convertFilter`)
- Demo only: `@protomaps/basemaps` and `pmtiles`

**Spec:** `docs/superpowers/specs/2026-10-07-maplibre-landmarks-design.md`

## Global Constraints

- **Never run `git commit`, `git add`, amend, merge or push.** The user commits manually. Each task ends with a **Checkpoint** step: leave the changes in the working tree and report the changed files. (This overrides the skill's default "Commit" step.)
- Node 22. ESM only (`"type": "module"`).
- Peer dependencies: `maplibre-gl >=6.0.0`, `three >=0.170.0`. Runtime dependency: `@maplibre/maplibre-gl-style-spec`. All three are external in the library build.
- MapLibre 6 has **no default export**. Use named imports (`import { Map, addProtocol, setWorkerUrl } from 'maplibre-gl'`).
- Pure modules (`core/mercator.ts`, `core/types.ts`, everything in `landmarks/` except type imports) must not import `maplibre-gl` at runtime. Use `import type` only, so unit tests run in Node.
- Open Landmarks base URL: `https://open-landmarks.benmaps.fr`. Pointers are at `/api/v1/{latest|preview}.json`. Cells return `{ schemaVersion, release, assets: Entry[] }`. A missing cell is a 404.
- glTF axes are X east / Y up / Z south, in metres. Heading is already baked into the models and is never applied.
- Defaults:
  - `channel: 'latest'`
  - `maxResident: 8`, `maxCached: 12`, `maxCacheBytes: 32 * 1024 * 1024`
  - `replacementInsetM: 1.5`
  - `lighting: 'day'`
  - debounce 150 ms
  - `DISCOVERY_MIN_ZOOM = 14`
- Licence: MIT. The README must state that models are CC BY 4.0, spatial data is ODbL 1.0, and that attribution is required.

## Review Focus

1. **Style swap (`map.setStyle`) while models are loaded.** MapLibre calls `onRemove`, and the replaced layers or sources may already be gone. Expected: no throw, no leaked filters. This is pinned in Task 6 (restore with a missing layer) and Task 8 (attribution `remove()` when `getLayer` throws).
2. **A model load that resolves after the layer was removed, or after the model stopped being wanted.** Expected: the object is never added to the scene, it is disposed, and no error is reported. Pinned in Task 5 (late resolution after abort is disposed) and Task 8 (`onRemove` before the load resolves).
3. **A footprint that is a `MultiPolygon` or has holes (courtyards).** Expected: every outer ring is inset and holes are unchanged, so courtyard buildings stay visible. Pinned in Task 6.
4. **The catalogue is unreachable (offline or CORS) and then recovers.** Expected: one `onError` with `stage: 'catalogue'`, then a successful retry on the next camera move instead of a permanently dead layer. Pinned in Task 8.
5. **A view crossing the antimeridian, or longitudes MapLibre leaves unwrapped (>180).** Expected: correct cells, no infinite loop, no crash. Pinned in Task 3.

---

## File Structure

```
package.json, tsconfig.json, vite.config.ts, eslint.config.js, .prettierrc, .prettierignore, .gitignore, LICENSE, README.md
playwright.config.ts
src/
  index.ts                     public exports
  core/
    types.ts                   LngLat, Bounds, ViewState, Origin
    mercator.ts                mercator math, originAt, localPosition, cameraMatrix
    lighting.ts                light rig + presets
    ThreeCore.ts               per-map renderer, scenes, render(); acquireCore/releaseCore
    LayerModule.ts             LayerModule + ModuleContext interfaces
    ModuleLayer.ts             CustomLayerInterface adapter, viewStateOf()
  landmarks/
    catalogue.ts               types, resolveCatalogue, parseEntry, cellUrl, HttpError
    discovery.ts               tiles, padding, cellsForView, CellIndex, selectWanted
    loader.ts                  fetchGlb, parseGlb, disposeObject, ModelCache, isAbort
    residency.ts               Residency
    replacement.ts             insetRing, footprintOf, composeFilter, BuildingReplacement
    attribution.ts             attributionText, AttributionSource
    LandmarksModule.ts         LayerModule implementation wiring the above
    LandmarksLayer.ts          public class (ModuleLayer subclass)
tests/
  unit/                        *.test.ts, helpers.ts, fixtures.ts
  fixtures/                    cell-2073-1408.json, cnit-low.glb (recorded from live API)
  browser/                     landmarks.pw.ts, target.ts
demo/
  vite.config.ts, index.html, main.ts, e2e.html, e2e.ts, styles.css
```

---

### Task 1: Scaffold and mercator math

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `eslint.config.js`, `.prettierrc`, `.prettierignore`, `.gitignore`, `LICENSE`
- Create: `src/core/types.ts`, `src/core/mercator.ts`
- Test: `tests/unit/mercator.test.ts`

**Interfaces:**
- Produces:
  - `type LngLat = [lng: number, lat: number]`
  - `type Bounds = [west: number, south: number, east: number, north: number]`
  - `interface ViewState { zoom: number; bounds: Bounds; pitch: number; bearing: number; center: LngLat }`
  - `interface Origin { x: number; y: number; scale: number }`, where `x`, `y` are mercator units and `scale` is mercator units per metre
  - `EARTH_RADIUS_M`, `mercatorX(lng)`, `mercatorY(lat)`, `mercatorUnitsPerMetre(lat)`
  - `originAt(center: LngLat): Origin`
  - `localPosition(origin: Origin, anchor: LngLat, elevationM?: number): [number, number, number]`, in glTF axes and metres
  - `cameraMatrix(mainMatrix: ArrayLike<number>, origin: Origin): Matrix4`

- [ ] **Step 1: Create the package files**

`package.json`:
```json
{
  "name": "maplibre-landmarks",
  "version": "0.1.0",
  "description": "Open Landmarks 3D models for MapLibre GL JS, rendered with Three.js",
  "type": "module",
  "license": "MIT",
  "files": ["dist"],
  "module": "./dist/maplibre-landmarks.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/maplibre-landmarks.js" }
  },
  "sideEffects": false,
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "vite --config demo/vite.config.ts",
    "build": "tsc --noEmit && vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:browser": "playwright test",
    "lint": "eslint . && prettier --check ."
  },
  "peerDependencies": {
    "maplibre-gl": ">=6.0.0",
    "three": ">=0.170.0"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vite/client", "node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "tests", "demo", "*.config.ts"]
}
```

`vite.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
import dts from 'vite-plugin-dts';

export default defineConfig({
  build: {
    lib: { entry: 'src/index.ts', formats: ['es'], fileName: 'maplibre-landmarks' },
    sourcemap: true,
    rollupOptions: {
      external: ['maplibre-gl', 'three', /^three\//, '@maplibre/maplibre-gl-style-spec'],
    },
  },
  plugins: [dts({ include: ['src'], entryRoot: 'src' })],
  test: { include: ['tests/unit/**/*.test.ts'], environment: 'node' },
});
```

`eslint.config.js`:
```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'dist-demo', 'node_modules', 'test-results', 'playwright-report'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
```

`.prettierrc`:
```json
{ "singleQuote": true, "printWidth": 100 }
```

`.prettierignore`:
```
dist
dist-demo
docs
tests/fixtures
package-lock.json
```

`.gitignore`:
```
node_modules
dist
dist-demo
test-results
playwright-report
.env.local
```

`LICENSE`: the standard MIT licence text, with the line `Copyright (c) 2026 maplibre-landmarks contributors`.

- [ ] **Step 2: Install dependencies**

Run:
```bash
npm install @maplibre/maplibre-gl-style-spec
npm install -D typescript vite vite-plugin-dts vitest @types/node three @types/three maplibre-gl eslint @eslint/js typescript-eslint prettier @playwright/test @protomaps/basemaps pmtiles
```
Expected: both commands succeed and `package.json` gains `dependencies` and `devDependencies`.

- [ ] **Step 3: Write the failing test**

`tests/unit/mercator.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { Matrix4, Vector3 } from 'three';
import {
  cameraMatrix,
  EARTH_RADIUS_M,
  localPosition,
  mercatorUnitsPerMetre,
  mercatorX,
  mercatorY,
  originAt,
} from '../../src/core/mercator';

const METRES_PER_DEG_EQUATOR = (2 * Math.PI * EARTH_RADIUS_M) / 360;

describe('mercator', () => {
  it('maps lng/lat to unit mercator', () => {
    expect(mercatorX(0)).toBeCloseTo(0.5, 12);
    expect(mercatorX(-180)).toBeCloseTo(0, 12);
    expect(mercatorY(0)).toBeCloseTo(0.5, 12);
    expect(mercatorY(60)).toBeLessThan(0.5); // north is smaller y
  });

  it('scales metres by latitude', () => {
    expect(mercatorUnitsPerMetre(60) / mercatorUnitsPerMetre(0)).toBeCloseTo(2, 6);
  });

  it('places an anchor 100 m east / north in local glTF axes', () => {
    const lat = 48.8584;
    const origin = originAt([2.2945, lat]);
    const dLng = 100 / (METRES_PER_DEG_EQUATOR * Math.cos((lat * Math.PI) / 180));
    const [ex, ey, ez] = localPosition(origin, [2.2945 + dLng, lat], 0);
    expect(ex).toBeCloseTo(100, 1);
    expect(ey).toBe(0);
    expect(Math.abs(ez)).toBeLessThan(1e-6);

    const dLat = 100 / METRES_PER_DEG_EQUATOR;
    const [, , nz] = localPosition(origin, [2.2945, lat + dLat], 0);
    expect(nz).toBeCloseTo(-100, 0); // glTF Z points south, so north is negative
    expect(localPosition(origin, [2.2945, lat], 35)[1]).toBe(35);
  });

  it('cameraMatrix maps local axes onto mercator axes around the origin', () => {
    const origin = { x: 0.25, y: 0.75, scale: 1e-6 };
    const m = cameraMatrix(new Matrix4().identity().toArray(), origin);
    const east = new Vector3(1, 0, 0).applyMatrix4(m);
    const up = new Vector3(0, 1, 0).applyMatrix4(m);
    const south = new Vector3(0, 0, 1).applyMatrix4(m);
    expect(east.toArray()).toEqual([0.25 + 1e-6, 0.75, 0]);
    expect(up.x).toBe(0.25);
    expect(up.y).toBe(0.75);
    expect(up.z).toBeCloseTo(1e-6, 15);
    expect(south.x).toBe(0.25);
    expect(south.y).toBeCloseTo(0.75 + 1e-6, 15);
    expect(south.z).toBe(0);
  });

  it('cameraMatrix pre-multiplies the MapLibre main matrix', () => {
    const main = new Matrix4().makeScale(2, 2, 2);
    const m = cameraMatrix(main.toArray(), { x: 0, y: 0, scale: 1 });
    expect(new Vector3(1, 0, 0).applyMatrix4(m).x).toBe(2);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run tests/unit/mercator.test.ts`
Expected: FAIL with "Failed to resolve import ../../src/core/mercator".

- [ ] **Step 5: Implement**

`src/core/types.ts`:
```ts
export type LngLat = [lng: number, lat: number];
export type Bounds = [west: number, south: number, east: number, north: number];

export interface ViewState {
  zoom: number;
  bounds: Bounds;
  pitch: number;
  bearing: number;
  center: LngLat;
}

/** Per-frame render origin: mercator units, and mercator units per metre at the origin. */
export interface Origin {
  x: number;
  y: number;
  scale: number;
}
```

`src/core/mercator.ts`:
```ts
import { Matrix4 } from 'three';
import type { LngLat, Origin } from './types';

export const EARTH_RADIUS_M = 6371008.8;
const EARTH_CIRCUMFERENCE_M = 2 * Math.PI * EARTH_RADIUS_M;

export function mercatorX(lng: number): number {
  return (180 + lng) / 360;
}

export function mercatorY(lat: number): number {
  return (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;
}

/** Same as MapLibre's meterInMercatorCoordinateUnits / mercatorZfromAltitude scale. */
export function mercatorUnitsPerMetre(lat: number): number {
  return 1 / (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180));
}

export function originAt([lng, lat]: LngLat): Origin {
  return { x: mercatorX(lng), y: mercatorY(lat), scale: mercatorUnitsPerMetre(lat) };
}

/** Anchor position relative to the origin, in glTF axes (X east, Y up, Z south) and metres. */
export function localPosition(
  origin: Origin,
  [lng, lat]: LngLat,
  elevationM = 0,
): [number, number, number] {
  return [
    (mercatorX(lng) - origin.x) / origin.scale,
    elevationM,
    (mercatorY(lat) - origin.y) / origin.scale,
  ];
}

/**
 * Clip-space matrix for local glTF metres around `origin`: mainMatrix × M, where M maps
 * local (x, y, z) to mercator (ox + x·s, oy + z·s, y·s). Computed in float64 so small
 * local coordinates stay precise at high zoom.
 */
export function cameraMatrix(mainMatrix: ArrayLike<number>, origin: Origin): Matrix4 {
  const s = origin.scale;
  const local = new Matrix4().set(s, 0, 0, origin.x, 0, 0, s, origin.y, 0, s, 0, 0, 0, 0, 0, 1);
  return new Matrix4().fromArray(Array.from(mainMatrix)).multiply(local);
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/unit/mercator.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Lint and typecheck**

Run: `npx tsc --noEmit && npx eslint . && npx prettier --check .`
Expected: no errors. If Prettier reports formatting, run `npx prettier --write .` and re-run.

- [ ] **Step 8: Checkpoint.** Do not commit. Report the created files to the user.

---

### Task 2: Catalogue resolution and entry parsing

**Files:**
- Create: `src/landmarks/catalogue.ts`, `tests/unit/helpers.ts`, `tests/unit/fixtures.ts`
- Create (recorded): `tests/fixtures/cell-2073-1408.json`
- Test: `tests/unit/catalogue.test.ts`

**Interfaces:**
- Consumes: `Bounds`, `LngLat` from `src/core/types.ts`
- Produces:
  - `type Channel = 'latest' | 'preview'`, `type Fetch = typeof fetch`, `type Lod = 'low' | 'detail'`
  - `interface LodRef { url: string; bytes: number; gzip?: { url: string; bytes: number } }`
  - `type Footprint = { type: 'Polygon'; coordinates: number[][][] } | { type: 'MultiPolygon'; coordinates: number[][][][] }`
  - `interface LandmarkEntry { id; revision; name?; anchor: LngLat; minZoom; detailZoom; bounds: Bounds; lods: { low: LodRef; detail: LodRef }; replacementFootprint: Footprint | null; attribution?: string }`
  - `interface Catalogue { release; bounds: Bounds; maxHeightM; zoom; template; occupied: Set<string>; attribution; baseUrl }`
  - `DEFAULT_BASE_URL`, `globalFetch: Fetch`
  - `class HttpError extends Error { status; url }`
  - `absoluteUrl(baseUrl, path)`
  - `resolveCatalogue({ baseUrl?, channel?, catalogueUrl?, fetch?, signal? }): Promise<Catalogue | null>`
  - `parseEntry(raw: unknown): LandmarkEntry | null`
  - `cellUrl(cat: Catalogue, x: number, y: number): string`
- Test helpers: `fakeFetch(routes)`, `deferred<T>()`, `flush()`, `entry(id, over?)`, `rawCell(entries)`, `view(over?)`, and constants `BASE`, `POINTER`, `CATALOGUE`

- [ ] **Step 1: Record the real cell fixture**

Run:
```bash
mkdir -p tests/fixtures
curl -sf https://open-landmarks.benmaps.fr/api/v1/preview.json
```
Use the `catalogue` path from the output to read `release`, then:
```bash
curl -sf "https://open-landmarks.benmaps.fr/api/v1/releases/<release>/index/12/2073/1408.json" -o tests/fixtures/cell-2073-1408.json
node -e "const c=require('./tests/fixtures/cell-2073-1408.json');console.log(c.assets.map(a=>a.id))"
```
Expected: an array that includes `"cnit"`; it was `['cnit','grande-arche','hyatt-regency-paris-etoile']` at design time. If cell 2073/1408 returns 404, choose any cell from `index.occupied`, save it under that name, and adjust the test below.

- [ ] **Step 2: Write the helpers and fixtures**

`tests/unit/helpers.ts`:
```ts
import type { ViewState } from '../../src/core/types';

type Route = unknown;

/** Fake fetch: JSON bodies, Uint8Array bodies, or a number for an HTTP status. Unknown URLs → 404. */
export function fakeFetch(routes: Record<string, Route>) {
  const calls: string[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!(url in routes)) return new Response('not found', { status: 404 });
    const body = routes[url];
    if (typeof body === 'number') return new Response('', { status: body });
    if (body instanceof Uint8Array) return new Response(body);
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return Object.assign(fn, { calls, routes });
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets fetch/Response/json chains settle (Node's Response.json may need several ticks). */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setTimeout(r, 0));
}

export function view(over: Partial<ViewState> = {}): ViewState {
  return {
    zoom: 16,
    pitch: 0,
    bearing: 0,
    center: [2.2945, 48.8584],
    bounds: [2.285, 48.853, 2.304, 48.864],
    ...over,
  };
}
```

`tests/unit/fixtures.ts`:
```ts
import type { LandmarkEntry } from '../../src/landmarks/catalogue';

export const BASE = 'https://ol.test';

export const POINTER = {
  schemaVersion: 1,
  channel: 'approved',
  release: 'r1',
  count: 2,
  catalogue: '/api/v1/releases/r1/catalogue.json',
};

export const CATALOGUE = {
  schemaVersion: 1,
  release: 'r1',
  bounds: [2.2, 48.8, 2.4, 48.9],
  maxHeightM: 330,
  attribution: 'Open Landmarks; © OpenStreetMap contributors',
  index: {
    zoom: 12,
    template: '/api/v1/releases/r1/index/12/{x}/{y}.json',
    occupied: ['2074/1409', '2075/1409'],
  },
};

export function entry(id: string, over: Partial<LandmarkEntry> = {}): LandmarkEntry {
  return {
    id,
    revision: `${id}-r1`,
    name: id,
    anchor: [2.2945, 48.8584],
    minZoom: 15,
    detailZoom: 17,
    bounds: [2.2935, 48.8574, 2.2955, 48.8594],
    lods: {
      low: { url: `/models/${id}/low.glb`, bytes: 100, gzip: { url: `/models/${id}/low.glb.gz`, bytes: 50 } },
      detail: {
        url: `/models/${id}/detail.glb`,
        bytes: 200,
        gzip: { url: `/models/${id}/detail.glb.gz`, bytes: 80 },
      },
    },
    replacementFootprint: null,
    attribution: `${id} attribution`,
    ...over,
  };
}

export function rawCell(entries: LandmarkEntry[]) {
  return { schemaVersion: 1, release: 'r1', assets: entries };
}
```

- [ ] **Step 3: Write the failing test**

`tests/unit/catalogue.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  absoluteUrl,
  cellUrl,
  HttpError,
  parseEntry,
  resolveCatalogue,
} from '../../src/landmarks/catalogue';
import { BASE, CATALOGUE, POINTER } from './fixtures';
import { fakeFetch } from './helpers';

const realCell = JSON.parse(
  readFileSync(new URL('../fixtures/cell-2073-1408.json', import.meta.url), 'utf8'),
) as { assets: unknown[] };

describe('resolveCatalogue', () => {
  it('follows the channel pointer to the catalogue', async () => {
    const f = fakeFetch({
      [`${BASE}/api/v1/latest.json`]: POINTER,
      [`${BASE}/api/v1/releases/r1/catalogue.json`]: CATALOGUE,
    });
    const cat = await resolveCatalogue({ baseUrl: BASE, fetch: f });
    expect(cat).not.toBeNull();
    expect(cat!.release).toBe('r1');
    expect(cat!.zoom).toBe(12);
    expect(cat!.maxHeightM).toBe(330);
    expect(cat!.occupied.has('2074/1409')).toBe(true);
    expect(cat!.baseUrl).toBe(BASE);
    expect(cat!.attribution).toContain('OpenStreetMap');
  });

  it('uses the preview channel when asked', async () => {
    const f = fakeFetch({
      [`${BASE}/api/v1/preview.json`]: POINTER,
      [`${BASE}/api/v1/releases/r1/catalogue.json`]: CATALOGUE,
    });
    await resolveCatalogue({ baseUrl: BASE, channel: 'preview', fetch: f });
    expect(f.calls[0]).toBe(`${BASE}/api/v1/preview.json`);
  });

  it('returns null when nothing is published', async () => {
    const f = fakeFetch({
      [`${BASE}/api/v1/latest.json`]: { ...POINTER, release: null, catalogue: null, count: 0 },
    });
    expect(await resolveCatalogue({ baseUrl: BASE, fetch: f })).toBeNull();
    expect(f.calls).toHaveLength(1);
  });

  it('skips the pointer when a catalogue URL is pinned', async () => {
    const f = fakeFetch({ [`${BASE}/api/v1/releases/r1/catalogue.json`]: CATALOGUE });
    const cat = await resolveCatalogue({
      baseUrl: BASE,
      catalogueUrl: '/api/v1/releases/r1/catalogue.json',
      fetch: f,
    });
    expect(cat!.release).toBe('r1');
    expect(f.calls).toEqual([`${BASE}/api/v1/releases/r1/catalogue.json`]);
  });

  it('rejects with HttpError on server errors', async () => {
    const f = fakeFetch({ [`${BASE}/api/v1/latest.json`]: 500 });
    await expect(resolveCatalogue({ baseUrl: BASE, fetch: f })).rejects.toBeInstanceOf(HttpError);
  });
});

describe('parseEntry', () => {
  it('parses every entry of a recorded live cell', () => {
    const entries = realCell.assets.map(parseEntry);
    expect(entries.every((e) => e !== null)).toBe(true);
    const cnit = entries.find((e) => e!.id === 'cnit')!;
    expect(cnit.anchor).toHaveLength(2);
    expect(cnit.bounds).toHaveLength(4);
    expect(cnit.lods.low.gzip?.url).toMatch(/low\.glb\.gz$/);
    expect(cnit.replacementFootprint?.type).toMatch(/Polygon/);
    expect(typeof cnit.revision).toBe('string');
  });

  it('rejects entries without id, revision, anchor or lods', () => {
    expect(parseEntry(null)).toBeNull();
    expect(parseEntry({ id: 'x', revision: 'r', lods: { low: { url: '/a' } } })).toBeNull();
    expect(parseEntry({ id: 'x', revision: 'r', anchor: [1, 2], lods: {} })).toBeNull();
  });

  it('falls back to the low LOD and default zooms', () => {
    const e = parseEntry({ id: 'x', revision: 'r', anchor: [1, 2], lods: { low: { url: '/a.glb' } } });
    expect(e!.lods.detail.url).toBe('/a.glb');
    expect(e!.minZoom).toBe(15);
    expect(e!.detailZoom).toBe(17);
    expect(e!.bounds).toEqual([1, 2, 1, 2]);
    expect(e!.replacementFootprint).toBeNull();
  });
});

describe('urls', () => {
  it('resolves root-relative paths against the base', () => {
    expect(absoluteUrl(BASE, '/models/a.glb')).toBe(`${BASE}/models/a.glb`);
    expect(absoluteUrl('https://x.test/', '/a')).toBe('https://x.test/a');
  });

  it('fills the cell template', async () => {
    const f = fakeFetch({
      [`${BASE}/api/v1/latest.json`]: POINTER,
      [`${BASE}/api/v1/releases/r1/catalogue.json`]: CATALOGUE,
    });
    const cat = (await resolveCatalogue({ baseUrl: BASE, fetch: f }))!;
    expect(cellUrl(cat, 2074, 1409)).toBe(`${BASE}/api/v1/releases/r1/index/12/2074/1409.json`);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run tests/unit/catalogue.test.ts`
Expected: FAIL with "Failed to resolve import ../../src/landmarks/catalogue".

- [ ] **Step 5: Implement**

`src/landmarks/catalogue.ts`:
```ts
import type { Bounds, LngLat } from '../core/types';

export type Channel = 'latest' | 'preview';
export type Fetch = typeof fetch;
export type Lod = 'low' | 'detail';

export interface LodRef {
  url: string;
  bytes: number;
  gzip?: { url: string; bytes: number };
}

export type Footprint =
  | { type: 'Polygon'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] };

export interface LandmarkEntry {
  id: string;
  revision: string;
  name?: string;
  anchor: LngLat;
  minZoom: number;
  detailZoom: number;
  bounds: Bounds;
  lods: { low: LodRef; detail: LodRef };
  replacementFootprint: Footprint | null;
  attribution?: string;
}

export interface Catalogue {
  release: string;
  bounds: Bounds;
  maxHeightM: number;
  zoom: number;
  template: string;
  occupied: Set<string>;
  attribution: string;
  baseUrl: string;
}

export const DEFAULT_BASE_URL = 'https://open-landmarks.benmaps.fr';

/** Calls the global fetch without a `this` binding problem when stored on objects. */
export const globalFetch: Fetch = (input, init) => fetch(input, init);

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
  }
}

export function absoluteUrl(baseUrl: string, path: string): string {
  return new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).href;
}

async function getJson(fetchFn: Fetch, url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetchFn(url, { signal });
  if (!res.ok) throw new HttpError(res.status, url);
  return res.json();
}

interface RawCatalogue {
  release?: string | null;
  bounds?: Bounds;
  maxHeightM?: number;
  attribution?: string;
  index?: { zoom: number; template: string; occupied: string[] };
}

export async function resolveCatalogue(opts: {
  baseUrl?: string;
  channel?: Channel;
  catalogueUrl?: string;
  fetch?: Fetch;
  signal?: AbortSignal;
}): Promise<Catalogue | null> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const fetchFn = opts.fetch ?? globalFetch;
  let url = opts.catalogueUrl;
  if (!url) {
    const pointer = (await getJson(
      fetchFn,
      absoluteUrl(baseUrl, `/api/v1/${opts.channel ?? 'latest'}.json`),
      opts.signal,
    )) as { catalogue?: string | null };
    if (!pointer.catalogue) return null;
    url = pointer.catalogue;
  }
  const raw = (await getJson(fetchFn, absoluteUrl(baseUrl, url), opts.signal)) as RawCatalogue;
  if (!raw.release || !raw.index) return null;
  return {
    release: raw.release,
    bounds: raw.bounds ?? [-180, -85.0511, 180, 85.0511],
    maxHeightM: raw.maxHeightM ?? 0,
    zoom: raw.index.zoom,
    template: raw.index.template,
    occupied: new Set(raw.index.occupied),
    attribution: raw.attribution ?? 'Open Landmarks; © OpenStreetMap contributors',
    baseUrl,
  };
}

export function cellUrl(cat: Catalogue, x: number, y: number): string {
  return absoluteUrl(cat.baseUrl, cat.template.replace('{x}', String(x)).replace('{y}', String(y)));
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPair = (v: unknown): v is LngLat => Array.isArray(v) && v.length === 2 && v.every(isNum);
const isBounds = (v: unknown): v is Bounds => Array.isArray(v) && v.length === 4 && v.every(isNum);

function parseLod(v: unknown): LodRef | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { url?: unknown; bytes?: unknown; gzip?: { url?: unknown; bytes?: unknown } };
  if (typeof o.url !== 'string') return null;
  const lod: LodRef = { url: o.url, bytes: isNum(o.bytes) ? o.bytes : 0 };
  if (o.gzip && typeof o.gzip.url === 'string') {
    lod.gzip = { url: o.gzip.url, bytes: isNum(o.gzip.bytes) ? o.gzip.bytes : 0 };
  }
  return lod;
}

function parseFootprint(v: unknown): Footprint | null {
  if (!v || typeof v !== 'object') return null;
  const g = v as { type?: unknown; coordinates?: unknown };
  if ((g.type === 'Polygon' || g.type === 'MultiPolygon') && Array.isArray(g.coordinates)) {
    return g as Footprint;
  }
  return null;
}

export function parseEntry(raw: unknown): LandmarkEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const lods = (r.lods ?? {}) as Record<string, unknown>;
  const low = parseLod(lods.low);
  const detail = parseLod(lods.detail) ?? low;
  if (typeof r.id !== 'string' || typeof r.revision !== 'string' || !isPair(r.anchor)) return null;
  if (!low || !detail) return null;
  const anchor = r.anchor;
  return {
    id: r.id,
    revision: r.revision,
    name: typeof r.name === 'string' ? r.name : undefined,
    anchor,
    minZoom: isNum(r.minZoom) ? r.minZoom : 15,
    detailZoom: isNum(r.detailZoom) ? r.detailZoom : 17,
    bounds: isBounds(r.bounds) ? r.bounds : [anchor[0], anchor[1], anchor[0], anchor[1]],
    lods: { low, detail },
    replacementFootprint: parseFootprint(r.replacementFootprint),
    attribution: typeof r.attribution === 'string' ? r.attribution : undefined,
  };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/unit/catalogue.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 7: Lint and typecheck.** Run `npx tsc --noEmit && npx eslint .`. Expected: clean.

- [ ] **Step 8: Checkpoint.** Do not commit. Report the files.

---

### Task 3: Discovery (cells, padding, wanted set)

**Files:**
- Create: `src/landmarks/discovery.ts`
- Test: `tests/unit/discovery.test.ts`

**Interfaces:**
- Consumes:
  - `Catalogue`, `LandmarkEntry`, `Lod`, `Fetch`, `parseEntry`, `cellUrl`, `HttpError` from `catalogue.ts`
  - `ViewState`, `Bounds`, `LngLat` from `core/types.ts`
- Produces:
  - `lngLatToTile(lng, lat, z): [number, number]`
  - `padMetres(pitch, maxHeightM): number`
  - `padBounds(bounds, padM): Bounds`
  - `intersectsWrapped(a: Bounds, b: Bounds): boolean`
  - `cellsForView(view: ViewState, cat: Catalogue): string[]`, sorted `"x/y"` keys
  - `distanceM(a: LngLat, b: LngLat): number`
  - `entryKey(e: LandmarkEntry): string`, in the form `` `${id}@${revision}` ``
  - `interface Wanted { key: string; entry: LandmarkEntry; lod: Lod }`
  - `selectWanted(entries, view, cat, maxResident): Wanted[]`
  - `class CellIndex { constructor(cat: Catalogue, fetchFn: Fetch); entries(cells: string[]): Promise<LandmarkEntry[]> }`

- [ ] **Step 1: Write the failing test**

`tests/unit/discovery.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { Catalogue } from '../../src/landmarks/catalogue';
import {
  CellIndex,
  cellsForView,
  distanceM,
  entryKey,
  intersectsWrapped,
  lngLatToTile,
  padMetres,
  selectWanted,
} from '../../src/landmarks/discovery';
import { BASE, entry, rawCell } from './fixtures';
import { fakeFetch, view } from './helpers';

function cat(over: Partial<Catalogue> = {}): Catalogue {
  return {
    release: 'r1',
    bounds: [2.2, 48.8, 2.4, 48.9],
    maxHeightM: 330,
    zoom: 12,
    template: '/api/v1/releases/r1/index/12/{x}/{y}.json',
    occupied: new Set(['2074/1409', '2075/1409']),
    attribution: 'Open Landmarks',
    baseUrl: BASE,
    ...over,
  };
}

describe('tiles and padding', () => {
  it('computes z12 tiles for Paris landmarks', () => {
    expect(lngLatToTile(2.2945, 48.8584, 12)).toEqual([2074, 1409]); // Eiffel Tower
    expect(lngLatToTile(2.2395, 48.8927, 12)).toEqual([2073, 1408]); // CNIT
  });

  it('pads more when pitched, capped at 5 km', () => {
    expect(padMetres(0, 330)).toBe(200);
    expect(padMetres(60, 330)).toBeCloseTo(200 + 330 * Math.tan(Math.PI / 3), 6);
    expect(padMetres(89, 1e6)).toBe(5000);
  });

  it('measures great-circle distance', () => {
    expect(distanceM([0, 0], [0, 1])).toBeCloseTo(111195, -1);
  });

  it('intersects across the antimeridian', () => {
    expect(intersectsWrapped([179, -1, 181, 1], [-180, -1, -179.5, 1])).toBe(true);
    expect(intersectsWrapped([10, 10, 11, 11], [12, 12, 13, 13])).toBe(false);
  });
});

describe('cellsForView', () => {
  it('returns occupied cells around the view', () => {
    expect(cellsForView(view(), cat())).toEqual(['2074/1409']);
  });

  it('returns nothing far from the catalogue', () => {
    expect(cellsForView(view({ bounds: [-74.02, 40.7, -73.98, 40.72], center: [-74, 40.71] }), cat())).toEqual(
      [],
    );
  });

  it('wraps x across the antimeridian with unwrapped longitudes', () => {
    const world = cat({
      bounds: [-180, -85, 180, 85],
      occupied: new Set(['4090/2047', '5/2047', '2000/2047']),
    });
    const v = view({ bounds: [179, -1, 181, 1], center: [180, 0] });
    expect(cellsForView(v, world)).toEqual(['4090/2047', '5/2047']);
  });

  it('does not loop over every cell when zoomed far out', () => {
    const v = view({ bounds: [-540, -85, 540, 85], center: [0, 0], zoom: 0 });
    const world = cat({ bounds: [-180, -85, 180, 85] });
    expect(cellsForView(v, world)).toEqual(['2074/1409', '2075/1409']);
  });
});

describe('selectWanted', () => {
  const near = entry('near');
  const far = entry('far', { anchor: [2.3, 48.86], bounds: [2.299, 48.859, 2.301, 48.861] });
  const late = entry('late', { minZoom: 18 });

  it('filters by minZoom and sorts by distance', () => {
    const wanted = selectWanted([far, late, near], view(), cat(), 8);
    expect(wanted.map((w) => w.entry.id)).toEqual(['near', 'far']);
    expect(wanted[0]!.key).toBe(entryKey(near));
    expect(wanted[0]!.lod).toBe('low');
  });

  it('caps at maxResident and picks the detail LOD at detailZoom', () => {
    const wanted = selectWanted([far, near], view({ zoom: 17 }), cat(), 1);
    expect(wanted.map((w) => w.entry.id)).toEqual(['near']);
    expect(wanted[0]!.lod).toBe('detail');
  });

  it('drops entries outside the padded view', () => {
    const away = entry('away', { anchor: [2.39, 48.89], bounds: [2.389, 48.889, 2.391, 48.891] });
    expect(selectWanted([away], view(), cat(), 8)).toEqual([]);
  });
});

describe('CellIndex', () => {
  const cellA = `${BASE}/api/v1/releases/r1/index/12/2074/1409.json`;
  const cellB = `${BASE}/api/v1/releases/r1/index/12/2075/1409.json`;

  it('merges cells and de-duplicates by id + revision', async () => {
    const shared = entry('shared');
    const f = fakeFetch({ [cellA]: rawCell([shared, entry('a')]), [cellB]: rawCell([shared]) });
    const entries = await new CellIndex(cat(), f).entries(['2074/1409', '2075/1409']);
    expect(entries.map((e) => e.id).sort()).toEqual(['a', 'shared']);
  });

  it('caches cells, including 404s', async () => {
    const f = fakeFetch({ [cellA]: rawCell([entry('a')]) });
    const index = new CellIndex(cat(), f);
    await index.entries(['2074/1409', '2075/1409']);
    await index.entries(['2074/1409', '2075/1409']);
    expect(f.calls).toHaveLength(2);
  });

  it('does not cache failures', async () => {
    const f = fakeFetch({ [cellA]: 500 });
    const index = new CellIndex(cat(), f);
    await expect(index.entries(['2074/1409'])).rejects.toThrow('HTTP 500');
    f.routes[cellA] = rawCell([entry('a')]);
    expect((await index.entries(['2074/1409'])).map((e) => e.id)).toEqual(['a']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/discovery.test.ts`
Expected: FAIL with "Failed to resolve import ../../src/landmarks/discovery".

- [ ] **Step 3: Implement**

`src/landmarks/discovery.ts`:
```ts
import { EARTH_RADIUS_M } from '../core/mercator';
import type { Bounds, LngLat, ViewState } from '../core/types';
import {
  cellUrl,
  HttpError,
  parseEntry,
  type Catalogue,
  type Fetch,
  type LandmarkEntry,
  type Lod,
} from './catalogue';

const MAX_LAT = 85.0511;
const METRES_PER_DEG = (2 * Math.PI * EARTH_RADIUS_M) / 360;

export function lngLatToTile(lng: number, lat: number, z: number): [number, number] {
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n); // not wrapped: callers wrap
  const r = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  return [x, Math.max(0, Math.min(n - 1, y))];
}

export function padMetres(pitch: number, maxHeightM: number): number {
  const p = (Math.min(pitch, 85) * Math.PI) / 180;
  return Math.min(5000, 200 + maxHeightM * Math.tan(p));
}

export function padBounds([w, s, e, n]: Bounds, padM: number): Bounds {
  const dLat = padM / METRES_PER_DEG;
  const midLat = ((s + n) / 2) * (Math.PI / 180);
  const dLng = padM / (METRES_PER_DEG * Math.max(0.01, Math.cos(midLat)));
  return [w - dLng, Math.max(-MAX_LAT, s - dLat), e + dLng, Math.min(MAX_LAT, n + dLat)];
}

function intersects(a: Bounds, b: Bounds): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/** `a` may hold unwrapped longitudes (MapLibre bounds); `b` is in [-180, 180]. */
export function intersectsWrapped(a: Bounds, b: Bounds): boolean {
  return [-360, 0, 360].some((o) => intersects(a, [b[0] + o, b[1], b[2] + o, b[3]]));
}

export function cellsForView(view: ViewState, cat: Catalogue): string[] {
  const padded = padBounds(view.bounds, padMetres(view.pitch, cat.maxHeightM));
  if (!intersectsWrapped(padded, cat.bounds)) return [];
  const n = 2 ** cat.zoom;
  const [x0, y0] = lngLatToTile(padded[0], padded[3], cat.zoom);
  const [x1, y1] = lngLatToTile(padded[2], padded[1], cat.zoom);
  const span = x1 - x0;
  const out: string[] = [];
  // Iterate the (small) occupied set instead of the view's cells.
  for (const key of cat.occupied) {
    const [xs, ys] = key.split('/');
    const x = Number(xs);
    const y = Number(ys);
    if (y < y0 || y > y1) continue;
    const dx = (((x - x0) % n) + n) % n;
    if (span >= n - 1 || dx <= span) out.push(key);
  }
  return out.sort();
}

export function distanceM([lng1, lat1]: LngLat, [lng2, lat2]: LngLat): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const entryKey = (e: LandmarkEntry): string => `${e.id}@${e.revision}`;

export interface Wanted {
  key: string;
  entry: LandmarkEntry;
  lod: Lod;
}

export function selectWanted(
  entries: LandmarkEntry[],
  view: ViewState,
  cat: Catalogue,
  maxResident: number,
): Wanted[] {
  const padded = padBounds(view.bounds, padMetres(view.pitch, cat.maxHeightM));
  return entries
    .filter((e) => view.zoom >= e.minZoom && intersectsWrapped(padded, e.bounds))
    .map((e) => ({ e, d: distanceM(view.center, e.anchor) }))
    .sort((a, b) => a.d - b.d || a.e.id.localeCompare(b.e.id))
    .slice(0, maxResident)
    .map(({ e }) => ({ key: entryKey(e), entry: e, lod: view.zoom >= e.detailZoom ? 'detail' : 'low' }));
}

export class CellIndex {
  private readonly cache = new Map<string, Promise<LandmarkEntry[]>>();

  constructor(
    private readonly cat: Catalogue,
    private readonly fetchFn: Fetch,
  ) {}

  async entries(cells: string[]): Promise<LandmarkEntry[]> {
    const lists = await Promise.all(cells.map((c) => this.cell(c)));
    const seen = new Map<string, LandmarkEntry>();
    for (const list of lists) for (const e of list) seen.set(entryKey(e), e);
    return [...seen.values()];
  }

  private cell(key: string): Promise<LandmarkEntry[]> {
    const cached = this.cache.get(key);
    if (cached) return cached;
    const [x, y] = key.split('/').map(Number) as [number, number];
    const url = cellUrl(this.cat, x, y);
    const p = this.fetchFn(url).then(async (res) => {
      if (res.status === 404) return [];
      if (!res.ok) throw new HttpError(res.status, url);
      const body = (await res.json()) as { assets?: unknown[] };
      return (body.assets ?? []).map(parseEntry).filter((e): e is LandmarkEntry => e !== null);
    });
    this.cache.set(key, p);
    p.catch(() => this.cache.delete(key));
    return p;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/discovery.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Lint and typecheck.** Run `npx tsc --noEmit && npx eslint .`. Expected: clean.

- [ ] **Step 6: Checkpoint.** Do not commit.

---

### Task 4: GLB loader and model cache

**Files:**
- Create: `src/landmarks/loader.ts`
- Create (recorded): `tests/fixtures/cnit-low.glb`
- Test: `tests/unit/loader.test.ts`

**Interfaces:**
- Consumes: `LodRef`, `Fetch`, `absoluteUrl`, `HttpError` from `catalogue.ts`
- Produces:
  - `isAbort(err: unknown): boolean`
  - `fetchGlb(lod: LodRef, baseUrl: string, fetchFn: Fetch, signal?: AbortSignal): Promise<ArrayBuffer>`
  - `parseGlb(buffer: ArrayBuffer): Promise<Object3D>`
  - `disposeObject(root: Object3D): void`
  - `interface CachedModel { object: Object3D; bytes: number }`
  - `class ModelCache { constructor(maxEntries, maxBytes, dispose?); size; bytes; take(key): CachedModel | undefined; put(key, object, bytes); dispose(object); clear() }`

- [ ] **Step 1: Record the GLB fixture**

Run:
```bash
node -e "const c=require('./tests/fixtures/cell-2073-1408.json');const a=c.assets.find(x=>x.id==='cnit');console.log(a.lods.low.url)"
curl -sf "https://open-landmarks.benmaps.fr<printed url>" -o tests/fixtures/cnit-low.glb
head -c 4 tests/fixtures/cnit-low.glb
```
Expected: the last command prints `glTF`.

- [ ] **Step 2: Write the failing test**

`tests/unit/loader.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Group, type Mesh, type Material } from 'three';
import type { LodRef } from '../../src/landmarks/catalogue';
import { HttpError } from '../../src/landmarks/catalogue';
import { disposeObject, fetchGlb, ModelCache, parseGlb } from '../../src/landmarks/loader';
import { BASE } from './fixtures';
import { fakeFetch } from './helpers';

const RAW = new Uint8Array([1, 2, 3, 4, 5]);
const lod: LodRef = { url: '/m/low.glb', bytes: 5, gzip: { url: '/m/low.glb.gz', bytes: 20 } };
const rawUrl = `${BASE}/m/low.glb`;
const gzUrl = `${BASE}/m/low.glb.gz`;

afterEach(() => vi.unstubAllGlobals());

describe('fetchGlb', () => {
  it('downloads and decompresses the gzip file', async () => {
    const f = fakeFetch({ [gzUrl]: new Uint8Array(gzipSync(RAW)) });
    const buf = await fetchGlb(lod, BASE, f);
    expect(new Uint8Array(buf)).toEqual(RAW);
    expect(f.calls).toEqual([gzUrl]);
  });

  it('falls back to the raw GLB when gzip fails', async () => {
    const f = fakeFetch({ [gzUrl]: 500, [rawUrl]: RAW });
    expect(new Uint8Array(await fetchGlb(lod, BASE, f))).toEqual(RAW);
  });

  it('falls back to the raw GLB when gzip data is corrupt', async () => {
    const f = fakeFetch({ [gzUrl]: new Uint8Array([9, 9, 9]), [rawUrl]: RAW });
    expect(new Uint8Array(await fetchGlb(lod, BASE, f))).toEqual(RAW);
  });

  it('uses the raw GLB without DecompressionStream', async () => {
    vi.stubGlobal('DecompressionStream', undefined);
    const f = fakeFetch({ [rawUrl]: RAW });
    expect(new Uint8Array(await fetchGlb(lod, BASE, f))).toEqual(RAW);
    expect(f.calls).toEqual([rawUrl]);
  });

  it('propagates aborts without falling back', async () => {
    const f = fakeFetch({ [gzUrl]: new Uint8Array(gzipSync(RAW)), [rawUrl]: RAW });
    const c = new AbortController();
    c.abort();
    await expect(fetchGlb(lod, BASE, f, c.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.calls).toEqual([gzUrl]);
  });

  it('throws HttpError when the raw GLB is missing', async () => {
    const f = fakeFetch({});
    await expect(fetchGlb({ url: '/m/low.glb', bytes: 5 }, BASE, f)).rejects.toBeInstanceOf(HttpError);
  });
});

describe('parseGlb', () => {
  it('parses a real Open Landmarks model with its own colours', async () => {
    const bytes = readFileSync(new URL('../fixtures/cnit-low.glb', import.meta.url));
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const scene = await parseGlb(buffer);
    const meshes: Mesh[] = [];
    scene.traverse((o) => {
      if ((o as Mesh).isMesh) meshes.push(o as Mesh);
    });
    expect(meshes.length).toBeGreaterThan(0);
    const names = meshes.flatMap((m) => ([] as Material[]).concat(m.material).map((x) => x.name));
    expect(names).toContain('stone');
  });
});

describe('ModelCache', () => {
  const obj = () => new Group();

  it('evicts least recently used entries over the count limit', () => {
    const dispose = vi.fn();
    const cache = new ModelCache(2, 1e9, dispose);
    const a = obj();
    cache.put('a', a, 1);
    cache.put('b', obj(), 1);
    cache.put('c', obj(), 1);
    expect(cache.size).toBe(2);
    expect(dispose).toHaveBeenCalledWith(a);
  });

  it('evicts over the byte budget', () => {
    const dispose = vi.fn();
    const cache = new ModelCache(10, 100, dispose);
    cache.put('a', obj(), 60);
    cache.put('b', obj(), 60);
    expect(cache.size).toBe(1);
    expect(cache.bytes).toBe(60);
  });

  it('take removes without disposing', () => {
    const dispose = vi.fn();
    const cache = new ModelCache(10, 100, dispose);
    const a = obj();
    cache.put('a', a, 10);
    expect(cache.take('a')).toEqual({ object: a, bytes: 10 });
    expect(cache.take('a')).toBeUndefined();
    expect(cache.bytes).toBe(0);
    expect(dispose).not.toHaveBeenCalled();
  });

  it('replacing a key disposes the old object; clear disposes all', () => {
    const dispose = vi.fn();
    const cache = new ModelCache(10, 1000, dispose);
    const a1 = obj();
    const a2 = obj();
    cache.put('a', a1, 10);
    cache.put('a', a2, 10);
    expect(dispose).toHaveBeenCalledWith(a1);
    cache.clear();
    expect(dispose).toHaveBeenCalledWith(a2);
    expect(cache.size).toBe(0);
  });

  it('disposeObject disposes geometries and materials', async () => {
    const bytes = readFileSync(new URL('../fixtures/cnit-low.glb', import.meta.url));
    const scene = await parseGlb(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    let mesh: Mesh | undefined;
    scene.traverse((o) => {
      if ((o as Mesh).isMesh && !mesh) mesh = o as Mesh;
    });
    const spy = vi.spyOn(mesh!.geometry, 'dispose');
    disposeObject(scene);
    expect(spy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/unit/loader.test.ts`
Expected: FAIL with "Failed to resolve import ../../src/landmarks/loader".

- [ ] **Step 4: Implement**

`src/landmarks/loader.ts`:
```ts
import type { Material, Mesh, Object3D } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { absoluteUrl, HttpError, type Fetch, type LodRef } from './catalogue';

export function isAbort(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === 'AbortError';
}

/** Gzip file (decompressed client-side) first, raw GLB as fallback. */
export async function fetchGlb(
  lod: LodRef,
  baseUrl: string,
  fetchFn: Fetch,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  if (lod.gzip && typeof DecompressionStream !== 'undefined') {
    try {
      const res = await fetchFn(absoluteUrl(baseUrl, lod.gzip.url), { signal });
      if (res.ok && res.body) {
        const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
        return await new Response(stream).arrayBuffer();
      }
    } catch (err) {
      if (isAbort(err) || signal?.aborted) throw err;
    }
  }
  const url = absoluteUrl(baseUrl, lod.url);
  const res = await fetchFn(url, { signal });
  if (!res.ok) throw new HttpError(res.status, url);
  return res.arrayBuffer();
}

let loader: GLTFLoader | undefined;

export async function parseGlb(buffer: ArrayBuffer): Promise<Object3D> {
  loader ??= new GLTFLoader();
  const gltf = await loader.parseAsync(buffer, '');
  return gltf.scene;
}

export function disposeObject(root: Object3D): void {
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    for (const m of ([] as Material[]).concat(mesh.material)) m.dispose();
  });
}

export interface CachedModel {
  object: Object3D;
  bytes: number;
}

/** LRU of parsed models that are not currently resident. */
export class ModelCache {
  private readonly map = new Map<string, CachedModel>();
  private total = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number,
    readonly dispose: (object: Object3D) => void = disposeObject,
  ) {}

  get size(): number {
    return this.map.size;
  }

  get bytes(): number {
    return this.total;
  }

  take(key: string): CachedModel | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    this.map.delete(key);
    this.total -= hit.bytes;
    return hit;
  }

  put(key: string, object: Object3D, bytes: number): void {
    const old = this.map.get(key);
    if (old) {
      this.map.delete(key);
      this.total -= old.bytes;
      if (old.object !== object) this.dispose(old.object);
    }
    this.map.set(key, { object, bytes });
    this.total += bytes;
    while (this.map.size > this.maxEntries || (this.total > this.maxBytes && this.map.size > 0)) {
      const [oldestKey, oldest] = this.map.entries().next().value as [string, CachedModel];
      this.map.delete(oldestKey);
      this.total -= oldest.bytes;
      this.dispose(oldest.object);
    }
  }

  clear(): void {
    for (const { object } of this.map.values()) this.dispose(object);
    this.map.clear();
    this.total = 0;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/unit/loader.test.ts`
Expected: PASS (12 tests). If `parseGlb` fails in Node with a `self`/`navigator`/`document` error, add `// @vitest-environment happy-dom` at the top of this test file and `npm install -D happy-dom`. Don't change the implementation.

- [ ] **Step 6: Lint and typecheck.** Run `npx tsc --noEmit && npx eslint .`. Expected: clean.

- [ ] **Step 7: Checkpoint.** Do not commit.

---

### Task 5: Residency (wanted → resident, LOD swap, abort)

**Files:**
- Create: `src/landmarks/residency.ts`
- Test: `tests/unit/residency.test.ts`

**Interfaces:**
- Consumes:
  - `Wanted` from `discovery.ts`
  - `ModelCache`, `isAbort` from `loader.ts`
  - `LandmarkEntry`, `Lod` from `catalogue.ts`
- Produces:
  - `type LoadFn = (entry: LandmarkEntry, lod: Lod, signal: AbortSignal) => Promise<{ object: Object3D; bytes: number }>`
  - `interface ResidentModel { key; entry; lod; object; bytes }`
  - `class Residency { constructor({ load, cache, onChange, onError }); setWanted(wanted: Wanted[]): void; models(): ResidentModel[]; clear(): void }`

- [ ] **Step 1: Write the failing test**

`tests/unit/residency.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { Group, type Object3D } from 'three';
import type { LandmarkEntry, Lod } from '../../src/landmarks/catalogue';
import { entryKey, type Wanted } from '../../src/landmarks/discovery';
import { ModelCache } from '../../src/landmarks/loader';
import { Residency } from '../../src/landmarks/residency';
import { entry } from './fixtures';
import { deferred, flush } from './helpers';

type Loaded = { object: Object3D; bytes: number };

function setup() {
  const loads: { entry: LandmarkEntry; lod: Lod; signal: AbortSignal; d: ReturnType<typeof deferred<Loaded>> }[] =
    [];
  const dispose = vi.fn();
  const cache = new ModelCache(10, 1e9, dispose);
  const onChange = vi.fn();
  const onError = vi.fn();
  const residency = new Residency({
    cache,
    onChange,
    onError,
    load: (e, lod, signal) => {
      const d = deferred<Loaded>();
      loads.push({ entry: e, lod, signal, d });
      return d.promise;
    },
  });
  return { residency, loads, cache, dispose, onChange, onError };
}

const w = (e: LandmarkEntry, lod: Lod = 'low'): Wanted => ({ key: entryKey(e), entry: e, lod });
const a = entry('a');
const b = entry('b');

describe('Residency', () => {
  it('loads wanted models and reports a change when they arrive', async () => {
    const { residency, loads, onChange } = setup();
    residency.setWanted([w(a)]);
    expect(loads).toHaveLength(1);
    expect(residency.models()).toEqual([]);
    const object = new Group();
    loads[0]!.d.resolve({ object, bytes: 10 });
    await flush();
    expect(residency.models().map((m) => m.object)).toEqual([object]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('does not reload a model that is already resident or pending', async () => {
    const { residency, loads } = setup();
    residency.setWanted([w(a)]);
    residency.setWanted([w(a)]);
    expect(loads).toHaveLength(1);
    loads[0]!.d.resolve({ object: new Group(), bytes: 1 });
    await flush();
    residency.setWanted([w(a)]);
    expect(loads).toHaveLength(1);
  });

  it('keeps the old LOD visible until the new one is ready', async () => {
    const { residency, loads, cache } = setup();
    residency.setWanted([w(a, 'low')]);
    const low = new Group();
    loads[0]!.d.resolve({ object: low, bytes: 1 });
    await flush();
    residency.setWanted([w(a, 'detail')]);
    expect(residency.models()[0]!.object).toBe(low);
    const detail = new Group();
    loads[1]!.d.resolve({ object: detail, bytes: 2 });
    await flush();
    expect(residency.models()[0]!.object).toBe(detail);
    expect(residency.models()[0]!.lod).toBe('detail');
    expect(cache.take(`${entryKey(a)}#low`)?.object).toBe(low);
  });

  it('moves unwanted models to the cache and reuses them without loading', async () => {
    const { residency, loads, onChange } = setup();
    residency.setWanted([w(a)]);
    const object = new Group();
    loads[0]!.d.resolve({ object, bytes: 1 });
    await flush();
    residency.setWanted([]);
    expect(residency.models()).toEqual([]);
    residency.setWanted([w(a)]);
    expect(loads).toHaveLength(1);
    expect(residency.models()[0]!.object).toBe(object);
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('aborts loads that are no longer wanted and disposes their late result', async () => {
    const { residency, loads, dispose } = setup();
    residency.setWanted([w(a), w(b)]);
    residency.setWanted([w(b)]);
    expect(loads[0]!.signal.aborted).toBe(true);
    const late = new Group();
    loads[0]!.d.resolve({ object: late, bytes: 1 });
    await flush();
    expect(residency.models()).toEqual([]);
    expect(dispose).toHaveBeenCalledWith(late);
  });

  it('reports errors and retries on the next setWanted', async () => {
    const { residency, loads, onError } = setup();
    residency.setWanted([w(a)]);
    loads[0]!.d.reject(new Error('boom'));
    await flush();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), a);
    residency.setWanted([w(a)]);
    expect(loads).toHaveLength(2);
  });

  it('swallows abort errors', async () => {
    const { residency, loads, onError } = setup();
    residency.setWanted([w(a)]);
    residency.setWanted([]);
    loads[0]!.d.reject(new DOMException('Aborted', 'AbortError'));
    await flush();
    expect(onError).not.toHaveBeenCalled();
  });

  it('clear aborts pending loads and hands residents to the cache', async () => {
    const { residency, loads, cache } = setup();
    residency.setWanted([w(a), w(b)]);
    loads[0]!.d.resolve({ object: new Group(), bytes: 1 });
    await flush();
    residency.clear();
    expect(loads[1]!.signal.aborted).toBe(true);
    expect(residency.models()).toEqual([]);
    expect(cache.size).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/residency.test.ts`
Expected: FAIL with "Failed to resolve import ../../src/landmarks/residency".

- [ ] **Step 3: Implement**

`src/landmarks/residency.ts`:
```ts
import type { Object3D } from 'three';
import type { LandmarkEntry, Lod } from './catalogue';
import type { Wanted } from './discovery';
import { isAbort, type ModelCache } from './loader';

export type LoadFn = (
  entry: LandmarkEntry,
  lod: Lod,
  signal: AbortSignal,
) => Promise<{ object: Object3D; bytes: number }>;

export interface ResidentModel {
  key: string;
  entry: LandmarkEntry;
  lod: Lod;
  object: Object3D;
  bytes: number;
}

export interface ResidencyOptions {
  load: LoadFn;
  cache: ModelCache;
  onChange: () => void;
  onError: (err: unknown, entry: LandmarkEntry) => void;
}

const cacheKey = (key: string, lod: Lod) => `${key}#${lod}`;

export class Residency {
  private readonly resident = new Map<string, ResidentModel>();
  private readonly pending = new Map<string, { lod: Lod; controller: AbortController }>();

  constructor(private readonly opts: ResidencyOptions) {}

  models(): ResidentModel[] {
    return [...this.resident.values()];
  }

  setWanted(wanted: Wanted[]): void {
    const byKey = new Map(wanted.map((w) => [w.key, w]));
    for (const [key, p] of this.pending) {
      if (byKey.get(key)?.lod !== p.lod) {
        p.controller.abort();
        this.pending.delete(key);
      }
    }
    let changed = false;
    for (const [key, m] of this.resident) {
      if (!byKey.has(key)) {
        this.resident.delete(key);
        this.opts.cache.put(cacheKey(key, m.lod), m.object, m.bytes);
        changed = true;
      }
    }
    for (const w of wanted) {
      if (this.resident.get(w.key)?.lod === w.lod || this.pending.has(w.key)) continue;
      const cached = this.opts.cache.take(cacheKey(w.key, w.lod));
      if (cached) {
        this.swapIn(w, cached.object, cached.bytes);
        changed = true;
      } else {
        this.startLoad(w);
      }
    }
    if (changed) this.opts.onChange();
  }

  clear(): void {
    for (const p of this.pending.values()) p.controller.abort();
    this.pending.clear();
    for (const m of this.resident.values()) this.opts.cache.put(cacheKey(m.key, m.lod), m.object, m.bytes);
    this.resident.clear();
  }

  private startLoad(w: Wanted): void {
    const controller = new AbortController();
    this.pending.set(w.key, { lod: w.lod, controller });
    this.opts.load(w.entry, w.lod, controller.signal).then(
      ({ object, bytes }) => {
        if (controller.signal.aborted || this.pending.get(w.key)?.controller !== controller) {
          this.opts.cache.dispose(object);
          return;
        }
        this.pending.delete(w.key);
        this.swapIn(w, object, bytes);
        this.opts.onChange();
      },
      (err: unknown) => {
        if (this.pending.get(w.key)?.controller === controller) this.pending.delete(w.key);
        if (!isAbort(err) && !controller.signal.aborted) this.opts.onError(err, w.entry);
      },
    );
  }

  private swapIn(w: Wanted, object: Object3D, bytes: number): void {
    const old = this.resident.get(w.key);
    if (old) this.opts.cache.put(cacheKey(w.key, old.lod), old.object, old.bytes);
    this.resident.set(w.key, { key: w.key, entry: w.entry, lod: w.lod, object, bytes });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/residency.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Lint and typecheck.** Run `npx tsc --noEmit && npx eslint .`. Expected: clean.

- [ ] **Step 6: Checkpoint.** Do not commit.

---

### Task 6: Basemap building replacement

**Files:**
- Create: `src/landmarks/replacement.ts`
- Test: `tests/unit/replacement.test.ts`

**Interfaces:**
- Consumes:
  - `LandmarkEntry`, `Footprint` from `catalogue.ts`
  - `entryKey` from `discovery.ts`
  - `convertFilter` from `@maplibre/maplibre-gl-style-spec`
- Produces:
  - `type Ring = number[][]`
  - `insetRing(ring: Ring, insetM: number): Ring`
  - `footprintOf(entry: LandmarkEntry, insetM: number): number[][][][]`, as MultiPolygon coordinates
  - `composeFilter(original: FilterSpecification | null | undefined, multi: number[][][][]): FilterSpecification`
  - `type FilterTarget = Pick<Map, 'getLayer' | 'getFilter' | 'setFilter'>`
  - `class BuildingReplacement { constructor(map: FilterTarget, layerIds: string[], insetM: number); update(entries: LandmarkEntry[]): void; restore(): void }`

- [ ] **Step 1: Write the failing test**

`tests/unit/replacement.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { distanceM } from '../../src/landmarks/discovery';
import {
  BuildingReplacement,
  composeFilter,
  footprintOf,
  insetRing,
  type FilterTarget,
} from '../../src/landmarks/replacement';
import { entry } from './fixtures';

// ~100 m square around the Eiffel Tower anchor.
const SQUARE = [
  [2.2938, 48.8580],
  [2.2952, 48.8580],
  [2.2952, 48.8589],
  [2.2938, 48.8589],
  [2.2938, 48.8580],
];

describe('insetRing', () => {
  it('moves every vertex ~insetM metres toward the centroid and keeps the ring closed', () => {
    const inset = insetRing(SQUARE, 1.5);
    expect(inset).toHaveLength(5);
    expect(inset[0]).toEqual(inset[4]);
    for (let i = 0; i < 4; i++) {
      const moved = distanceM(SQUARE[i] as [number, number], inset[i] as [number, number]);
      expect(moved).toBeCloseTo(1.5, 1);
    }
  });

  it('collapses rings smaller than the inset onto their centroid', () => {
    const tiny = [
      [0, 0],
      [0.000001, 0],
      [0.000001, 0.000001],
      [0, 0],
    ];
    const inset = insetRing(tiny, 5);
    expect(new Set(inset.map((p) => p.join(','))).size).toBe(1);
  });
});

describe('footprintOf', () => {
  it('uses the replacement footprint and keeps holes unchanged', () => {
    const hole = [
      [2.2944, 48.8583],
      [2.2946, 48.8583],
      [2.2946, 48.8585],
      [2.2944, 48.8583],
    ];
    const e = entry('a', { replacementFootprint: { type: 'Polygon', coordinates: [SQUARE, hole] } });
    const multi = footprintOf(e, 1.5);
    expect(multi).toHaveLength(1);
    expect(multi[0]![0]).not.toEqual(SQUARE);
    expect(multi[0]![1]).toEqual(hole);
  });

  it('insets every polygon of a MultiPolygon', () => {
    const e = entry('a', {
      replacementFootprint: { type: 'MultiPolygon', coordinates: [[SQUARE], [SQUARE]] },
    });
    expect(footprintOf(e, 1.5)).toHaveLength(2);
  });

  it('falls back to the entry bounds rectangle', () => {
    const multi = footprintOf(entry('a'), 0);
    expect(multi[0]![0]).toEqual([
      [2.2935, 48.8574],
      [2.2955, 48.8574],
      [2.2955, 48.8594],
      [2.2935, 48.8594],
      [2.2935, 48.8574],
    ]);
  });
});

describe('composeFilter', () => {
  const multi = [[SQUARE]];
  const keep = ['!=', ['distance', { type: 'MultiPolygon', coordinates: multi }], 0];

  it('converts legacy Protomaps filters before combining', () => {
    expect(composeFilter(['in', 'kind', 'building', 'building_part'], multi)).toEqual([
      'all',
      ['match', ['get', 'kind'], ['building', 'building_part'], true, false],
      keep,
    ]);
  });

  it('works without an original filter', () => {
    expect(composeFilter(null, multi)).toEqual(keep);
  });
});

function fakeMap(filters: Record<string, unknown>) {
  const setFilter = vi.fn((id: string, f: unknown) => {
    filters[id] = f;
  });
  const map = {
    getLayer: (id: string) => (id in filters ? { id } : undefined),
    getFilter: (id: string) => filters[id],
    setFilter,
  } as unknown as FilterTarget;
  return { map, setFilter, filters };
}

describe('BuildingReplacement', () => {
  const original = ['in', 'kind', 'building', 'building_part'];

  it('applies, de-duplicates and restores filters', () => {
    const { map, setFilter, filters } = fakeMap({ buildings: original });
    const r = new BuildingReplacement(map, ['buildings'], 1.5);
    r.update([entry('a')]);
    expect(setFilter).toHaveBeenCalledTimes(1);
    expect((filters.buildings as unknown[])[0]).toBe('all');
    r.update([entry('a')]);
    expect(setFilter).toHaveBeenCalledTimes(1);
    r.update([]);
    expect(filters.buildings).toEqual(original);
    r.update([entry('b')]);
    r.restore();
    expect(filters.buildings).toEqual(original);
  });

  it('ignores layers that do not exist', () => {
    const { map, setFilter } = fakeMap({});
    new BuildingReplacement(map, ['buildings'], 1.5).update([entry('a')]);
    expect(setFilter).not.toHaveBeenCalled();
  });

  it('restore survives a torn-down style', () => {
    const { map } = fakeMap({ buildings: original });
    const r = new BuildingReplacement(map, ['buildings'], 1.5);
    r.update([entry('a')]);
    (map as unknown as { getLayer: () => never }).getLayer = () => {
      throw new Error('style is gone');
    };
    expect(() => r.restore()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/replacement.test.ts`
Expected: FAIL with "Failed to resolve import ../../src/landmarks/replacement".

- [ ] **Step 3: Implement**

`src/landmarks/replacement.ts`:
```ts
import { convertFilter } from '@maplibre/maplibre-gl-style-spec';
import type { FilterSpecification, Map as MlMap } from 'maplibre-gl';
import { EARTH_RADIUS_M } from '../core/mercator';
import type { LandmarkEntry } from './catalogue';
import { entryKey } from './discovery';

export type Ring = number[][];
export type FilterTarget = Pick<MlMap, 'getLayer' | 'getFilter' | 'setFilter'>;

const METRES_PER_DEG = (2 * Math.PI * EARTH_RADIUS_M) / 360;

/** Moves each vertex insetM metres toward the ring's vertex centroid (approximate inward buffer). */
export function insetRing(ring: Ring, insetM: number): Ring {
  const closed = ring.length > 1 && ring[0]![0] === ring.at(-1)![0] && ring[0]![1] === ring.at(-1)![1];
  const pts = closed ? ring.slice(0, -1) : ring;
  const cx = pts.reduce((s, p) => s + p[0]!, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1]!, 0) / pts.length;
  const kx = METRES_PER_DEG * Math.cos((cy * Math.PI) / 180);
  const out = pts.map(([x, y]) => {
    const dx = (x! - cx) * kx;
    const dy = (y! - cy) * METRES_PER_DEG;
    const d = Math.hypot(dx, dy);
    if (insetM <= 0) return [x!, y!];
    const f = d > insetM ? (d - insetM) / d : 0;
    return [cx + (x! - cx) * f, cy + (y! - cy) * f];
  });
  return [...out, out[0]!];
}

export function footprintOf(entry: LandmarkEntry, insetM: number): number[][][][] {
  const fp = entry.replacementFootprint;
  const [w, s, e, n] = entry.bounds;
  const polygons: number[][][][] = !fp
    ? [[[[w, s], [e, s], [e, n], [w, n], [w, s]]]]
    : fp.type === 'Polygon'
      ? [fp.coordinates]
      : fp.coordinates;
  return polygons.map(([outer, ...holes]) => [insetRing(outer!, insetM), ...holes]);
}

export function composeFilter(
  original: FilterSpecification | null | undefined,
  multi: number[][][][],
): FilterSpecification {
  const keep = ['!=', ['distance', { type: 'MultiPolygon', coordinates: multi }], 0];
  return (original ? ['all', convertFilter(original), keep] : keep) as FilterSpecification;
}

export class BuildingReplacement {
  private readonly originals = new Map<string, FilterSpecification | null>();
  private lastKey = '';

  constructor(
    private readonly map: FilterTarget,
    private readonly layerIds: string[],
    private readonly insetM: number,
  ) {}

  update(entries: LandmarkEntry[]): void {
    const key = entries.map(entryKey).sort().join('|');
    if (key === this.lastKey) return;
    this.lastKey = key;
    const multi = entries.flatMap((e) => footprintOf(e, this.insetM));
    for (const id of this.layerIds) {
      if (!this.map.getLayer(id)) continue;
      if (!this.originals.has(id)) this.originals.set(id, (this.map.getFilter(id) ?? null) as FilterSpecification | null);
      const original = this.originals.get(id) ?? null;
      this.map.setFilter(id, multi.length ? composeFilter(original, multi) : original);
    }
  }

  restore(): void {
    for (const [id, filter] of this.originals) {
      try {
        if (this.map.getLayer(id)) this.map.setFilter(id, filter);
      } catch {
        // The style was torn down (setStyle / map.remove); nothing to restore.
      }
    }
    this.originals.clear();
    this.lastKey = '';
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/replacement.test.ts`
Expected: PASS (10 tests). If importing `@maplibre/maplibre-gl-style-spec` fails in Node, check that `npm ls @maplibre/maplibre-gl-style-spec` shows it as a direct dependency.

- [ ] **Step 5: Lint and typecheck.** Run `npx tsc --noEmit && npx eslint .`. Expected: clean.

- [ ] **Step 6: Checkpoint.** Do not commit.

---

### Task 7: Shared core (lighting, ThreeCore, LayerModule, ModuleLayer)

**Files:**
- Create: `src/core/lighting.ts`, `src/core/ThreeCore.ts`, `src/core/LayerModule.ts`, `src/core/ModuleLayer.ts`
- Test: `tests/unit/core.test.ts`

**Interfaces:**
- Consumes: `originAt`, `cameraMatrix` from `mercator.ts`; `Origin`, `ViewState` from `types.ts`
- Produces:
  - `type LightingPreset = 'day' | 'dawn' | 'night'`
  - `LIGHTING` table
  - `interface LightRig { group: Group; setPreset(p: LightingPreset): void }`
  - `createLightRig(preset): LightRig`
  - `interface RendererLike { resetState(); render(scene, camera); dispose() }`
  - `type CoreMap = Pick<Map, 'getCenter' | 'getCanvas'>`
  - `type RendererFactory = (map: CoreMap, gl: WebGL2RenderingContext) => RendererLike`
  - `createWebGLRenderer: RendererFactory`
  - `acquireCore(map, gl, factory?): ThreeCore`, `releaseCore(map): void`
  - `class ThreeCore { refs; renderer; lighting; createScene(): Scene; releaseScene(scene); setLighting(p); render(scene, mainMatrix: ArrayLike<number>, place: (o: Origin) => void); dispose() }`
  - `interface ModuleContext { map: Map; core: ThreeCore; scene: Scene; requestRepaint(): void }`
  - `interface LayerModule { onAdd(ctx); update(view); place(origin); frame?(timeMs): boolean; onRemove() }`
  - `viewStateOf(map): ViewState`
  - `class ModuleLayer implements CustomLayerInterface { constructor(id, module, options?: { debounceMs?: number; rendererFactory?: RendererFactory }) }`

- [ ] **Step 1: Write the failing test**

`tests/unit/core.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DirectionalLight, HemisphereLight, Matrix4, type Scene } from 'three';
import type { Map as MlMap } from 'maplibre-gl';
import { createLightRig, LIGHTING } from '../../src/core/lighting';
import type { LayerModule } from '../../src/core/LayerModule';
import { cameraMatrix, mercatorX } from '../../src/core/mercator';
import { ModuleLayer } from '../../src/core/ModuleLayer';
import { acquireCore, releaseCore, type RendererLike } from '../../src/core/ThreeCore';

function fakeRenderer() {
  return {
    resetState: vi.fn(),
    render: vi.fn(),
    dispose: vi.fn(),
  } satisfies RendererLike;
}

function fakeMap() {
  const handlers = new Map<string, () => void>();
  return {
    handlers,
    getCenter: () => ({ lng: 2.2945, lat: 48.8584 }),
    getCanvas: () => ({}) as HTMLCanvasElement,
    getZoom: () => 16,
    getPitch: () => 45,
    getBearing: () => 10,
    getBounds: () => ({ getWest: () => 2.28, getSouth: () => 48.85, getEast: () => 2.3, getNorth: () => 48.87 }),
    on: vi.fn((type: string, fn: () => void) => handlers.set(type, fn)),
    off: vi.fn((type: string) => handlers.delete(type)),
    triggerRepaint: vi.fn(),
  };
}

const gl = {} as WebGL2RenderingContext;
const asMap = (m: ReturnType<typeof fakeMap>) => m as unknown as MlMap;

afterEach(() => vi.useRealTimers());

describe('lighting', () => {
  it('builds a hemisphere + sun rig and switches presets', () => {
    const rig = createLightRig('day');
    const hemi = rig.group.children.find((c) => c instanceof HemisphereLight) as HemisphereLight;
    const sun = rig.group.children.find((c) => c instanceof DirectionalLight) as DirectionalLight;
    expect(hemi.intensity).toBe(LIGHTING.day.hemi);
    rig.setPreset('night');
    expect(hemi.intensity).toBe(LIGHTING.night.hemi);
    expect(sun.intensity).toBe(LIGHTING.night.sun);
  });
});

describe('ThreeCore', () => {
  it('is shared per map and reference counted', () => {
    const map = fakeMap();
    const r = fakeRenderer();
    const factory = vi.fn(() => r);
    const a = acquireCore(asMap(map), gl, factory);
    const b = acquireCore(asMap(map), gl, factory);
    expect(a).toBe(b);
    expect(factory).toHaveBeenCalledTimes(1);
    releaseCore(asMap(map));
    expect(r.dispose).not.toHaveBeenCalled();
    releaseCore(asMap(map));
    expect(r.dispose).toHaveBeenCalledTimes(1);
    expect(acquireCore(asMap(map), gl, factory)).not.toBe(a);
    releaseCore(asMap(map));
  });

  it('renders around a per-frame origin at the map center', () => {
    const map = fakeMap();
    const r = fakeRenderer();
    const core = acquireCore(asMap(map), gl, () => r);
    const scene = core.createScene();
    const place = vi.fn();
    const main = new Matrix4().makeScale(3, 3, 3).toArray();
    core.render(scene, main, place);
    const origin = place.mock.calls[0]![0];
    expect(origin.x).toBeCloseTo(mercatorX(2.2945), 12);
    expect(r.resetState).toHaveBeenCalledTimes(2);
    const [renderedScene, camera] = r.render.mock.calls[0]!;
    expect(renderedScene).toBe(scene);
    expect(camera.projectionMatrix.equals(cameraMatrix(main, origin))).toBe(true);
    releaseCore(asMap(map));
  });

  it('applies lighting to every scene', () => {
    const map = fakeMap();
    const core = acquireCore(asMap(map), gl, () => fakeRenderer());
    const s1 = core.createScene();
    core.setLighting('dawn');
    const s2 = core.createScene();
    const intensity = (s: Scene) =>
      (s.children[0]!.children.find((c) => c instanceof HemisphereLight) as HemisphereLight).intensity;
    expect(intensity(s1)).toBe(LIGHTING.dawn.hemi);
    expect(intensity(s2)).toBe(LIGHTING.dawn.hemi);
    releaseCore(asMap(map));
  });
});

describe('ModuleLayer', () => {
  function moduleSpy(frameResult = false) {
    return {
      onAdd: vi.fn(),
      update: vi.fn(),
      place: vi.fn(),
      frame: vi.fn(() => frameResult),
      onRemove: vi.fn(),
    } satisfies LayerModule;
  }

  it('wires a module into the MapLibre custom layer lifecycle', () => {
    vi.useFakeTimers();
    const map = fakeMap();
    const r = fakeRenderer();
    const mod = moduleSpy();
    const layer = new ModuleLayer('test', mod, { rendererFactory: () => r });
    expect(layer.type).toBe('custom');
    expect(layer.renderingMode).toBe('3d');

    layer.onAdd(map as unknown as MlMap, gl);
    expect(mod.onAdd).toHaveBeenCalledTimes(1);
    expect(mod.update).toHaveBeenCalledWith({
      zoom: 16,
      pitch: 45,
      bearing: 10,
      center: [2.2945, 48.8584],
      bounds: [2.28, 48.85, 2.3, 48.87],
    });

    const moveend = map.handlers.get('moveend')!;
    moveend();
    moveend();
    vi.advanceTimersByTime(149);
    expect(mod.update).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(mod.update).toHaveBeenCalledTimes(2);

    layer.render(gl, { defaultProjectionData: { mainMatrix: new Matrix4().toArray() } } as never);
    expect(mod.place).toHaveBeenCalledTimes(1);
    expect(r.render).toHaveBeenCalledTimes(1);
    expect(map.triggerRepaint).not.toHaveBeenCalled();

    layer.onRemove(map as unknown as MlMap, gl);
    expect(mod.onRemove).toHaveBeenCalledTimes(1);
    expect(map.handlers.has('moveend')).toBe(false);
    expect(r.dispose).toHaveBeenCalledTimes(1);
  });

  it('requests another frame while the module animates', () => {
    const map = fakeMap();
    const layer = new ModuleLayer('anim', moduleSpy(true), { rendererFactory: () => fakeRenderer() });
    layer.onAdd(map as unknown as MlMap, gl);
    layer.render(gl, { defaultProjectionData: { mainMatrix: new Matrix4().toArray() } } as never);
    expect(map.triggerRepaint).toHaveBeenCalledTimes(1);
    layer.onRemove(map as unknown as MlMap, gl);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/core.test.ts`
Expected: FAIL with "Failed to resolve import ../../src/core/lighting".

- [ ] **Step 3: Implement lighting**

`src/core/lighting.ts`:
```ts
import { DirectionalLight, Group, HemisphereLight } from 'three';

export type LightingPreset = 'day' | 'dawn' | 'night';

interface PresetValues {
  sky: number;
  ground: number;
  hemi: number;
  sun: number;
  sunColor: number;
  /** Direction towards the sun in local glTF axes (X east, Y up, Z south). */
  sunDir: [number, number, number];
}

export const LIGHTING: Record<LightingPreset, PresetValues> = {
  day: { sky: 0xdfeaf5, ground: 0x8a8070, hemi: 1.6, sun: 2.2, sunColor: 0xfff4e0, sunDir: [-0.5, 1, 0.35] },
  dawn: { sky: 0xf2c9a8, ground: 0x5a4a40, hemi: 1.1, sun: 1.8, sunColor: 0xffb47a, sunDir: [-1, 0.35, 0.2] },
  night: { sky: 0x30406a, ground: 0x101018, hemi: 0.45, sun: 0.25, sunColor: 0x9fb4ff, sunDir: [0.3, 1, -0.4] },
};

export interface LightRig {
  group: Group;
  setPreset(preset: LightingPreset): void;
}

export function createLightRig(preset: LightingPreset): LightRig {
  const group = new Group();
  const hemi = new HemisphereLight();
  const sun = new DirectionalLight();
  group.add(hemi, sun);
  const setPreset = (p: LightingPreset) => {
    const v = LIGHTING[p];
    hemi.color.setHex(v.sky);
    hemi.groundColor.setHex(v.ground);
    hemi.intensity = v.hemi;
    sun.color.setHex(v.sunColor);
    sun.intensity = v.sun;
    sun.position.set(...v.sunDir).normalize().multiplyScalar(1000);
  };
  setPreset(preset);
  return { group, setPreset };
}
```

- [ ] **Step 4: Implement ThreeCore**

`src/core/ThreeCore.ts`:
```ts
import type { Map as MlMap } from 'maplibre-gl';
import { Camera, Scene, WebGLRenderer } from 'three';
import { createLightRig, type LightingPreset, type LightRig } from './lighting';
import { cameraMatrix, originAt } from './mercator';
import type { Origin } from './types';

export interface RendererLike {
  resetState(): void;
  render(scene: Scene, camera: Camera): void;
  dispose(): void;
}

export type CoreMap = Pick<MlMap, 'getCenter' | 'getCanvas'>;
export type RendererFactory = (map: CoreMap, gl: WebGL2RenderingContext) => RendererLike;

export const createWebGLRenderer: RendererFactory = (map, gl) => {
  const renderer = new WebGLRenderer({
    canvas: map.getCanvas(),
    context: gl as unknown as WebGLRenderingContext,
    antialias: true,
  });
  renderer.autoClear = false;
  return renderer;
};

const cores = new WeakMap<object, ThreeCore>();

export function acquireCore(
  map: CoreMap,
  gl: WebGL2RenderingContext,
  factory: RendererFactory = createWebGLRenderer,
): ThreeCore {
  let core = cores.get(map);
  if (!core) {
    core = new ThreeCore(map, factory(map, gl));
    cores.set(map, core);
  }
  core.refs++;
  return core;
}

export function releaseCore(map: CoreMap): void {
  const core = cores.get(map);
  if (!core) return;
  core.refs--;
  if (core.refs <= 0) {
    core.dispose();
    cores.delete(map);
  }
}

/** One Three.js renderer per map, shared by every module layer on it. */
export class ThreeCore {
  refs = 0;
  private readonly camera = new Camera();
  private readonly rigs = new Map<Scene, LightRig>();
  private preset: LightingPreset = 'day';

  constructor(
    private readonly map: CoreMap,
    readonly renderer: RendererLike,
  ) {}

  get lighting(): LightingPreset {
    return this.preset;
  }

  createScene(): Scene {
    const scene = new Scene();
    const rig = createLightRig(this.preset);
    scene.add(rig.group);
    this.rigs.set(scene, rig);
    return scene;
  }

  releaseScene(scene: Scene): void {
    this.rigs.delete(scene);
  }

  setLighting(preset: LightingPreset): void {
    this.preset = preset;
    for (const rig of this.rigs.values()) rig.setPreset(preset);
  }

  render(scene: Scene, mainMatrix: ArrayLike<number>, place: (origin: Origin) => void): void {
    const center = this.map.getCenter();
    const origin = originAt([center.lng, center.lat]);
    place(origin);
    this.camera.projectionMatrix.copy(cameraMatrix(mainMatrix, origin));
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    this.renderer.resetState();
    this.renderer.render(scene, this.camera);
    this.renderer.resetState();
  }

  dispose(): void {
    this.rigs.clear();
    this.renderer.dispose();
  }
}
```

- [ ] **Step 5: Implement LayerModule and ModuleLayer**

`src/core/LayerModule.ts`:
```ts
import type { Map as MlMap } from 'maplibre-gl';
import type { Scene } from 'three';
import type { ThreeCore } from './ThreeCore';
import type { Origin, ViewState } from './types';

export interface ModuleContext {
  map: MlMap;
  core: ThreeCore;
  /** The module's own scene; its light rig is already inside. */
  scene: Scene;
  requestRepaint(): void;
}

/** A GL-free unit of 3D content (landmarks today; trees and water later). */
export interface LayerModule {
  onAdd(ctx: ModuleContext): void;
  /** Called on add and after the camera settles (debounced moveend). */
  update(view: ViewState): void;
  /** Called every frame: position objects in metres relative to `origin` (glTF axes). */
  place(origin: Origin): void;
  /** Optional per-frame animation; return true to request another frame. */
  frame?(timeMs: number): boolean;
  onRemove(): void;
}
```

`src/core/ModuleLayer.ts`:
```ts
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MlMap } from 'maplibre-gl';
import type { Scene } from 'three';
import type { LayerModule } from './LayerModule';
import { acquireCore, releaseCore, type RendererFactory, type ThreeCore } from './ThreeCore';
import type { ViewState } from './types';

export function viewStateOf(map: MlMap): ViewState {
  const b = map.getBounds();
  const c = map.getCenter();
  return {
    zoom: map.getZoom(),
    pitch: map.getPitch(),
    bearing: map.getBearing(),
    center: [c.lng, c.lat],
    bounds: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
  };
}

export interface ModuleLayerOptions {
  debounceMs?: number;
  rendererFactory?: RendererFactory;
}

/** Adapts a LayerModule to MapLibre's custom layer interface on the shared ThreeCore. */
export class ModuleLayer implements CustomLayerInterface {
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const;
  private map?: MlMap;
  private core?: ThreeCore;
  private scene?: Scene;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    readonly id: string,
    protected readonly module: LayerModule,
    private readonly options: ModuleLayerOptions = {},
  ) {}

  onAdd(map: MlMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.core = acquireCore(map, gl, this.options.rendererFactory);
    this.scene = this.core.createScene();
    this.module.onAdd({ map, core: this.core, scene: this.scene, requestRepaint: () => map.triggerRepaint() });
    map.on('moveend', this.onMoveEnd);
    this.module.update(viewStateOf(map));
  }

  onRemove(_map?: MlMap, _gl?: WebGL2RenderingContext): void {
    clearTimeout(this.timer);
    this.map?.off('moveend', this.onMoveEnd);
    this.module.onRemove();
    if (this.scene) this.core?.releaseScene(this.scene);
    if (this.map) releaseCore(this.map);
    this.map = undefined;
    this.core = undefined;
    this.scene = undefined;
  }

  render(_gl: WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    if (!this.map || !this.core || !this.scene) return;
    this.core.render(this.scene, options.defaultProjectionData.mainMatrix, (origin) => this.module.place(origin));
    if (this.module.frame?.(performance.now())) this.map.triggerRepaint();
  }

  private readonly onMoveEnd = (): void => {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.map) this.module.update(viewStateOf(this.map));
    }, this.options.debounceMs ?? 150);
  };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/unit/core.test.ts`
Expected: PASS (6 tests). If `tsc` rejects `onAdd`/`onRemove` as incompatible with `CustomLayerInterface`, align the parameter types with the d.ts signatures (`onAdd?(map: Map, gl: WebGL2RenderingContext)`), keeping the same behaviour.

- [ ] **Step 7: Lint and typecheck.** Run `npx tsc --noEmit && npx eslint .`. Expected: clean.

- [ ] **Step 8: Checkpoint.** Do not commit.

---

### Task 8: Landmarks module, public layer, attribution, exports

**Files:**
- Create: `src/landmarks/attribution.ts`, `src/landmarks/LandmarksModule.ts`, `src/landmarks/LandmarksLayer.ts`, `src/index.ts`
- Test: `tests/unit/attribution.test.ts`, `tests/unit/landmarks.test.ts`

**Interfaces:**
- Consumes: everything above
- Produces:
  - `LICENCES_URL`
  - `attributionText(models: { attribution: string }[], catalogueAttribution?: string): string`
  - `type AttributionTarget`
  - `class AttributionSource { constructor(map, id); set(text: string); remove() }`
  - `DISCOVERY_MIN_ZOOM = 14`
  - `interface ErrorContext { stage: 'catalogue' | 'cell' | 'model'; id?: string }`
  - `interface LandmarkInfo { id; revision; name?; anchor; lod; attribution }`
  - `interface LandmarksOptions { channel?; catalogueUrl?; baseUrl?; replaceBuildings?; replacementInsetM?; maxResident?; maxCached?; maxCacheBytes?; lighting?; fetch?; onError?; onModelsChanged? }`
  - `class LandmarksModule implements LayerModule { constructor(id, opts?, load?: LoadFn); setLighting(p); getVisibleModels(); getAttribution() }`
  - `interface LandmarksLayerOptions extends LandmarksOptions { id: string }`
  - `class LandmarksLayer extends ModuleLayer { setLighting(p); getVisibleModels(); getAttribution() }`

- [ ] **Step 1: Write the failing attribution test**

`tests/unit/attribution.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import {
  AttributionSource,
  attributionText,
  LICENCES_URL,
  type AttributionTarget,
} from '../../src/landmarks/attribution';

describe('attributionText', () => {
  it('lists unique attributions, escapes HTML and links the licences', () => {
    const text = attributionText(
      [{ attribution: 'IGN <LiDAR>' }, { attribution: 'IGN <LiDAR>' }],
      'Open Landmarks; © OpenStreetMap contributors',
    );
    expect(text).toContain(LICENCES_URL);
    expect(text).toContain('IGN &lt;LiDAR&gt;');
    expect(text.match(/IGN/g)).toHaveLength(1);
    expect(text.match(/OpenStreetMap/g)).toHaveLength(1);
  });

  it('always credits OpenStreetMap', () => {
    expect(attributionText([{ attribution: 'X' }])).toContain('© OpenStreetMap contributors');
  });
});

function fakeStyle() {
  const layers = new Set<string>();
  const sources = new Map<string, unknown>();
  const map = {
    getLayer: vi.fn((id: string) => (layers.has(id) ? { id } : undefined)),
    getSource: vi.fn((id: string) => sources.get(id)),
    addSource: vi.fn((id: string, spec: unknown) => sources.set(id, spec)),
    addLayer: vi.fn((spec: { id: string }) => layers.add(spec.id)),
    removeLayer: vi.fn((id: string) => layers.delete(id)),
    removeSource: vi.fn((id: string) => sources.delete(id)),
  };
  return { map, layers, sources, target: map as unknown as AttributionTarget };
}

describe('AttributionSource', () => {
  it('adds a used source carrying the attribution and replaces it on change', () => {
    const { map, sources, layers, target } = fakeStyle();
    const src = new AttributionSource(target, 'lm-attr');
    src.set('A');
    expect((sources.get('lm-attr') as { attribution: string }).attribution).toBe('A');
    expect(layers.has('lm-attr')).toBe(true);
    src.set('A');
    expect(map.addSource).toHaveBeenCalledTimes(1);
    src.set('B');
    expect((sources.get('lm-attr') as { attribution: string }).attribution).toBe('B');
    src.set('');
    expect(sources.size).toBe(0);
    expect(layers.size).toBe(0);
  });

  it('remove() survives a torn-down style', () => {
    const { map, target } = fakeStyle();
    const src = new AttributionSource(target, 'lm-attr');
    src.set('A');
    map.getLayer.mockImplementation(() => {
      throw new Error('style is gone');
    });
    expect(() => src.remove()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/attribution.test.ts`
Expected: FAIL with "Failed to resolve import ../../src/landmarks/attribution".

- [ ] **Step 3: Implement attribution**

`src/landmarks/attribution.ts`:
```ts
import type { Map as MlMap } from 'maplibre-gl';

export const LICENCES_URL = 'https://open-landmarks.benmaps.fr/licenses/';

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function attributionText(models: { attribution: string }[], catalogueAttribution?: string): string {
  const parts: string[] = [];
  const add = (t?: string) => {
    const v = t?.trim();
    if (v && !parts.includes(v)) parts.push(v);
  };
  add(catalogueAttribution);
  for (const m of models) add(m.attribution);
  if (!parts.some((p) => p.includes('OpenStreetMap'))) add('© OpenStreetMap contributors');
  return `<a href="${LICENCES_URL}" target="_blank" rel="noopener">${parts.map(escapeHtml).join('; ')}</a>`;
}

export type AttributionTarget = Pick<
  MlMap,
  'getLayer' | 'getSource' | 'addSource' | 'addLayer' | 'removeLayer' | 'removeSource'
>;

/**
 * Shows text in MapLibre's AttributionControl: an empty GeoJSON source carrying `attribution`,
 * plus an invisible layer so MapLibre counts the source as used.
 */
export class AttributionSource {
  private text = '';

  constructor(
    private readonly map: AttributionTarget,
    private readonly id: string,
  ) {}

  set(text: string): void {
    if (text === this.text) return;
    this.remove();
    if (!text) return;
    this.map.addSource(this.id, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
      attribution: text,
    });
    this.map.addLayer({ id: this.id, type: 'fill', source: this.id, paint: { 'fill-opacity': 0 } });
    this.text = text;
  }

  remove(): void {
    try {
      if (this.map.getLayer(this.id)) this.map.removeLayer(this.id);
      if (this.map.getSource(this.id)) this.map.removeSource(this.id);
    } catch {
      // The style was torn down (setStyle / map.remove).
    }
    this.text = '';
  }
}
```

Run: `npx vitest run tests/unit/attribution.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 4: Write the failing landmarks module test**

`tests/unit/landmarks.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { Group, Scene, type Object3D } from 'three';
import type { ModuleContext } from '../../src/core/LayerModule';
import { originAt } from '../../src/core/mercator';
import type { LandmarkEntry, Lod } from '../../src/landmarks/catalogue';
import { LandmarksModule, type LandmarksOptions } from '../../src/landmarks/LandmarksModule';
import { BASE, CATALOGUE, entry, POINTER, rawCell } from './fixtures';
import { deferred, fakeFetch, flush, view } from './helpers';

const CELL = `${BASE}/api/v1/releases/r1/index/12/2074/1409.json`;

function routes(over: Record<string, unknown> = {}) {
  return {
    [`${BASE}/api/v1/latest.json`]: POINTER,
    [`${BASE}/api/v1/releases/r1/catalogue.json`]: CATALOGUE,
    [CELL]: rawCell([entry('eiffel', { attribution: 'IGN LiDAR' })]),
    ...over,
  };
}

function fakeMapForModule() {
  const filters: Record<string, unknown> = { buildings: ['in', 'kind', 'building', 'building_part'] };
  const layers = new Set<string>(['buildings']);
  const sources = new Map<string, unknown>();
  let terrain: object | null = null;
  const map = {
    filters,
    sources,
    setTerrain: (t: object | null) => (terrain = t),
    getTerrain: () => terrain,
    queryTerrainElevation: vi.fn(() => 35),
    getLayer: (id: string) => (layers.has(id) ? { id } : undefined),
    getFilter: (id: string) => filters[id],
    setFilter: vi.fn((id: string, f: unknown) => (filters[id] = f)),
    getSource: (id: string) => sources.get(id),
    addSource: (id: string, s: unknown) => sources.set(id, s),
    removeSource: (id: string) => sources.delete(id),
    addLayer: (l: { id: string }) => layers.add(l.id),
    removeLayer: (id: string) => layers.delete(id),
  };
  return map;
}

function setup(opts: Partial<LandmarksOptions> = {}, fetchRoutes = routes()) {
  const f = fakeFetch(fetchRoutes);
  const loads: { entry: LandmarkEntry; lod: Lod; d: ReturnType<typeof deferred<{ object: Object3D; bytes: number }>> }[] =
    [];
  const onError = vi.fn();
  const onModelsChanged = vi.fn();
  const module = new LandmarksModule(
    'landmarks',
    { baseUrl: BASE, fetch: f, replaceBuildings: ['buildings'], onError, onModelsChanged, ...opts },
    (e, lod) => {
      const d = deferred<{ object: Object3D; bytes: number }>();
      loads.push({ entry: e, lod, d });
      return d.promise;
    },
  );
  const map = fakeMapForModule();
  const scene = new Scene();
  const core = { setLighting: vi.fn() };
  const requestRepaint = vi.fn();
  const ctx = { map, core, scene, requestRepaint } as unknown as ModuleContext;
  module.onAdd(ctx);
  return { module, f, loads, onError, onModelsChanged, map, scene, core, requestRepaint };
}

async function loadEiffel(s: ReturnType<typeof setup>) {
  s.module.update(view());
  await flush();
  const object = new Group();
  s.loads[0]!.d.resolve({ object, bytes: 10 });
  await flush();
  return object;
}

describe('LandmarksModule', () => {
  it('applies the lighting preset on add', () => {
    const s = setup({ lighting: 'night' });
    expect(s.core.setLighting).toHaveBeenCalledWith('night');
  });

  it('does nothing below zoom 14', async () => {
    const s = setup();
    s.module.update(view({ zoom: 13 }));
    await flush();
    expect(s.f.calls).toEqual([]);
  });

  it('discovers, loads and adds a landmark to the scene', async () => {
    const s = setup();
    const object = await loadEiffel(s);
    expect(s.loads[0]!.entry.id).toBe('eiffel');
    expect(s.loads[0]!.lod).toBe('low');
    expect(s.scene.children).toContain(object);
    expect(s.requestRepaint).toHaveBeenCalled();
    expect(s.onModelsChanged).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: 'eiffel', lod: 'low', attribution: 'IGN LiDAR' }),
    ]);
    expect(s.module.getAttribution()).toContain('IGN LiDAR');
    expect((s.map.sources.get('landmarks-attribution') as { attribution: string }).attribution).toContain(
      'IGN LiDAR',
    );
  });

  it('hides the basemap building once the model is in the scene', async () => {
    const s = setup();
    s.module.update(view());
    await flush();
    expect(s.map.setFilter).not.toHaveBeenCalled();
    s.loads[0]!.d.resolve({ object: new Group(), bytes: 10 });
    await flush();
    expect((s.map.filters.buildings as unknown[])[0]).toBe('all');
  });

  it('places models relative to the origin, with terrain elevation', async () => {
    const s = setup();
    const object = await loadEiffel(s);
    s.module.place(originAt([2.2945, 48.8584]));
    expect(object.position.x).toBeCloseTo(0, 6);
    expect(object.position.y).toBe(0);
    s.map.setTerrain({});
    s.module.place(originAt([2.2945, 48.8584]));
    expect(object.position.y).toBe(35);
  });

  it('stays quiet when nothing is published', async () => {
    const s = setup({}, routes({ [`${BASE}/api/v1/latest.json`]: { ...POINTER, catalogue: null } }));
    s.module.update(view());
    await flush();
    expect(s.onError).not.toHaveBeenCalled();
    expect(s.f.calls).toHaveLength(1);
  });

  it('reports catalogue failures once and recovers on the next update', async () => {
    const r = routes({ [`${BASE}/api/v1/latest.json`]: 503 });
    const s = setup({}, r);
    s.module.update(view());
    await flush();
    expect(s.onError).toHaveBeenCalledTimes(1);
    expect(s.onError.mock.calls[0]![1]).toEqual({ stage: 'catalogue' });
    r[`${BASE}/api/v1/latest.json`] = POINTER;
    s.module.update(view());
    await flush();
    expect(s.loads).toHaveLength(1);
  });

  it('reports cell failures with the cell stage', async () => {
    const s = setup({}, routes({ [CELL]: 500 }));
    s.module.update(view());
    await flush();
    expect(s.onError.mock.calls[0]![1]).toEqual({ stage: 'cell' });
  });

  it('ignores superseded discovery runs', async () => {
    const s = setup();
    s.module.update(view());
    s.module.update(view({ bounds: [-74.02, 40.7, -73.98, 40.72], center: [-74, 40.71] }));
    await flush();
    expect(s.loads).toHaveLength(0);
  });

  it('onRemove clears the scene, restores filters and drops attribution; late loads are discarded', async () => {
    const s = setup();
    s.module.update(view());
    await flush();
    s.module.onRemove();
    const late = new Group();
    s.loads[0]!.d.resolve({ object: late, bytes: 1 });
    await flush();
    expect(s.scene.children).not.toContain(late);
    expect(s.map.filters.buildings).toEqual(['in', 'kind', 'building', 'building_part']);
    expect(s.map.sources.size).toBe(0);
    expect(s.onError).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `npx vitest run tests/unit/landmarks.test.ts`
Expected: FAIL with "Failed to resolve import ../../src/landmarks/LandmarksModule".

- [ ] **Step 6: Implement LandmarksModule**

`src/landmarks/LandmarksModule.ts`:
```ts
import type { Object3D } from 'three';
import type { LayerModule, ModuleContext } from '../core/LayerModule';
import type { LightingPreset } from '../core/lighting';
import { localPosition } from '../core/mercator';
import type { LngLat, Origin, ViewState } from '../core/types';
import { AttributionSource, attributionText } from './attribution';
import {
  DEFAULT_BASE_URL,
  globalFetch,
  resolveCatalogue,
  type Catalogue,
  type Channel,
  type Fetch,
  type LandmarkEntry,
  type Lod,
} from './catalogue';
import { CellIndex, cellsForView, selectWanted } from './discovery';
import { fetchGlb, isAbort, ModelCache, parseGlb } from './loader';
import { BuildingReplacement } from './replacement';
import { Residency, type LoadFn } from './residency';

export const DISCOVERY_MIN_ZOOM = 14;

export interface ErrorContext {
  stage: 'catalogue' | 'cell' | 'model';
  id?: string;
}

export interface LandmarkInfo {
  id: string;
  revision: string;
  name?: string;
  anchor: LngLat;
  lod: Lod;
  attribution: string;
}

export interface LandmarksOptions {
  channel?: Channel;
  catalogueUrl?: string;
  baseUrl?: string;
  replaceBuildings?: string[];
  replacementInsetM?: number;
  maxResident?: number;
  maxCached?: number;
  maxCacheBytes?: number;
  lighting?: LightingPreset;
  fetch?: Fetch;
  onError?: (err: unknown, ctx: ErrorContext) => void;
  onModelsChanged?: (visible: LandmarkInfo[]) => void;
}

export class LandmarksModule implements LayerModule {
  private ctx?: ModuleContext;
  private catalogue?: Promise<Catalogue | null>;
  private resolved: Catalogue | null = null;
  private index?: CellIndex;
  private replacement?: BuildingReplacement;
  private attribution?: AttributionSource;
  private readonly cache: ModelCache;
  private readonly residency: Residency;
  private readonly placed = new Map<Object3D, LandmarkEntry>();
  private readonly fetchFn: Fetch;
  private readonly baseUrl: string;
  private lighting: LightingPreset;
  private run = 0;

  constructor(
    private readonly id: string,
    private readonly opts: LandmarksOptions = {},
    load?: LoadFn,
  ) {
    this.fetchFn = opts.fetch ?? globalFetch;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.lighting = opts.lighting ?? 'day';
    this.cache = new ModelCache(opts.maxCached ?? 12, opts.maxCacheBytes ?? 32 * 1024 * 1024);
    const defaultLoad: LoadFn = async (entry, lod, signal) => {
      const buffer = await fetchGlb(entry.lods[lod], this.baseUrl, this.fetchFn, signal);
      return { object: await parseGlb(buffer), bytes: buffer.byteLength };
    };
    this.residency = new Residency({
      load: load ?? defaultLoad,
      cache: this.cache,
      onChange: () => this.modelsChanged(),
      onError: (err, entry) => this.report(err, { stage: 'model', id: entry.id }),
    });
  }

  onAdd(ctx: ModuleContext): void {
    this.ctx = ctx;
    ctx.core.setLighting(this.lighting);
    this.replacement = new BuildingReplacement(
      ctx.map,
      this.opts.replaceBuildings ?? [],
      this.opts.replacementInsetM ?? 1.5,
    );
    this.attribution = new AttributionSource(ctx.map, `${this.id}-attribution`);
  }

  update(view: ViewState): void {
    const run = ++this.run;
    if (view.zoom < DISCOVERY_MIN_ZOOM) {
      this.residency.setWanted([]);
      return;
    }
    void this.discover(view, run);
  }

  place(origin: Origin): void {
    const map = this.ctx?.map;
    for (const [object, entry] of this.placed) {
      const elevation = map?.getTerrain() ? (map.queryTerrainElevation(entry.anchor) ?? 0) : 0;
      const [x, y, z] = localPosition(origin, entry.anchor, elevation);
      object.position.set(x, y, z);
      object.updateMatrixWorld();
    }
  }

  onRemove(): void {
    this.run++;
    for (const object of this.placed.keys()) this.ctx?.scene.remove(object);
    this.placed.clear();
    this.residency.clear();
    this.cache.clear();
    this.replacement?.restore();
    this.attribution?.remove();
    this.ctx = undefined;
  }

  setLighting(preset: LightingPreset): void {
    this.lighting = preset;
    this.ctx?.core.setLighting(preset);
  }

  getVisibleModels(): LandmarkInfo[] {
    const fallback = this.resolved?.attribution ?? '';
    return this.residency.models().map(({ entry, lod }) => ({
      id: entry.id,
      revision: entry.revision,
      name: entry.name,
      anchor: entry.anchor,
      lod,
      attribution: entry.attribution ?? fallback,
    }));
  }

  getAttribution(): string {
    return attributionText(this.getVisibleModels(), this.resolved?.attribution);
  }

  private getCatalogue(): Promise<Catalogue | null> {
    if (!this.catalogue) {
      const p = resolveCatalogue({
        baseUrl: this.baseUrl,
        channel: this.opts.channel,
        catalogueUrl: this.opts.catalogueUrl,
        fetch: this.fetchFn,
      });
      this.catalogue = p;
      p.then(
        (cat) => (this.resolved = cat),
        () => {
          if (this.catalogue === p) this.catalogue = undefined;
        },
      );
    }
    return this.catalogue;
  }

  private async discover(view: ViewState, run: number): Promise<void> {
    let stage: ErrorContext['stage'] = 'catalogue';
    try {
      const cat = await this.getCatalogue();
      if (!cat || run !== this.run) return;
      stage = 'cell';
      this.index ??= new CellIndex(cat, this.fetchFn);
      const entries = await this.index.entries(cellsForView(view, cat));
      if (run !== this.run) return;
      this.residency.setWanted(selectWanted(entries, view, cat, this.opts.maxResident ?? 8));
    } catch (err) {
      if (!isAbort(err)) this.report(err, { stage });
    }
  }

  private modelsChanged(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const models = this.residency.models();
    const live = new Set(models.map((m) => m.object));
    for (const object of [...this.placed.keys()]) {
      if (!live.has(object)) {
        ctx.scene.remove(object);
        this.placed.delete(object);
      }
    }
    for (const m of models) {
      if (!this.placed.has(m.object)) {
        ctx.scene.add(m.object);
        this.placed.set(m.object, m.entry);
      }
    }
    this.replacement?.update(models.map((m) => m.entry));
    const visible = this.getVisibleModels();
    this.attribution?.set(visible.length ? this.getAttribution() : '');
    this.opts.onModelsChanged?.(visible);
    ctx.requestRepaint();
  }

  private report(err: unknown, ctx: ErrorContext): void {
    if (this.opts.onError) this.opts.onError(err, ctx);
    else console.warn('[maplibre-landmarks]', ctx, err);
  }
}
```

- [ ] **Step 7: Implement the public layer and exports**

`src/landmarks/LandmarksLayer.ts`:
```ts
import type { LightingPreset } from '../core/lighting';
import { ModuleLayer, type ModuleLayerOptions } from '../core/ModuleLayer';
import { LandmarksModule, type LandmarkInfo, type LandmarksOptions } from './LandmarksModule';

export interface LandmarksLayerOptions extends LandmarksOptions, ModuleLayerOptions {
  id: string;
}

/** MapLibre custom layer that renders Open Landmarks 3D models. */
export class LandmarksLayer extends ModuleLayer {
  private readonly landmarks: LandmarksModule;

  constructor(options: LandmarksLayerOptions) {
    const landmarks = new LandmarksModule(options.id, options);
    super(options.id, landmarks, options);
    this.landmarks = landmarks;
  }

  setLighting(preset: LightingPreset): void {
    this.landmarks.setLighting(preset);
  }

  getVisibleModels(): LandmarkInfo[] {
    return this.landmarks.getVisibleModels();
  }

  getAttribution(): string {
    return this.landmarks.getAttribution();
  }
}
```

`src/index.ts`:
```ts
export { LandmarksLayer, type LandmarksLayerOptions } from './landmarks/LandmarksLayer';
export {
  DISCOVERY_MIN_ZOOM,
  LandmarksModule,
  type ErrorContext,
  type LandmarkInfo,
  type LandmarksOptions,
} from './landmarks/LandmarksModule';
export type { Catalogue, Channel, Footprint, LandmarkEntry, Lod, LodRef } from './landmarks/catalogue';
export { ModuleLayer, viewStateOf, type ModuleLayerOptions } from './core/ModuleLayer';
export type { LayerModule, ModuleContext } from './core/LayerModule';
export {
  acquireCore,
  createWebGLRenderer,
  releaseCore,
  ThreeCore,
  type RendererFactory,
  type RendererLike,
} from './core/ThreeCore';
export { LIGHTING, type LightingPreset } from './core/lighting';
export { cameraMatrix, localPosition, originAt } from './core/mercator';
export type { Bounds, LngLat, Origin, ViewState } from './core/types';
```

- [ ] **Step 8: Run all unit tests**

Run: `npx vitest run`
Expected: PASS for every file. Counts: mercator 5, catalogue 10, discovery 13, loader 12, residency 8, replacement 10, core 6, attribution 4, landmarks 10.

- [ ] **Step 9: Build the library**

Run: `npm run build && ls dist && grep -c "from \"three\"\|from 'three'" dist/maplibre-landmarks.js`
Expected:
- `dist/maplibre-landmarks.js` and `dist/index.d.ts` exist.
- The grep count is ≥1, meaning three is external and not bundled.
- `du -k dist/maplibre-landmarks.js` is under 100 KB.

- [ ] **Step 10: Lint.** Run `npm run lint`. Expected: clean. If Prettier complains, run `npx prettier --write .` and re-run.

- [ ] **Step 11: Checkpoint.** Do not commit.

---

### Task 9: Demo and browser test

**Files:**
- Create: `demo/vite.config.ts`, `demo/index.html`, `demo/main.ts`, `demo/styles.css`, `demo/e2e.html`, `demo/e2e.ts`
- Create: `playwright.config.ts`, `tests/browser/target.ts`, `tests/browser/landmarks.pw.ts`
- Create: `.env.example`

**Interfaces:**
- Consumes: `LandmarksLayer`, `LandmarkInfo`, `LightingPreset` from `src/index.ts`
- Produces:
  - `window.__start(t: Target): Promise<void>` and `window.__state: { models: LandmarkInfo[]; errors: string[] }`, used by the browser test
  - `findTarget(): Promise<Target>`, where `Target = { anchor: [number, number]; footprint: object; neighbour: object }`

- [ ] **Step 1: Demo build config and pages**

`demo/vite.config.ts`:
```ts
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: resolve(import.meta.dirname),
  envDir: resolve(import.meta.dirname, '..'),
  server: { port: 5179, strictPort: true },
  build: {
    outDir: resolve(import.meta.dirname, '../dist-demo'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        e2e: resolve(import.meta.dirname, 'e2e.html'),
      },
    },
  },
});
```

`.env.example`:
```
# One of these is required for the demo basemap (not for e2e.html).
# Free key: https://protomaps.com/account
VITE_PROTOMAPS_KEY=
# Or your own archive, e.g. https://example.com/planet.pmtiles
VITE_PMTILES_URL=
```

`demo/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>maplibre-landmarks demo</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <div id="map"></div>
    <aside id="panel">
      <h1>Open Landmarks</h1>
      <label>Channel
        <select id="channel"><option value="latest">latest (approved)</option><option value="preview">preview (drafts)</option></select>
      </label>
      <label>Lighting
        <select id="lighting"><option>day</option><option>dawn</option><option>night</option></select>
      </label>
      <label><input type="checkbox" id="terrain" /> Terrain</label>
      <h2>Loaded models</h2>
      <ul id="models"></ul>
    </aside>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

`demo/styles.css`:
```css
html, body { margin: 0; height: 100%; font: 14px/1.4 system-ui, sans-serif; }
#map { position: absolute; inset: 0; }
#panel {
  position: absolute; top: 12px; left: 12px; width: 260px; max-height: calc(100% - 24px); overflow: auto;
  background: #fffffff0; border-radius: 8px; padding: 12px 14px; box-shadow: 0 2px 10px #0003;
}
#panel h1 { font-size: 16px; margin: 0 0 8px; }
#panel h2 { font-size: 13px; margin: 12px 0 4px; }
#panel label { display: block; margin: 6px 0; }
#panel ul { padding-left: 18px; margin: 0; }
#panel li small { display: block; color: #666; }
.missing { padding: 24px; }
```

`demo/main.ts`:
```ts
import { Map as MlMap, addProtocol, setWorkerUrl, type StyleSpecification } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { layers, namedFlavor } from '@protomaps/basemaps';
import { Protocol } from 'pmtiles';
import { LandmarksLayer, type LandmarkInfo, type LightingPreset } from '../src/index';

setWorkerUrl(workerUrl);

const key = import.meta.env.VITE_PROTOMAPS_KEY as string | undefined;
const pmtilesUrl = import.meta.env.VITE_PMTILES_URL as string | undefined;
if (!key && !pmtilesUrl) {
  document.body.innerHTML =
    '<p class="missing">Set <code>VITE_PROTOMAPS_KEY</code> or <code>VITE_PMTILES_URL</code> in <code>.env.local</code> (see <code>.env.example</code>).</p>';
  throw new Error('No basemap tiles configured');
}
if (pmtilesUrl) addProtocol('pmtiles', new Protocol().tile);

const style: StyleSpecification = {
  version: 8,
  glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
  sprite: 'https://protomaps.github.io/basemaps-assets/sprites/v4/light',
  sources: {
    protomaps: {
      type: 'vector',
      url: pmtilesUrl ? `pmtiles://${pmtilesUrl}` : `https://api.protomaps.com/tiles/v4.json?key=${key}`,
      attribution: '<a href="https://protomaps.com">Protomaps</a> © <a href="https://openstreetmap.org">OpenStreetMap</a>',
    },
    terrain: {
      type: 'raster-dem',
      tiles: ['https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png'],
      encoding: 'terrarium',
      tileSize: 256,
      maxzoom: 15,
    },
  },
  layers: layers('protomaps', namedFlavor('light'), { lang: 'en' }),
};

const map = new MlMap({
  container: 'map',
  style,
  center: [2.2945, 48.8584],
  zoom: 16.5,
  pitch: 60,
  bearing: -20,
  hash: true,
});

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let layer: LandmarksLayer | undefined;
let lighting: LightingPreset = 'day';

function renderList(models: LandmarkInfo[]) {
  $('models').innerHTML = models
    .map((m) => `<li>${m.name ?? m.id} <em>(${m.lod})</em><small>${m.attribution}</small></li>`)
    .join('');
}

function addLandmarks(channel: 'latest' | 'preview') {
  if (layer) map.removeLayer(layer.id);
  layer = new LandmarksLayer({
    id: 'landmarks',
    channel,
    lighting,
    replaceBuildings: ['buildings'],
    onModelsChanged: renderList,
    onError: (err, ctx) => console.warn('[landmarks]', ctx, err),
  });
  const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
  map.addLayer(layer, firstSymbol);
}

map.on('load', () => addLandmarks('latest'));
$<HTMLSelectElement>('channel').onchange = (e) =>
  addLandmarks((e.target as HTMLSelectElement).value as 'latest' | 'preview');
$<HTMLSelectElement>('lighting').onchange = (e) => {
  lighting = (e.target as HTMLSelectElement).value as LightingPreset;
  layer?.setLighting(lighting);
};
$<HTMLInputElement>('terrain').onchange = (e) =>
  map.setTerrain((e.target as HTMLInputElement).checked ? { source: 'terrain', exaggeration: 1 } : null);
```

`demo/e2e.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>e2e</title>
    <style>html, body, #map { margin: 0; width: 1024px; height: 768px; }</style>
  </head>
  <body>
    <div id="map"></div>
    <script type="module" src="./e2e.ts"></script>
  </body>
</html>
```

`demo/e2e.ts`:
```ts
import { Map as MlMap, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { LandmarksLayer, type LandmarkInfo } from '../src/index';

setWorkerUrl(workerUrl);

interface Target {
  anchor: [number, number];
  footprint: GeoJSON.Geometry;
  neighbour: GeoJSON.Geometry;
}

declare global {
  interface Window {
    __start(t: Target): Promise<void>;
    __state: { models: LandmarkInfo[]; errors: string[] };
    __map?: MlMap;
  }
}

window.__state = { models: [], errors: [] };

// Blank style + a legacy-filtered "buildings" layer, like Protomaps, so no tile key is needed.
window.__start = async ({ anchor, footprint, neighbour }) => {
  const map = new MlMap({
    container: 'map',
    center: anchor,
    zoom: 16.5,
    pitch: 50,
    canvasContextAttributes: { preserveDrawingBuffer: true },
    style: {
      version: 8,
      sources: {
        b: {
          type: 'geojson',
          data: {
            type: 'FeatureCollection',
            features: [
              { type: 'Feature', properties: { kind: 'building', name: 'landmark' }, geometry: footprint },
              { type: 'Feature', properties: { kind: 'building', name: 'neighbour' }, geometry: neighbour },
            ],
          },
        },
      },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#ffffff' } },
        {
          id: 'buildings',
          type: 'fill',
          source: 'b',
          filter: ['in', 'kind', 'building', 'building_part'],
          paint: { 'fill-color': '#ff0000' },
        },
      ],
    },
  });
  window.__map = map;
  map.on('error', (e) => window.__state.errors.push(String(e.error?.message ?? e)));
  await map.once('load');
  map.addLayer(
    new LandmarksLayer({
      id: 'landmarks',
      replaceBuildings: ['buildings'],
      onModelsChanged: (m) => (window.__state.models = m),
      onError: (err, ctx) => window.__state.errors.push(`${ctx.stage}: ${String(err)}`),
    }),
  );
};
```

- [ ] **Step 2: Browser test**

`playwright.config.ts`:
```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/browser',
  testMatch: '**/*.pw.ts',
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:5179',
    viewport: { width: 1024, height: 768 },
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
  webServer: {
    command: 'npx vite --config demo/vite.config.ts',
    url: 'http://localhost:5179/e2e.html',
    reuseExistingServer: true,
  },
});
```

`tests/browser/target.ts`:
```ts
const BASE = 'https://open-landmarks.benmaps.fr';
const M_PER_DEG = 111_195;

async function json<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  return (await res.json()) as T;
}

interface Asset {
  anchor: [number, number];
  bounds: [number, number, number, number];
  replacementFootprint: { type: string; coordinates: unknown } | null;
}

/** First approved landmark with a footprint, plus a 30 m neighbour square 40 m east of its bounds. */
export async function findTarget() {
  const ptr = await json<{ catalogue: string | null }>('/api/v1/latest.json');
  if (!ptr.catalogue) throw new Error('latest channel has no release');
  const cat = await json<{ index: { template: string; occupied: string[] } }>(ptr.catalogue);
  for (const cell of cat.index.occupied) {
    const [x, y] = cell.split('/');
    const body = await json<{ assets: Asset[] }>(cat.index.template.replace('{x}', x!).replace('{y}', y!));
    const a = body.assets.find((e) => e.replacementFootprint);
    if (!a) continue;
    const lat = a.anchor[1];
    const kx = M_PER_DEG * Math.cos((lat * Math.PI) / 180);
    const w = a.bounds[2] + 40 / kx;
    const e = w + 30 / kx;
    const s = lat - 15 / M_PER_DEG;
    const n = lat + 15 / M_PER_DEG;
    return {
      anchor: a.anchor,
      footprint: a.replacementFootprint,
      neighbour: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
    };
  }
  throw new Error('no approved landmark with a replacement footprint');
}
```

`tests/browser/landmarks.pw.ts`:
```ts
import { expect, test } from '@playwright/test';
import type {} from '../../demo/e2e'; // brings window.__start / __state / __map types
import { findTarget } from './target';

test('renders a live landmark and replaces only the building under it', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });

  const target = await findTarget();
  await page.goto('/e2e.html');
  await page.evaluate((t) => window.__start(t as never), target);

  await page.waitForFunction(() => window.__state.models.length > 0, null, { timeout: 45_000 });
  await page.evaluate(
    () => new Promise<void>((resolve) => {
      window.__map!.triggerRepaint();
      window.__map!.once('idle', () => resolve());
    }),
  );

  const names = await page.evaluate(() =>
    window.__map!.queryRenderedFeatures({ layers: ['buildings'] }).map((f) => f.properties.name),
  );
  expect(names).toContain('neighbour');
  expect(names).not.toContain('landmark');

  const coloured = await page.evaluate(() => {
    const src = window.__map!.getCanvas();
    const c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(src, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const white = d[i]! > 245 && d[i + 1]! > 245 && d[i + 2]! > 245;
      const red = d[i]! > 200 && d[i + 1]! < 60 && d[i + 2]! < 60;
      if (!white && !red) n++;
    }
    return n / (d.length / 4);
  });
  expect(coloured).toBeGreaterThan(0.01);

  const restored = await page.evaluate(() => {
    window.__map!.removeLayer('landmarks');
    return window.__map!.getFilter('buildings');
  });
  expect(restored).toEqual(['in', 'kind', 'building', 'building_part']);

  expect(await page.evaluate(() => window.__state.errors)).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
```

- [ ] **Step 3: Install the browser and run the test**

Run:
```bash
npx playwright install chromium
npm run test:browser
```
Expected: 1 passed. If it fails, debug with `npx playwright test --headed` and the `superpowers:systematic-debugging` skill. Likely causes:
- **Model invisible.** Log `window.__map.transform` or check the axis mapping in `cameraMatrix`. Don't touch the unit-tested math until you've found the root cause.
- **`landmark` still rendered.** MapLibre may not support `distance` in a filter for this layer type. Check `window.__state.errors` and the map `error` event. Report to the user before changing the design.
- **Console errors from SwiftShader or WebGL warnings.** Filter only exact, known-benign messages, and list each one in the test with a comment.

- [ ] **Step 4: Manual demo check (if a key is available)**

Run: `cp .env.example .env.local`, set `VITE_PROTOMAPS_KEY`, then `npm run dev` and open http://localhost:5179.
Expected:
- The Eiffel Tower area shows 3D models.
- The panel lists models with their attributions.
- The lighting select changes the shading.
- Terrain toggles without models floating or sinking.
- The attribution control shows the Open Landmarks text.

If no key is available, skip this step and say so in the report.

- [ ] **Step 5: Lint and typecheck.** Run `npx tsc --noEmit && npm run lint`. Expected: clean. If `tsc` can't resolve `?worker&url`, the `vite/client` types in `tsconfig.json` cover it. Check that `"types": ["vite/client", "node"]` is present.

- [ ] **Step 6: Checkpoint.** Do not commit.

---

### Task 10: README and release check

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write the README**

`README.md`:
````markdown
# maplibre-landmarks

3D landmark models from [Open Landmarks](https://open-landmarks.benmaps.fr) for
[MapLibre GL JS](https://maplibre.org), rendered with [Three.js](https://threejs.org).
Built for Protomaps basemaps, with a shared 3D core ready for future tree and water layers.

## Install

```bash
npm install maplibre-landmarks maplibre-gl three
```

## Usage

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

### Options

| Option | Default | Description |
| --- | --- | --- |
| `id` | required | Layer id |
| `channel` | `'latest'` | `'latest'` (approved) or `'preview'` (includes drafts) |
| `catalogueUrl` | — | Pinned catalogue path or URL; overrides `channel` |
| `baseUrl` | `https://open-landmarks.benmaps.fr` | API origin |
| `replaceBuildings` | `[]` | Basemap layer ids whose buildings are hidden under loaded models |
| `replacementInsetM` | `1.5` | Footprint inset so neighbours sharing a wall stay visible |
| `maxResident` | `8` | Models kept on the GPU |
| `maxCached` / `maxCacheBytes` | `12` / 32 MB | Parsed models kept off-screen |
| `lighting` | `'day'` | `'day'`, `'dawn'` or `'night'` |
| `onModelsChanged` | — | Called with the visible models (id, name, LOD, attribution) |
| `onError` | `console.warn` | `(err, { stage, id? })` |

Methods: `setLighting(preset)`, `getVisibleModels()`, `getAttribution()`.

Models appear from zoom 15 (as declared per model), swap to the detail LOD at each model's
`detailZoom`, follow terrain when `map.setTerrain` is on, and require the flat (mercator) view;
globe projection switches to mercator well before landmark zooms.

Use `replaceBuildings` on only one `LandmarksLayer` per basemap layer.

## Attribution and licences

Open Landmarks models are **CC BY 4.0** (artistic contributions) and contain OpenStreetMap-derived
data under **ODbL 1.0**; some models include other sources (e.g. IGN LiDAR HD, Licence Ouverte 2.0).
The layer adds the required attribution to MapLibre's attribution control automatically and exposes
it via `getAttribution()`. See https://open-landmarks.benmaps.fr/licenses/.

This library is MIT licensed. It is not affiliated with Open Landmarks or benmaps.fr.

## Development

```bash
npm install
npm test               # unit tests
npm run test:browser   # Playwright, uses the live Open Landmarks API
cp .env.example .env.local   # add a Protomaps key for the demo
npm run dev            # demo at http://localhost:5179
npm run build
```

## Extending

`ModuleLayer` + `LayerModule` let other 3D content share the same Three.js renderer:
implement `onAdd`, `update(view)`, `place(origin)`, optional `frame(time)` and `onRemove`, and
wrap it in `new ModuleLayer(id, module)`. Coordinates are metres in glTF axes (X east, Y up, Z south)
relative to the per-frame `origin`; use `localPosition(origin, lngLat, elevation)`.
````

- [ ] **Step 2: Full verification**

Run:
```bash
npm test && npm run lint && npm run build && npm pack --dry-run
```
Expected:
- All unit tests pass and lint is clean.
- The build succeeds.
- `npm pack --dry-run` lists only `dist/*`, `README.md`, `LICENSE` and `package.json`.

- [ ] **Step 3: Check the npm name**

Run: `npm view maplibre-landmarks name 2>&1 | head -1`
Expected: an E404, meaning the name is free. If the name is taken, tell the user and propose a scoped alternative such as `@<user>/maplibre-landmarks`. Do not rename on your own.

- [ ] **Step 4: Checkpoint.** Do not commit, and do not publish. Summarise the results for the user, including the browser test output and whether the manual demo check ran.
