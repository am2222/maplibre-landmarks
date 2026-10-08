# Volumetric Fog, Revision 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Landscape-aware, realistic fog (spec section 6): a fog layer with a billowing top surface that pools in valleys with terrain, banks from thresholded noise, lit colour, zoom-scaled noise, auto radius; demo with hillshade, 85° pitch and Paris / Chamonix views.

**Spec:** `docs/superpowers/specs/2026-10-08-volumetric-fog-design.md` (section 6)

## Global Constraints

- Worktree `/Users/majid/maplibre-landmarks-fog`, branch `feat/volumetric-fog`; no commits.
- `height` default 40; `coverage` default 0.65; `soft = max(8, 0.35 × thickness)`; cell `2^clamp(round(23 − zoom), 7, 10)` m; radius default `max(1500, 1.5 × camera-to-centre)`; theme dusk `#b7aec8`, night `#5d6888`.
- Browser tests run with a scratch config on port 5181 (`playwright.fog.local.ts`, deleted afterwards).

## Review Focus

- Terrain on with the centre on a slope: valleys below the centre must get fog (no centre-height clipping). Unit-tested via `valleyFloor` and the module's `uClip`.
- Zooming between z13 and z16: noise cell changes only when the camera settles (no swimming). Unit-tested (`update` sets `uCell`).
- Explicit `altitude` below the valley floor: no fog, no errors (fill is 0).
- Flat maps: the ground clip at 0 keeps street-level detail visible (existing browser test).
- Theme switch: colours follow (existing tests).

### Task 1: Profile helpers (`src/fog/profile.ts`)

- Produces: `rampIntegral(t)`, `fogFill(ta, tb)`, `noiseCell(zoom)`, `valleyFloor(map, grid?)` (code in the file; mirrored by the shader).
- [ ] Write `tests/unit/fogProfile.test.ts` (fill vs numeric integral; cells; grid minimum and null), run red.
- [ ] Implement `src/fog/profile.ts`, run green.

### Task 2: Shader and module (`src/fog/shaders.ts`, `src/fog/FogModule.ts`, `src/fog/FogLayer.ts`, `src/fog/colors.ts`)

- Uniforms: remove `uGround`, `uHeight`; add `uTop`, `uSoft`, `uClip`, `uCoverage`, `uCell`, `uPeriod`.
- Module: `update` sets the cell from zoom, refreshes the floor (terrain: `valleyFloor ?? centre`, else 0) and the top (`terrain ? altitude ?? floor + height : height`; clip `-1e6` with terrain, else 0); camera distance from the centre's ground; auto radius; setters `setHeight`, `setAltitude`, `setCoverage` (also on `FogLayer`).
- Fragment: clip segment below `uClip`; billowing top `uTop + (n − 0.5)·2·uSoft`; `fill = fogFill(ta, tb)` with `t = (top − alt)/uSoft`; banks `smoothstep(1 − c − 0.2, 1 − c + 0.2, n)`; colour ×1.08 near the top to ×0.82 deep inside, plus sun glow.
- [ ] Update `tests/unit/fogModule.test.ts` (top/clip without and with terrain, altitude override, setters, cell, auto radius), run red.
- [ ] Implement, run green; whole suite green.

### Task 3: Demo, docs, verification

- [ ] Demo: `maxPitch: 85`; hillshade layer (own `raster-dem` source) visible with terrain; buttons **Paris** (terrain off, fog height 40) and **Chamonix** (`#12.6/45.92/6.87/-40/72`, terrain on, fog height 350).
- [ ] README fog table: `height` (thickness), `altitude`, `coverage`, new setters.
- [ ] Full check: tsc, vitest, lint, build, Playwright (scratch config); screenshots of Paris (day, dusk) and Chamonix (fog off / on).
