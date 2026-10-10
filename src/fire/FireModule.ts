import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  CustomBlending,
  DataTexture,
  DoubleSide,
  Float32BufferAttribute,
  FloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NearestFilter,
  OneFactor,
  OneMinusSrcAlphaFactor,
  Points,
  RedFormat,
  RGBAFormat,
  ShaderMaterial,
  Vector2,
  Vector3,
  type IUniform,
} from 'three';
import { polygonsOf } from '../core/geometry';
import type { LayerModule, ModuleContext } from '../core/LayerModule';
import { lngLatAt, localPosition, mercatorX, mercatorY, originAt } from '../core/mercator';
import { THEMES, type Theme } from '../core/theme';
import type { LngLat, Origin, ViewState } from '../core/types';
import { NOISE_PERIOD_M, noiseOrigin } from '../fog/slices';
import { windVector } from '../trees/material';
import {
  buildField,
  fronts,
  outwardAt,
  resample,
  sampleField,
  type FireField,
  type FirePolygons,
} from './field';
import {
  EMBER_FRAGMENT,
  EMBER_VERTEX,
  FLAME_FRAGMENT,
  FLAME_VERTEX,
  GROUND_FRAGMENT,
  GROUND_VERTEX,
  SMOKE_FRAGMENT,
  SMOKE_VERTEX,
  TIME_PERIOD_S,
} from './shaders';

/** GeoJSON with Polygon / MultiPolygon geometries: a FeatureCollection, Feature or geometry. */
export type FireData =
  | { type: 'FeatureCollection'; features: FireData[] }
  | { type: 'Feature'; geometry: unknown; properties?: Record<string, unknown> | null }
  | { type: string; coordinates?: unknown; geometries?: unknown[] };

export interface FireWind {
  /** Metres per second (default 5). */
  speed?: number;
  /** Where the wind blows from, degrees clockwise from north (default 225). */
  directionDeg?: number;
}

export interface FireOptions {
  /** Fire perimeters (GeoJSON polygons); see `setData`. */
  data?: FireData;
  /** Depth of the flaming front in metres (default 70). Sizes the whole look: smaller for small fires. */
  frontDepth?: number;
  /** How high flame tongues reach, metres (default 1.5 × the front depth). */
  flameHeight?: number;
  /** Flame tongues along the fronts (default 3000; 0 for none). */
  flames?: number;
  /** Smoke density 0–1 (default 0.7); 0 or false for no smoke. */
  smoke?: number | false;
  /** Smoke puffs along the fronts (default 600). */
  smokePuffs?: number;
  /** How high the smoke column rises before it levels off, metres (default 12 × the front depth). */
  smokeHeight?: number;
  /**
   * How far the plume trails downwind, metres (default: grows with the wind, from 1.5 to
   * about 8 × the smoke height). Calm air leaves an upright column.
   */
  plumeLength?: number;
  /** How far firelight reaches over the unburned ground, metres (default 3 × the front depth). */
  glowRadius?: number;
  wind?: FireWind;
  /** Base rate of spread, metres per fire minute (default 4). */
  rate?: number;
  /** Fire minutes per second on screen (default 1). */
  timeScale?: number;
  /** Spread from the mapped perimeters as time passes (default true). */
  playing?: boolean;
  /** Spreading stops after this many metres at the base rate (default 2000). */
  maxSpread?: number;
  /** How much uphill slopes speed the front up (and downhill slows it), default 1; 0 ignores terrain. */
  slope?: number;
  /** Opacity of the burned ground over the map, 0–1 (default 0.85). */
  charOpacity?: number;
  /** Brightness of flames, embers and firelight (default 1). */
  intensity?: number;
  /** Flying embers (default 900; 0 for none). */
  embers?: number;
  /** Distance field cells across the drawn area (default 512): finer fronts cost more per update. */
  resolution?: number;
  /** Spacing of the terrain samples the burned ground is draped on, metres (default 20). */
  terrainSpacing?: number;
  /** Largest area drawn around the view, metres across (default 40 km). */
  maxExtent?: number;
  /** A feature's spread multiplier (default: its numeric `rate` property, else 1). */
  featureRate?: (properties: Record<string, unknown>) => number;
  /** Whether a feature is still burning (default: unless its `active` property is false). */
  featureActive?: (properties: Record<string, unknown>) => boolean;
  minZoom?: number;
  onError?: (err: unknown) => void;
}

export interface FireStats {
  /** Fires in the drawn area. */
  fires: number;
  /** Mapped burned area of those fires, hectares. */
  mappedHa: number;
  /** Fire minutes since the mapped perimeters. */
  elapsedMin: number;
  /** How far a front at the base rate has moved, metres. */
  spreadM: number;
  /** Time the last field update took, milliseconds. */
  updateMs: number;
}

