import {
  BufferGeometry,
  Color,
  CustomBlending,
  DoubleSide,
  Float32BufferAttribute,
  Mesh,
  NormalBlending,
  OneFactor,
  OneMinusSrcAlphaFactor,
  ShaderMaterial,
  Vector2,
  Vector3,
  type Camera,
  type IUniform,
} from 'three';
import type { LayerModule, ModuleContext } from '../core/LayerModule';
import { EARTH_RADIUS_M } from '../core/mercator';
import { SKY_COLORS, THEMES, type Theme } from '../core/theme';
import type { Origin, ViewState } from '../core/types';
import { cameraBasis } from '../fog/slices';
import { windVector } from '../trees/material';
import { DECK_FRAGMENT, DECK_VERTEX, SHADOW_FRAGMENT, SHADOW_VERTEX } from './shaders';

export interface CloudsWind {
  /** Metres per second (default 8). */
  speed?: number;
  /** Where the wind blows from, degrees clockwise from north (default 250). */
  directionDeg?: number;
}

export interface CloudsOptions {
  /** 0 (clear sky) to 1 (overcast), default 0.45. */
  coverage?: number;
  /** How thick the clouds look, default 1. */
  density?: number;
  /** Cloud base, metres above the ground under the map centre (default 1500). */
  base?: number;
  /** Depth of the cloud deck in metres (default 900). */
  thickness?: number;
  wind?: CloudsWind;
  /**
   * Zooming out flies up through the clouds and looks down on them from above (default true).
   * false: the clouds fade away as the camera climbs toward their base, leaving their shadows.
   */
  flyThrough?: boolean;
  /** Cloud shadows on the ground and buildings: darkness 0–1 (default 0.35); false for none. */
  shadows?: number | false;
  /** Ray-march steps through the deck, 4–32 (default 16): more is smoother and costs more. */
  steps?: number;
  /** Metres around the camera that have clouds (default 60 km). */
  radius?: number;
}

export interface CloudsUniforms {
  [name: string]: IUniform;
  uCamPos: IUniform<Vector3>;
  uBase: IUniform<number>;
  uTop: IUniform<number>;
  uGround: IUniform<number>;
  uOrigin: IUniform<Vector2>;
  uScroll: IUniform<Vector2>;
  uNoiseScale: IUniform<number>;
  uCell: IUniform<number>;
  uPeriod: IUniform<number>;
  uCoverage: IUniform<number>;
  uDensity: IUniform<number>;
  uTime: IUniform<number>;
  uRadius: IUniform<number>;
  uSteps: IUniform<number>;
  uSunDir: IUniform<Vector3>;
  uSunColor: IUniform<Color>;
  uSkyColor: IUniform<Color>;
  uShadowColor: IUniform<Color>;
  uShadow: IUniform<number>;
  /** 1 below the deck, fading to 0 as the camera climbs toward the cloud base. */
  uDeckFade: IUniform<number>;
}

/** Noise cells are this many metres (equator metres, like the fog's noise). */
export const CLOUD_CELL_M = 2048;
/** The cloud noise tiles every this many cells, horizontally. */
export const CLOUD_PERIOD_CELLS = 64;
const PERIOD_M = CLOUD_CELL_M * CLOUD_PERIOD_CELLS;
/** Mercator units per noise metre: equator metres, the same everywhere on the map. */
const NOISE_UNIT = 1 / (2 * Math.PI * EARTH_RADIUS_M);
/** uTime wraps here (seconds); the noise drifts so slowly the wrap is invisible. */
const TIME_PERIOD_S = 1e4;

const clamp01 = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));

/**
 * Noise frame of the map origin for the clouds: its position in equator metres, wrapped to the
 * cloud noise period in float64, and ground metres → noise metres. See the fog's noiseOrigin.
 */
export function cloudNoiseOrigin(origin: Origin): [x: number, z: number, scale: number] {
  const wrap = (m: number) => ((m % PERIOD_M) + PERIOD_M) % PERIOD_M;
  return [wrap(origin.x / NOISE_UNIT), wrap(origin.y / NOISE_UNIT), origin.scale / NOISE_UNIT];
}

/** Sky-lit and shaded cloud colours for a theme (the sun colour comes from the theme too). */
export function cloudColors(theme: Theme): { sky: Color; shadow: Color } {
  const sky = new Color(SKY_COLORS[theme].horizon).lerp(new Color('#ffffff'), 0.35);
  const shadow = new Color(SKY_COLORS[theme].sky)
    .lerp(new Color('#5d6470'), 0.5)
    .multiplyScalar(0.7);
  return { sky, shadow };
}

/**
 * With `flyThrough: false`, how much of the deck to draw for a camera `height` metres above the
 * ground: all of it up to 60% of the cloud base, none from the base up (only the shadows remain).
 */
export function deckFade(height: number, base: number): number {
  const k = Math.min(1, Math.max(0, (height - 0.6 * base) / (0.4 * base)));
  return 1 - k * k * (3 - 2 * k);
}

/** Two quads, bottom (aFace 0) and top (aFace 1) of the deck; or one ground quad. */
function quads(faces: number[]): BufferGeometry {
  const corners: number[] = [];
  const face: number[] = [];
  const index: number[] = [];
  faces.forEach((f, i) => {
    corners.push(-1, -1, 1, -1, 1, 1, -1, 1);
    face.push(f, f, f, f);
    const b = i * 4;
    index.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(new Array(faces.length * 12).fill(0), 3));
  g.setAttribute('aCorner', new Float32BufferAttribute(corners, 2));
  g.setAttribute('aFace', new Float32BufferAttribute(face, 1));
  g.setIndex(index);
  return g;
}

/**
 * A deck of volumetric clouds overhead: ray-marched through world-anchored noise, drifting with
 * the wind, lit by the theme's sun, and casting soft shadows on the map below.
 */
export class CloudsModule implements LayerModule {
  readonly uniforms: CloudsUniforms;
  deck?: Mesh<BufferGeometry, ShaderMaterial>;
  shadow?: Mesh<BufferGeometry, ShaderMaterial>;
  private ctx?: ModuleContext;
  private base: number;
  private thickness: number;
  private wind: Required<CloudsWind>;
  private ground = 0;
  private lastFrame?: number;

  constructor(private readonly options: CloudsOptions = {}) {
    this.base = Math.max(0, options.base ?? 1500);
    this.thickness = Math.max(50, options.thickness ?? 900);
    this.wind = {
      speed: Math.max(0, options.wind?.speed ?? 8),
      directionDeg: options.wind?.directionDeg ?? 250,
    };
    const shadows = options.shadows === false ? 0 : clamp01(options.shadows ?? 0.35);
    this.uniforms = {
      uCamPos: { value: new Vector3() },
      uBase: { value: this.base },
      uTop: { value: this.base + this.thickness },
      uGround: { value: 0 },
      uOrigin: { value: new Vector2() },
      uScroll: { value: new Vector2() },
      uNoiseScale: { value: 1 },
      uCell: { value: CLOUD_CELL_M },
      uPeriod: { value: CLOUD_PERIOD_CELLS },
      uCoverage: { value: clamp01(options.coverage ?? 0.45) },
      uDensity: { value: Math.max(0, options.density ?? 1) },
      uTime: { value: 0 },
      uRadius: { value: Math.max(1000, options.radius ?? 60_000) },
      uSteps: { value: Math.min(32, Math.max(4, Math.round(options.steps ?? 16))) },
      uSunDir: { value: new Vector3(0, 1, 0) },
      uSunColor: { value: new Color() },
      uSkyColor: { value: new Color() },
      uShadowColor: { value: new Color() },
      uShadow: { value: shadows },
      uDeckFade: { value: 1 },
    };
  }

  onAdd(ctx: ModuleContext): void {
    this.ctx = ctx;
    const deck = new Mesh(
      quads([0, 1]),
      new ShaderMaterial({
        vertexShader: DECK_VERTEX,
        fragmentShader: DECK_FRAGMENT,
        uniforms: this.uniforms,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        side: DoubleSide,
        // Premultiplied: colour already carries its alpha.
        blending: CustomBlending,
        blendSrc: OneFactor,
        blendDst: OneMinusSrcAlphaFactor,
      }),
    );
    const shadow = new Mesh(
      quads([0]),
      new ShaderMaterial({
        vertexShader: SHADOW_VERTEX,
        fragmentShader: SHADOW_FRAGMENT,
        uniforms: this.uniforms,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        side: DoubleSide,
        blending: NormalBlending,
      }),
    );
    // Shadows first (they darken what is already drawn), then the clouds over them.
    shadow.renderOrder = 1;
    deck.renderOrder = 2;
    for (const m of [shadow, deck]) {
      m.frustumCulled = false;
      // Whichever draws first this frame brings the camera uniform up to date.
      m.onBeforeRender = (_r, _s, camera) => this.updateCamera(camera);
      ctx.scene.add(m);
    }
    this.deck = deck;
    this.shadow = shadow;
    shadow.visible = this.uniforms.uShadow.value > 0;
    this.themeChanged(ctx.core.theme);
  }

  update(view: ViewState): void {
    const map = this.ctx?.map;
    this.ground = map?.getTerrain?.() ? (map.queryTerrainElevation(view.center) ?? 0) : 0;
    this.applyAltitude();
  }

  place(origin: Origin): void {
    const [x, z, scale] = cloudNoiseOrigin(origin);
    this.uniforms.uOrigin.value.set(x, z);
    this.uniforms.uNoiseScale.value = scale;
  }

  frame(timeMs: number): boolean {
    const t = timeMs / 1000;
    const dt = this.lastFrame === undefined ? 0 : Math.min(0.1, t - this.lastFrame);
    this.lastFrame = t;
    const u = this.uniforms;
    const [wx, wz] = windVector(this.wind.directionDeg);
    const step = this.wind.speed * dt * u.uNoiseScale.value; // ground m → noise m
    const wrap = (v: number) => ((v % PERIOD_M) + PERIOD_M) % PERIOD_M;
    u.uScroll.value.set(wrap(u.uScroll.value.x + wx * step), wrap(u.uScroll.value.y + wz * step));
    u.uTime.value = (u.uTime.value + dt) % TIME_PERIOD_S;
    return !!this.deck && this.wind.speed > 0 && u.uCoverage.value > 0;
  }

  themeChanged(theme: Theme): void {
    const t = THEMES[theme];
    const u = this.uniforms;
    u.uSunDir.value.set(...t.sunDir).normalize();
    u.uSunColor.value.setHex(t.sunColor);
    const { sky, shadow } = cloudColors(theme);
    u.uSkyColor.value.copy(sky);
    u.uShadowColor.value.copy(shadow);
    this.ctx?.requestRepaint();
  }

  onRemove(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    for (const m of [this.deck, this.shadow]) {
      if (!m) continue;
      ctx.scene.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    }
    this.deck = this.shadow = undefined;
    this.ctx = undefined;
  }

  /** 0 (clear sky) to 1 (overcast). */
  setCoverage(coverage: number): void {
    this.uniforms.uCoverage.value = clamp01(coverage);
    this.ctx?.requestRepaint();
  }

  setDensity(density: number): void {
    this.uniforms.uDensity.value = Math.max(0, Number.isFinite(density) ? density : 0);
    this.ctx?.requestRepaint();
  }

  /** Cloud base above the ground under the map centre, and optionally the deck's depth (metres). */
  setAltitude(base: number, thickness?: number): void {
    this.base = Math.max(0, base);
    if (thickness !== undefined) this.thickness = Math.max(50, thickness);
    this.applyAltitude();
  }

  setWind(wind: CloudsWind): void {
    this.wind = { ...this.wind, ...wind };
    this.wind.speed = Math.max(0, this.wind.speed);
    this.ctx?.requestRepaint();
  }

  /** Shadow darkness 0–1; 0 or false turns the shadows off. */
  setShadows(shadows: number | false): void {
    this.uniforms.uShadow.value = shadows === false ? 0 : clamp01(shadows);
    if (this.shadow) this.shadow.visible = this.uniforms.uShadow.value > 0;
    this.ctx?.requestRepaint();
  }

  private applyAltitude(): void {
    const u = this.uniforms;
    u.uGround.value = this.ground;
    u.uBase.value = this.ground + this.base;
    u.uTop.value = this.ground + this.base + this.thickness;
    this.ctx?.requestRepaint();
  }

  private updateCamera(camera: Camera): void {
    const b = cameraBasis(camera.matrixWorld, camera.projectionMatrix);
    const u = this.uniforms;
    u.uCamPos.value.copy(b.position);
    u.uDeckFade.value =
      this.options.flyThrough === false ? deckFade(b.position.y - this.ground, this.base) : 1;
  }
}