export interface FireUniforms {
  [name: string]: IUniform;
  uOrigin: IUniform<Vector2>;
  uNoiseScale: IUniform<number>;
  uUnit: IUniform<number>;
  uTime: IUniform<number>;
  uDrift: IUniform<Vector2>;
  uGrowth: IUniform<number>;
  uWind: IUniform<number>;
  uWindDir: IUniform<Vector2>;
  uSlope: IUniform<number>;
  uBand: IUniform<number>;
  uGlow: IUniform<number>;
  uFlameH: IUniform<number>;
  uSmoke: IUniform<number>;
  uSmokeH: IUniform<number>;
  uPlume: IUniform<number>;
  uSmokeLight: IUniform<Color>;
  uChar: IUniform<number>;
  uIntensity: IUniform<number>;
  uLift: IUniform<number>;
  uField: IUniform<DataTexture | null>;
  uFieldRect: IUniform<Vector3>;
  uFieldSize: IUniform<Vector2>;
  uHeight: IUniform<DataTexture | null>;
  uHeightRect: IUniform<Vector3>;
  uHeightSize: IUniform<Vector2>;
}

interface Fire {
  /** Polygons in lng/lat. */
  polygons: number[][][][];
  rate: number;
  active: boolean;
  /** Lng/lat bounds. */
  bounds: [number, number, number, number];
  /** Square metres. */
  area: number;
}

/** A point on a front: where flames stand and embers rise. */
interface FrontPoint {
  x: number;
  z: number;
  nx: number;
  nz: number;
  /** Spread multiplier × active, and active. */
  rate: number;
  active: number;
}

/** Terrain heights over the drawn area: (nx × nz) samples, `step` metres apart. */
interface HeightGrid {
  minX: number;
  minZ: number;
  step: number;
  nx: number;
  nz: number;
  h: Float32Array;
  /** Grid squares (nx - 1 per row) the ground is drawn on: within reach of a fire. */
  squares: Uint8Array;
}

const REBUILD_DEBOUNCE_MS = 150;
/** Terrain tiles arrive in bursts while the map moves: refresh heights once they settle. */
const HEIGHTS_DEBOUNCE_MS = 400;
/** The fire's local frame is kept until the view centre moves this far away (float precision). */
const REANCHOR_M = 15_000;
/** Above the ground, so the burned ground never flickers against the draped map. */
const LIFT_M = 0.5;
/** A unit of the look is this fraction of the front depth (the prototype's 7-unit front). */
const UNITS_PER_FRONT = 7;
/** Most terrain samples per update: wider spacing beyond it. */
const MAX_TERRAIN_SAMPLES = 60_000;
/** Firelight is drawn out to this many glow radii. */
const GLOW_REACH = 4;
/** Wind speed (m/s) at which the head runs twice the base rate. */
const WIND_FOR_DOUBLE = 25 / 3.6;

const finite = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback);

/** Small seeded PRNG (mulberry32): particles keep their seeds across rebuilds. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Approximate ground distance between two lng/lat points. */
function metresBetween(a: LngLat, b: LngLat): number {
  const k = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  return Math.hypot((a[0] - b[0]) * k, a[1] - b[1]) * 111_320;
}

/** Fires (polygons with their properties) in GeoJSON. */
export function firesOf(
  data: FireData | null | undefined,
  rateOf: (p: Record<string, unknown>) => number,
  activeOf: (p: Record<string, unknown>) => boolean,
  properties: Record<string, unknown> = {},
): Fire[] {
  if (!data || typeof data !== 'object') return [];
  if (data.type === 'FeatureCollection')
    return ((data as { features?: FireData[] }).features ?? []).flatMap((f) =>
      firesOf(f, rateOf, activeOf),
    );
  if (data.type === 'Feature') {
    const f = data as { geometry: unknown; properties?: Record<string, unknown> | null };
    return firesOf(f.geometry as FireData, rateOf, activeOf, f.properties ?? {});
  }
  if (data.type === 'GeometryCollection')
    return ((data as { geometries?: FireData[] }).geometries ?? []).flatMap((g) =>
      firesOf(g, rateOf, activeOf, properties),
    );
  const polygons = polygonsOf(data as { type: string; coordinates: unknown }).filter(
    (p) => (p[0]?.length ?? 0) >= 3,
  );
  if (!polygons.length) return [];
  const bounds: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of polygons)
    for (const [x, y] of p[0]!) {
      bounds[0] = Math.min(bounds[0], x!);
      bounds[1] = Math.min(bounds[1], y!);
      bounds[2] = Math.max(bounds[2], x!);
      bounds[3] = Math.max(bounds[3], y!);
    }
  const k = 111_320 * Math.cos((((bounds[1] + bounds[3]) / 2) * Math.PI) / 180);
  const ringArea = (r: number[][]) => {
    let a = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++)
      a += r[j]![0]! * r[i]![1]! - r[i]![0]! * r[j]![1]!;
    return Math.abs(a / 2) * k * 110_574;
  };
  const area = polygons.reduce(
    (s, [outer, ...holes]) => s + ringArea(outer!) - holes.reduce((h, r) => h + ringArea(r), 0),
    0,
  );
  return [
    {
      polygons,
      rate: Math.max(0, finite(rateOf(properties), 1)),
      active: activeOf(properties),
      bounds,
      area,
    },
  ];
}

const defaultRate = (p: Record<string, unknown>) => (typeof p.rate === 'number' ? p.rate : 1);
const defaultActive = (p: Record<string, unknown>) => p.active !== false;

/**
 * Wildfires on the map from polygon perimeters: burned ground, a wind- and slope-driven flaming
 * front that spreads from the mapped perimeter, flame tongues and rising smoke along it and
 * flying embers, all draped on the terrain. Every polygon burns in one shared signed distance field, so fires
 * merge where they meet and holes stay unburned.
 */
export class FireModule implements LayerModule {
  readonly uniforms: FireUniforms;
  ground?: Mesh<BufferGeometry, ShaderMaterial>;
  flames?: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  smoke?: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  embers?: Points<BufferGeometry, ShaderMaterial>;
  private ctx?: ModuleContext;
  private view?: ViewState;
  private timer?: ReturnType<typeof setTimeout>;
  private heightsTimer?: ReturnType<typeof setTimeout>;
  /** The fires or terrain changed: the next update must rebuild. */
  private dirty = true;
  private fires: Fire[] = [];
  private drawn: Fire[] = [];
  private anchor?: LngLat;
  private field?: FireField;
  private heights?: HeightGrid;
  private points: FrontPoint[] = [];
  /** Spread (m at the base rate) the current field leaves room for. */
  private room = 0;
  private wind: Required<FireWind>;
  private rate: number;
  private timeScale: number;
  private playing: boolean;
  private elapsedMin = 0;
  private lastFrame?: number;
  private updateMs = 0;
  private readonly unit: number;
  private readonly reported = new Set<string>();
  private readonly ember: {
    pos: Float32Array;
    color: Float32Array;
    vel: Float32Array;
    life: Float32Array;
    max: Float32Array;
  };

  constructor(private readonly options: FireOptions = {}) {
    const depth = Math.max(1, options.frontDepth ?? 70);
    this.unit = depth / UNITS_PER_FRONT;
    this.wind = {
      speed: Math.max(0, options.wind?.speed ?? 5),
      directionDeg: options.wind?.directionDeg ?? 225,
    };
    this.rate = Math.max(0, options.rate ?? 4);
    this.timeScale = Math.max(0, options.timeScale ?? 1);
    this.playing = options.playing ?? true;
    const n = Math.max(0, Math.round(options.embers ?? 900));
    this.ember = {
      pos: new Float32Array(n * 3),
      color: new Float32Array(n * 3),
      vel: new Float32Array(n * 3),
      life: new Float32Array(n),
      max: new Float32Array(n),
    };
    this.uniforms = {
      uOrigin: { value: new Vector2() },
      uNoiseScale: { value: 1 },
      uUnit: { value: this.unit },
      uTime: { value: 0 },
      uDrift: { value: new Vector2() },
      uGrowth: { value: 0 },
      uWind: { value: 0 },
      uWindDir: { value: new Vector2() },
      uSlope: { value: Math.max(0, options.slope ?? 1) },
      uBand: { value: UNITS_PER_FRONT },
      uGlow: { value: Math.max(1, options.glowRadius ?? 3 * depth) / this.unit },
      uFlameH: { value: Math.max(0, options.flameHeight ?? 1.5 * depth) / this.unit },
      uSmoke: {
        value: options.smoke === false ? 0 : Math.min(1, Math.max(0, options.smoke ?? 0.7)),
      },
      uSmokeH: { value: Math.max(0, options.smokeHeight ?? 12 * depth) },
      uPlume: { value: 0 },
      uSmokeLight: { value: new Color(1, 1, 1) },
      uChar: { value: Math.min(1, Math.max(0, options.charOpacity ?? 0.85)) },
      uIntensity: { value: Math.max(0, options.intensity ?? 1) },
      uLift: { value: LIFT_M },
      uField: { value: null },
      uFieldRect: { value: new Vector3(0, 0, 1) },
      uFieldSize: { value: new Vector2(1, 1) },
      uHeight: { value: null },
      uHeightRect: { value: new Vector3(0, 0, 1) },
      uHeightSize: { value: new Vector2(1, 1) },
    };
    this.applyWind();
    this.setData(options.data ?? null);
  }

  onAdd(ctx: ModuleContext): void {
    this.ctx = ctx;
    const ground = new Mesh(
      new BufferGeometry(),
      new ShaderMaterial({
        vertexShader: GROUND_VERTEX,
        fragmentShader: GROUND_FRAGMENT,
        uniforms: this.uniforms,
        transparent: true,
        // Depth-tested against the ground and buildings, never written.
        depthWrite: false,
        depthTest: true,
        side: DoubleSide,
        // Premultiplied: char covers the map, light adds to it.
        blending: CustomBlending,
        blendSrc: OneFactor,
        blendDst: OneMinusSrcAlphaFactor,
      }),
    );
    const additive = (vertexShader: string, fragmentShader: string, uniforms: object) =>
      new ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: uniforms as Record<string, IUniform>,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        side: DoubleSide,
        blending: AdditiveBlending,
      });
    const flames = new Mesh(
      new InstancedBufferGeometry(),
      additive(FLAME_VERTEX, FLAME_FRAGMENT, this.uniforms),
    );
    const smoke = new Mesh(
      new InstancedBufferGeometry(),
      new ShaderMaterial({
        vertexShader: SMOKE_VERTEX,
        fragmentShader: SMOKE_FRAGMENT,
        uniforms: this.uniforms,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        side: DoubleSide,
        blending: CustomBlending,
        blendSrc: OneFactor,
        blendDst: OneMinusSrcAlphaFactor,
      }),
    );
    const emberGeometry = new BufferGeometry();
    emberGeometry.setAttribute('position', new Float32BufferAttribute(this.ember.pos, 3));
    emberGeometry.setAttribute('aColor', new Float32BufferAttribute(this.ember.color, 3));
    const embers = new Points(
      emberGeometry,
      additive(EMBER_VERTEX, EMBER_FRAGMENT, {
        uSize: { value: this.unit * 0.25 },
        uPixels: { value: 500 },
      }),
    );
    // Smoke over the flames; embers glow through it.
    ground.renderOrder = 1;
    flames.renderOrder = 2;
    smoke.renderOrder = 3;
    embers.renderOrder = 4;
    for (const o of [ground, flames, smoke, embers]) {
      o.frustumCulled = false;
      o.visible = false;
      ctx.scene.add(o);
    }
    this.ground = ground;
    this.flames = flames;
    this.smoke = smoke;
    this.embers = embers;
    this.themeChanged(ctx.core.theme ?? 'day');
    ctx.map.on('sourcedata', this.onSourceData);
    ctx.map.on('terrain', this.onTerrain);
  }

  update(view: ViewState): void {
    this.view = view;
    this.rebuild();
  }

  place(origin: Origin): void {
    if (!this.anchor) return;
    const at = localPosition(origin, this.anchor, 0);
    for (const o of [this.ground, this.flames, this.smoke, this.embers]) {
      if (!o) continue;
      o.position.set(...at);
      o.updateMatrixWorld();
    }
    const pixels = this.embers?.material.uniforms.uPixels;
    if (pixels) pixels.value = (this.ctx?.map.getCanvas().height ?? 1000) / 2;
  }

  frame(timeMs: number): boolean {
    const t = timeMs / 1000;
    const dt = this.lastFrame === undefined ? 0 : Math.min(0.05, t - this.lastFrame);
    this.lastFrame = t;
    const u = this.uniforms;
    u.uTime.value = (u.uTime.value + dt) % TIME_PERIOD_S;
    // Flames drift downwind (in noise metres, wrapped in float64).
    const step = (1.2 + 1.5 * u.uWind.value) * (this.unit / 0.09) * dt * u.uNoiseScale.value;
    const wrap = (v: number) => ((v % NOISE_PERIOD_M) + NOISE_PERIOD_M) % NOISE_PERIOD_M;
    u.uDrift.value.set(
      wrap(u.uDrift.value.x + u.uWindDir.value.x * step),
      wrap(u.uDrift.value.y + u.uWindDir.value.y * step),
    );
    if (this.playing && this.drawn.length) {
      this.elapsedMin += dt * this.timeScale;
      const max = Math.max(0, this.options.maxSpread ?? 2000);
      if (this.elapsedMin * this.rate >= max) {
        this.elapsedMin = this.rate > 0 ? max / this.rate : this.elapsedMin;
        this.playing = false;
      }
      this.applyGrowth();
    }
    this.stepEmbers(dt);
    return !!this.ground?.visible;
  }

  onRemove(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    clearTimeout(this.timer);
    clearTimeout(this.heightsTimer);
    ctx.map.off('sourcedata', this.onSourceData);
    ctx.map.off('terrain', this.onTerrain);
    for (const o of [this.ground, this.flames, this.smoke, this.embers]) {
      if (!o) continue;
      ctx.scene.remove(o);
      o.geometry.dispose();
      o.material.dispose();
    }
    this.uniforms.uField.value?.dispose();
    this.uniforms.uHeight.value?.dispose();
    this.uniforms.uField.value = this.uniforms.uHeight.value = null;
    this.ground = this.flames = this.smoke = this.embers = undefined;
    this.ctx = undefined;
  }

  /** Smoke takes the theme's sunlight: bright by day, dim at night. */
  themeChanged(theme: Theme): void {
    const t = THEMES[theme];
    const light = Math.min(1, Math.max(0.25, t.sunDir[1] * 0.9 + 0.2));
    this.uniforms.uSmokeLight.value.setHex(t.sunColor).multiplyScalar(light);
    this.ctx?.requestRepaint();
  }

  /** Replace the fire perimeters; the spread restarts from them. */
  setData(data: FireData | null): void {
    this.fires = firesOf(
      data,
      this.options.featureRate ?? defaultRate,
      this.options.featureActive ?? defaultActive,
    );
    this.elapsedMin = 0;
    this.dirty = true;
    this.applyGrowth();
    this.schedule();
  }

  setWind(wind: FireWind): void {
    this.wind = { ...this.wind, ...wind };
    this.wind.speed = Math.max(0, finite(this.wind.speed, 0));
    this.applyWind();
    this.checkRoom();
    this.ctx?.requestRepaint();
  }

  /** Base rate of spread, metres per fire minute. */
  setRate(rate: number): void {
    // Keep the front where it is: the elapsed time is rescaled to the new rate.
    const spread = this.elapsedMin * this.rate;
    this.rate = Math.max(0, finite(rate, 0));
    this.elapsedMin = this.rate > 0 ? spread / this.rate : this.elapsedMin;
    this.applyGrowth();
  }

  setPlaying(playing: boolean): void {
    this.playing = playing;
    this.ctx?.requestRepaint();
  }

  /** Back to the mapped perimeters. */
  resetSpread(): void {
    this.elapsedMin = 0;
    this.applyGrowth();
  }

  getStats(): FireStats {
    return {
      fires: this.drawn.length,
      mappedHa: this.drawn.reduce((s, f) => s + f.area, 0) / 1e4,
      elapsedMin: this.elapsedMin,
      spreadM: this.elapsedMin * this.rate,
      updateMs: this.updateMs,
    };
  }

  private applyWind(): void {
    const [x, z] = windVector(this.wind.directionDeg);
    this.uniforms.uWindDir.value.set(x, z);
    this.uniforms.uWind.value = this.wind.speed / WIND_FOR_DOUBLE;
    this.uniforms.uPlume.value = Math.max(
      0,
      this.options.plumeLength ??
        this.uniforms.uSmokeH.value * (1.5 + 6 * Math.min(1, this.wind.speed / 10)),
    );
  }

  private applyGrowth(): void {
    this.uniforms.uGrowth.value = (this.elapsedMin * this.rate) / this.unit;
    this.checkRoom();
    this.ctx?.requestRepaint();
  }

  /** The front is about to outgrow the field: rebuild it with more room. */
  private checkRoom(): void {
    if (this.field && this.reach(this.elapsedMin * this.rate) > this.room) this.schedule();
  }

  /** Farthest anything is drawn from the mapped perimeter after `spread` metres at the base rate. */
  private reach(spread: number): number {
    const u = this.uniforms;
    const maxRate = this.fires.reduce((m, f) => Math.max(m, f.active ? f.rate : 0), 0);
    return (
      spread * maxRate * (1 + u.uWind.value + 2 * u.uSlope.value) +
      (12 + GLOW_REACH * u.uGlow.value) * this.unit
    );
  }

  private readonly schedule = (): void => {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.rebuild(), REBUILD_DEBOUNCE_MS);
  };

  private readonly onTerrain = (): void => {
    this.dirty = true;
    this.schedule();
  };

  /** New terrain tiles: only the heights change (the fire itself is left as it is). */
  private readonly onSourceData = (e: { sourceId?: string; sourceDataType?: string }): void => {
    if (e.sourceDataType && e.sourceDataType !== 'content') return;
    const terrain = this.ctx?.map.getTerrain();
    if (!terrain || e.sourceId !== terrain.source) return;
    clearTimeout(this.heightsTimer);
    this.heightsTimer = setTimeout(this.refreshHeights, HEIGHTS_DEBOUNCE_MS);
  };

  private readonly refreshHeights = (): void => {
    if (!this.field || !this.anchor) return;
    try {
      const heights = this.sampleHeights(originAt(this.anchor), this.field, this.room);
      this.heights = heights;
      this.uploadHeights(heights);
      this.buildGround(heights);
    } catch (err) {
      this.report('heights', err);
    }
    this.ctx?.requestRepaint();
  };

  private rebuild(): void {
    const ctx = this.ctx;
    const view = this.view;
    if (!ctx || !view) return;
    const started = performance.now();
    try {
      this.build(view);
    } catch (err) {
      this.report('build', err);
      this.hide();
    }
    this.updateMs = performance.now() - started;
    ctx.requestRepaint();
  }

  private hide(): void {
    this.drawn = [];
    this.points = [];
    for (const o of [this.ground, this.flames, this.smoke, this.embers]) if (o) o.visible = false;
  }

  private build(view: ViewState): void {
    // A stable local frame: panning around the fires keeps it, so nothing is rebuilt.
    const keep = this.anchor && metresBetween(this.anchor, view.center) < REANCHOR_M;
    const anchor = keep ? this.anchor! : view.center;
    const origin = originAt(anchor);
    const toLocal = ([lng, lat]: number[]): [number, number] => [
      (mercatorX(lng!) - origin.x) / origin.scale,
      (mercatorY(lat!) - origin.y) / origin.scale,
    ];
    const spread = this.elapsedMin * this.rate;
    // The fires within reach of a square around the view centre (not the view itself, which
    // changes with every pan and tilt).
    const half = Math.max(1000, this.options.maxExtent ?? 40_000) / 2;
    const [cx, cz] = toLocal(view.center);
    const cap0 = [cx - half, cz - half];
    const cap1 = [cx + half, cz + half];
    // Room for 50% more spread (or 15 units) before the field must grow again.
    const room = this.reach(Math.max(spread * 1.5, spread + 15 * this.unit));
    const drawn: Fire[] = [];
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const f of this.fires) {
      const [x0, z1] = toLocal([f.bounds[0], f.bounds[1]]);
      const [x1, z0] = toLocal([f.bounds[2], f.bounds[3]]);
      if (x1 + room < cap0[0]! || x0 - room > cap1[0]! || z1 + room < cap0[1]!) continue;
      if (z0 - room > cap1[1]!) continue;
      drawn.push(f);
      box[0] = Math.min(box[0]!, x0 - room);
      box[1] = Math.min(box[1]!, z0 - room);
      box[2] = Math.max(box[2]!, x1 + room);
      box[3] = Math.max(box[3]!, z1 + room);
    }
    const minX = Math.max(box[0]!, cap0[0]!);
    const minZ = Math.max(box[1]!, cap0[1]!);
    const maxX = Math.min(box[2]!, cap1[0]!);
    const maxZ = Math.min(box[3]!, cap1[1]!);
    if (!drawn.length || !(maxX > minX && maxZ > minZ)) {
      this.field = undefined;
      this.hide();
      return;
    }
    // Same fires, same frame, enough room, and the field already covers what is needed.
    const old = this.field;
    if (
      !this.dirty &&
      old &&
      anchor === this.anchor &&
      this.reach(spread) <= this.room &&
      drawn.length === this.drawn.length &&
      drawn.every((f, i) => f === this.drawn[i]) &&
      old.minX <= minX + old.cell &&
      old.minZ <= minZ + old.cell &&
      old.minX + old.nx * old.cell >= maxX - old.cell &&
      old.minZ + old.nz * old.cell >= maxZ - old.cell
    )
      return;
    this.dirty = false;
    const width = maxX - minX;
    const depth = maxZ - minZ;
    const cells = Math.max(16, Math.round(this.options.resolution ?? 512));
    const cell = Math.max(1, Math.max(width, depth) / cells);
    const rect = {
      minX,
      minZ,
      cell,
      nx: Math.max(2, Math.ceil(width / cell)),
      nz: Math.max(2, Math.ceil(depth / cell)),
    };
    const local: FirePolygons[] = drawn.map((f) => ({
      polygons: f.polygons.map((p) => p.map((r) => r.map(toLocal))),
      rate: f.rate,
      active: f.active,
    }));
    const field = buildField(local, rect);
    const heights = this.sampleHeights(origin, field, room);

    // Embers keep flying unless the frame moved under them.
    const rescatter = anchor !== this.anchor || !this.points.length;
    this.anchor = anchor;
    this.field = field;
    this.heights = heights;
    this.drawn = drawn;
    this.room = room;
    const [ox, oz, scale] = noiseOrigin(origin);
    const u = this.uniforms;
    u.uOrigin.value.set(ox, oz);
    u.uNoiseScale.value = scale;
    this.uploadField(field);
    this.uploadHeights(heights);
    this.buildGround(heights);
    this.buildFronts(field);
    if (rescatter) for (let i = 0; i < this.ember.life.length; i++) this.spawnEmber(i, true);
  }

  /**
   * Terrain heights over the field: every `terrainSpacing` metres, but sampled only on the
   * squares within `reach` of a fire (the rest of the grid is never drawn). One flat square
   * without terrain.
   */
  private sampleHeights(origin: Origin, field: FireField, reach: number): HeightGrid {
    const { minX, minZ, cell, data } = field;
    const width = field.nx * cell;
    const depth = field.nz * cell;
    const map = this.ctx?.map;
    if (!map?.getTerrain?.()) {
      const step = Math.max(width, depth);
      return {
        minX,
        minZ,
        step,
        nx: 2,
        nz: 2,
        h: new Float32Array(4),
        squares: new Uint8Array([1]),
      };
    }
    // Spacing: as asked, or wider when the area in reach would take too many samples.
    let near = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i]! < reach) near++;
    const step = Math.max(
      this.options.terrainSpacing ?? 20,
      Math.sqrt((near * cell * cell) / MAX_TERRAIN_SAMPLES),
      1,
    );
    const nx = Math.ceil(width / step) + 1;
    const nz = Math.ceil(depth / step) + 1;
    const inReach = new Uint8Array(nx * nz);
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++)
        inReach[j * nx + i] =
          sampleField(field, minX + i * step, minZ + j * step)[0] < reach + step * 1.5 ? 1 : 0;
    // A square is drawn when any corner is in reach; all its corners need a height.
    const squares = new Uint8Array((nx - 1) * (nz - 1));
    const wanted = new Uint8Array(nx * nz);
    for (let j = 0; j + 1 < nz; j++)
      for (let i = 0; i + 1 < nx; i++) {
        const a = j * nx + i;
        if (!(inReach[a]! | inReach[a + 1]! | inReach[a + nx]! | inReach[a + nx + 1]!)) continue;
        squares[j * (nx - 1) + i] = 1;
        wanted[a] = wanted[a + 1] = wanted[a + nx] = wanted[a + nx + 1] = 1;
      }
    const h = new Float32Array(nx * nz);
    const missing: number[] = [];
    let sum = 0;
    let count = 0;
    for (let k = 0; k < nx * nz; k++) {
      if (!wanted[k]) continue;
      const lngLat = lngLatAt(origin, minX + (k % nx) * step, minZ + Math.floor(k / nx) * step);
      const e = map.queryTerrainElevation(lngLat);
      if (e === null || e === undefined || !Number.isFinite(e)) {
        missing.push(k);
        continue;
      }
      h[k] = e;
      sum += e;
      count++;
    }
    // Where the DEM has not loaded (refilled when its tiles arrive) or nothing is drawn: the mean.
    const mean = count ? sum / count : 0;
    for (const k of missing) h[k] = mean;
    for (let k = 0; k < nx * nz; k++) if (!wanted[k]) h[k] = mean;
    return { minX, minZ, step, nx, nz, h, squares };
  }

  private uploadField(field: FireField): void {
    const u = this.uniforms;
    u.uField.value?.dispose();
    const t = new DataTexture(field.data, field.nx, field.nz, RGBAFormat, FloatType);
    t.minFilter = t.magFilter = NearestFilter;
    t.needsUpdate = true;
    u.uField.value = t;
    u.uFieldRect.value.set(field.minX, field.minZ, field.cell);
    u.uFieldSize.value.set(field.nx, field.nz);
  }

  private uploadHeights(heights: HeightGrid): void {
    const u = this.uniforms;
    u.uHeight.value?.dispose();
    const t = new DataTexture(heights.h, heights.nx, heights.nz, RedFormat, FloatType);
    t.minFilter = t.magFilter = NearestFilter;
    t.needsUpdate = true;
    u.uHeight.value = t;
    u.uHeightRect.value.set(heights.minX, heights.minZ, heights.step);
    u.uHeightSize.value.set(heights.nx, heights.nz);
  }

  /** The ground mesh: the drawn squares of the terrain grid. */
  private buildGround(heights: HeightGrid): void {
    const ground = this.ground;
    if (!ground) return;
    const { minX, minZ, step, nx, nz, h, squares } = heights;
    const positions: number[] = [];
    const index: number[] = [];
    const vertex = new Int32Array(nx * nz).fill(-1);
    const at = (k: number) => {
      if (vertex[k]! < 0) {
        vertex[k] = positions.length / 3;
        positions.push(minX + (k % nx) * step, h[k]! + LIFT_M, minZ + Math.floor(k / nx) * step);
      }
      return vertex[k]!;
    };
    for (let j = 0; j + 1 < nz; j++)
      for (let i = 0; i + 1 < nx; i++) {
        if (!squares[j * (nx - 1) + i]) continue;
        const a = j * nx + i;
        const [p, q, r, t] = [at(a), at(a + 1), at(a + nx), at(a + nx + 1)];
        index.push(p, r, q, q, r, t);
      }
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(positions, 3));
    g.setIndex(index);
    ground.geometry.dispose();
    ground.geometry = g;
    ground.visible = true;
  }

  /** The points along every front where flames, smoke and embers rise. */
  private buildFronts(field: FireField): void {
    const step = Math.max(field.cell, this.unit * 1.5);
    const points: FrontPoint[] = [];
    for (const front of fronts(field))
      for (const s of resample(front, step)) {
        const [nx, nz] = outwardAt(field, s.x, s.z);
        // The burning side decides whose front it is.
        const [, rate, active] = sampleField(field, s.x - nx * field.cell, s.z - nz * field.cell);
        if (active > 0.5) points.push({ x: s.x, z: s.z, nx, nz, rate, active });
      }
    this.points = points;
    const flames = Math.max(0, Math.round(this.options.flames ?? 3000));
    const puffs = this.uniforms.uSmoke.value > 0 ? Math.round(this.options.smokePuffs ?? 600) : 0;
    // Up to two flame tongues per front point, favouring the head.
    this.fillParticles(this.flames, Math.min(flames, points.length * 2), step, true, 1);
    // Smoke billows up in separate columns (one per ~25 front points, mostly at the head) that
    // merge downwind.
    const columns = Math.min(40, Math.max(3, Math.round(points.length / 25)));
    this.fillParticles(
      this.smoke,
      Math.min(Math.max(0, puffs), points.length),
      step,
      true,
      2,
      columns,
    );
    if (this.embers) this.embers.visible = points.length > 0 && this.ember.life.length > 0;
  }

  /** Instances on random front points (`toHead`: favouring the wind-driven head). */
  private fillParticles(
    mesh: Mesh<InstancedBufferGeometry, ShaderMaterial> | undefined,
    count: number,
    spacing: number,
    toHead: boolean,
    seed: number,
    columns = 0,
  ): void {
    if (!mesh) return;
    const random = seeded(seed);
    // Columns: a few source points (each a few points wide) that the instances gather around.
    const sources = Array.from({ length: columns }, () => this.pickPoint(toHead, random));
    const base = new Float32Array(count * 2);
    const normal = new Float32Array(count * 2);
    const fire = new Float32Array(count * 2);
    const seeds = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const p = sources.length
        ? sources[(random() * sources.length) | 0]!
        : this.pickPoint(toHead, random);
      // Spread along the front: between neighbouring points, or across a column's footprint.
      const along = (random() - 0.5) * spacing * (sources.length ? 6 : 1);
      base.set([p.x - p.nz * along, p.z + p.nx * along], i * 2);
      normal.set([p.nx, p.nz], i * 2);
      fire.set([p.rate, p.active], i * 2);
      seeds[i] = random();
    }
    const g = new InstancedBufferGeometry();
    g.setAttribute(
      'position',
      new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3),
    );
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.setAttribute('aBase', new InstancedBufferAttribute(base, 2));
    g.setAttribute('aN', new InstancedBufferAttribute(normal, 2));
    g.setAttribute('aFire', new InstancedBufferAttribute(fire, 2));
    g.setAttribute('aSeed', new InstancedBufferAttribute(seeds, 1));
    g.instanceCount = count;
    mesh.geometry.dispose();
    mesh.geometry = g;
    mesh.visible = count > 0;
  }

  /** A random active front point; with `toHead`, more often where the wind drives the front. */
  private pickPoint(toHead: boolean, random: () => number = Math.random): FrontPoint {
    const points = this.points;
    const wind = this.uniforms.uWind.value;
    const wd = this.uniforms.uWindDir.value;
    let p = points[(random() * points.length) | 0]!;
    for (let tries = 0; toHead && tries < 6; tries++) {
      const wf = Math.max(0.15, 1 + wind * (p.nx * wd.x + p.nz * wd.y));
      if (random() < wf / (1 + wind)) break;
      p = points[(random() * points.length) | 0]!;
    }
    return p;
  }

  /** Terrain height at local x, z (bilinear over the samples). */
  private heightAt(x: number, z: number): number {
    const g = this.heights;
    if (!g) return 0;
    const fx = Math.min(g.nx - 1, Math.max(0, (x - g.minX) / g.step));
    const fz = Math.min(g.nz - 1, Math.max(0, (z - g.minZ) / g.step));
    const i = Math.min(g.nx - 2, Math.floor(fx));
    const j = Math.min(g.nz - 2, Math.floor(fz));
    const u = fx - i;
    const v = fz - j;
    const at = (a: number, b: number) => g.h[b * g.nx + a]!;
    const top = at(i, j) + (at(i + 1, j) - at(i, j)) * u;
    const bottom = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * u;
    return top + (bottom - top) * v;
  }

  /** A new ember on an active front, more often where the head runs. */
  private spawnEmber(i: number, scatter: boolean): void {
    const points = this.points;
    const { pos, vel, life, max } = this.ember;
    if (!points.length) {
      life[i] = max[i] = 0;
      pos.fill(0, i * 3, i * 3 + 3);
      return;
    }
    const u = this.uniforms;
    const wind = u.uWind.value;
    const wd = u.uWindDir.value;
    const p = this.pickPoint(true);
    const wf = Math.max(0.15, 1 + wind * (p.nx * wd.x + p.nz * wd.y));
    const unit = this.unit;
    const g = (u.uGrowth.value * p.rate * wf - u.uBand.value * 0.3) * unit;
    const x = p.x + p.nx * g + (Math.random() - 0.5) * 3 * unit;
    const z = p.z + p.nz * g + (Math.random() - 0.5) * 3 * unit;
    pos[i * 3] = x;
    pos[i * 3 + 1] = this.heightAt(x, z) + Math.random() * 4 * unit;
    pos[i * 3 + 2] = z;
    vel[i * 3] = (wd.x * wind * 9 + (Math.random() - 0.5) * 3) * unit;
    vel[i * 3 + 1] = (6 + Math.random() * 12) * unit;
    vel[i * 3 + 2] = (wd.y * wind * 9 + (Math.random() - 0.5) * 3) * unit;
    max[i] = 1.5 + Math.random() * 3.5;
    life[i] = scatter ? Math.random() * max[i]! : 0;
  }

  private stepEmbers(dt: number): void {
    const embers = this.embers;
    if (!embers?.visible || dt <= 0) return;
    const { pos, color, vel, life, max } = this.ember;
    const unit = this.unit;
    const t = this.uniforms.uTime.value;
    for (let i = 0; i < life.length; i++) {
      life[i]! += dt;
      if (life[i]! > max[i]!) this.spawnEmber(i, false);
      const k = i * 3;
      vel[k]! += Math.sin(t * 3 + i) * dt * 4 * unit;
      vel[k + 2]! += Math.cos(t * 2.3 + i * 1.7) * dt * 4 * unit;
      vel[k + 1]! *= 1 - dt * 0.25;
      pos[k]! += vel[k]! * dt;
      pos[k + 1]! += vel[k + 1]! * dt;
      pos[k + 2]! += vel[k + 2]! * dt;
      const f = max[i]! > 0 ? 1 - life[i]! / max[i]! : 0;
      const b = f * f * (0.7 + 0.6 * Math.random()) * 1.6 * this.uniforms.uIntensity.value;
      color[k] = b;
      color[k + 1] = b * 0.36;
      color[k + 2] = b * 0.06;
    }
    embers.geometry.attributes.position!.needsUpdate = true;
    embers.geometry.attributes.aColor!.needsUpdate = true;
  }

  private report(key: string, err: unknown): void {
    if (this.reported.has(key)) return;
    this.reported.add(key);
    if (this.options.onError) this.options.onError(err);
    else console.warn('[maplibre-landmarks] fire', err);
  }
}
