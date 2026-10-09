import {
  BufferGeometry,
  Color,
  CustomBlending,
  DoubleSide,
  Float32BufferAttribute,
  Mesh,
  OneFactor,
  ShaderMaterial,
  SrcAlphaFactor,
  Vector3,
  type Camera,
  type IUniform,
} from 'three';
import type { LayerModule, ModuleContext } from '../core/LayerModule';
import type { Theme } from '../core/theme';
import type { Origin, ViewState } from '../core/types';
import { cameraBasis } from '../fog/slices';
import { Overcast, SNOW_CLOUD } from '../rain/overcast';
import { buildParticles } from '../rain/particles';
import { OVERLAY_FRAGMENT, OVERLAY_VERTEX } from '../rain/shaders';
import { windVector } from '../trees/material';
import { SNOW_FRAGMENT, SNOW_VERTEX } from './shaders';

export interface SnowWind {
  /** 0 falls straight down; 1 drifts the flakes about 40°. Default 0.3. */
  strength?: number;
  /** Where the wind blows from, degrees clockwise from north (default 250). */
  directionDeg?: number;
}

export interface SnowOptions {
  /** 0 (a few flakes) to 1 (heavy snowfall), default 0.6: flakes, opacity and haze. */
  intensity?: number;
  wind?: SnowWind;
  /** How far the scene fades toward the snow haze at full intensity, 0–1 (default 0.25). */
  haze?: number;
  /** Grey the map's sky while it snows (default true). */
  overcastSky?: boolean;
  /**
   * Snow settling on the tops of roofs: seconds to build up to the full cover (default 40);
   * `false` keeps roofs clear, 0 covers them at once.
   */
  settle?: number | false;
  /** Flakes at full intensity (default 20000). */
  maxFlakes?: number;
  /** Random numbers in [0, 1) for flake seeds (default Math.random). */
  random?: () => number;
}

export interface SnowStats {
  flakes: number;
  /** Snow lying on roofs now, 0–1. */
  cover: number;
}

/** Flake colour and the haze the scene fades toward, per theme. */
const SNOW_COLORS: Record<Theme, { flake: string; haze: string }> = {
  day: { flake: '#ffffff', haze: '#e4e8ee' },
  dawn: { flake: '#fff4ee', haze: '#e6d9d4' },
  dusk: { flake: '#e8e4f2', haze: '#9e9ab4' },
  night: { flake: '#c9d3ea', haze: '#3c4560' },
};
/** uTime wraps here (a one-frame hitch in the sway every ten minutes). */
const TIME_PERIOD_S = 2 * Math.PI * 100;
const FALL_PERIOD_M = 1e5;

const clamp01 = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));

export interface SnowUniforms {
  [name: string]: IUniform;
  uBoxMin: IUniform<Vector3>;
  uBoxSize: IUniform<number>;
  uFall: IUniform<Vector3>;
  uTime: IUniform<number>;
  uSize: IUniform<number>;
  uSway: IUniform<number>;
  uCentre: IUniform<Vector3>;
  uGround: IUniform<number>;
  uColor: IUniform<Color>;
  uOpacity: IUniform<number>;
}

/** Falling snow: swaying flakes, a pale haze and grey sky, and snow settling on roofs. */
export class SnowModule implements LayerModule {
  readonly uniforms: SnowUniforms;
  snow?: Mesh<BufferGeometry, ShaderMaterial>;
  overlay?: Mesh<BufferGeometry, ShaderMaterial>;
  private ctx?: ModuleContext;
  private overcast?: Overcast;
  private theme: Theme = 'day';
  private intensity: number;
  private wind: Required<SnowWind>;
  private readonly maxFlakes: number;
  private readonly fallDir = new Vector3(0, -1, 0);
  private ground = 0;
  private lastFrame?: number;
  /** Snow lying on roofs, easing toward the intensity. */
  private cover = 0;

  constructor(private readonly options: SnowOptions = {}) {
    this.intensity = clamp01(options.intensity ?? 0.6);
    this.wind = {
      strength: Math.max(0, options.wind?.strength ?? 0.3),
      directionDeg: options.wind?.directionDeg ?? 250,
    };
    this.maxFlakes = Math.max(1, Math.floor(options.maxFlakes ?? 20000));
    this.uniforms = {
      uBoxMin: { value: new Vector3() },
      uBoxSize: { value: 700 },
      uFall: { value: new Vector3() },
      uTime: { value: 0 },
      // Per metre from the camera: flakes 3–9 px across, swaying ±6 px, on a 900 px view.
      uSize: { value: 0.0016 },
      uSway: { value: 0.005 },
      uCentre: { value: new Vector3() },
      uGround: { value: 0 },
      uColor: { value: new Color(SNOW_COLORS.day.flake) },
      uOpacity: { value: 0.8 },
    };
    if (this.options.settle === 0) this.cover = this.intensity;
  }

  onAdd(ctx: ModuleContext): void {
    this.ctx = ctx;
    const snow = new Mesh(
      buildParticles(this.maxFlakes, this.options.random ?? Math.random),
      new ShaderMaterial({
        vertexShader: SNOW_VERTEX,
        fragmentShader: SNOW_FRAGMENT,
        uniforms: this.uniforms,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
      }),
    );
    snow.onBeforeRender = (_r, _s, camera) => this.updateCamera(camera);
    // The haze: dst × (1 − haze) + colour × haze, over everything drawn under the layer.
    const overlay = new Mesh(
      new BufferGeometry().setAttribute(
        'position',
        new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3),
      ),
      new ShaderMaterial({
        vertexShader: OVERLAY_VERTEX,
        fragmentShader: OVERLAY_FRAGMENT,
        uniforms: {
          uFlashColor: { value: new Color(SNOW_COLORS.day.haze) },
          uFlash: { value: 0 },
          uDarken: { value: 0 },
        },
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: CustomBlending,
        blendSrc: OneFactor,
        blendDst: SrcAlphaFactor,
      }),
    );
    overlay.renderOrder = 1;
    snow.renderOrder = 2;
    for (const m of [overlay, snow]) {
      m.frustumCulled = false;
      ctx.scene.add(m);
    }
    this.snow = snow;
    this.overlay = overlay;
    if (this.options.overcastSky ?? true) this.overcast = new Overcast(ctx.map, SNOW_CLOUD);
    this.themeChanged(ctx.core.theme);
    this.applyIntensity();
    this.applyCover();
  }

  update(view: ViewState): void {
    const map = this.ctx?.map;
    const terrain = !!map?.getTerrain?.();
    this.ground = terrain ? (map!.queryTerrainElevation(view.center) ?? 0) : 0;
    this.uniforms.uGround.value = terrain ? -1e6 : 0;
  }

  place(_origin: Origin): void {
    // Flakes are placed around the camera each frame (updateCamera).
  }

  frame(timeMs: number): boolean {
    const t = timeMs / 1000;
    const dt = this.lastFrame === undefined ? 0 : Math.min(0.1, t - this.lastFrame);
    this.lastFrame = t;
    const u = this.uniforms;
    u.uTime.value = (u.uTime.value + dt) % TIME_PERIOD_S;
    // Slow: about a ninth of the box a second, so flakes drift across the screen.
    const speed = u.uBoxSize.value * 0.11;
    const fall = u.uFall.value.addScaledVector(this.fallDir, -speed * dt);
    fall.set(fall.x % FALL_PERIOD_M, fall.y % FALL_PERIOD_M, fall.z % FALL_PERIOD_M);
    const settling = this.stepCover(dt);
    return (!!this.snow && this.intensity > 0) || settling;
  }

  themeChanged(theme: Theme): void {
    this.theme = theme;
    this.uniforms.uColor.value.set(SNOW_COLORS[theme].flake);
    this.overlay?.material.uniforms.uFlashColor!.value.set(SNOW_COLORS[theme].haze);
    this.applySky();
    this.ctx?.requestRepaint();
  }

  styleChanged(attached: boolean): void {
    this.overcast?.reset();
    if (attached) this.applySky();
  }

  onRemove(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    for (const m of [this.snow, this.overlay]) {
      if (!m) continue;
      ctx.scene.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    }
    this.overcast?.restore();
    if (this.options.settle !== false) ctx.core.setSnowCover(0);
    this.snow = this.overlay = undefined;
    this.ctx = undefined;
  }

  /** 0 (a few flakes) to 1 (heavy snowfall); 0 stops the snow (what settled melts away). */
  setIntensity(intensity: number): void {
    this.intensity = clamp01(intensity);
    if (this.options.settle === 0) this.cover = this.intensity;
    this.applyIntensity();
    this.applyCover();
  }

  setWind(wind: SnowWind): void {
    this.wind = { ...this.wind, ...wind };
    this.wind.strength = Math.max(0, this.wind.strength);
    this.applyWind();
    this.ctx?.requestRepaint();
  }

  getStats(): SnowStats {
    return { flakes: this.flakeCount(), cover: this.cover };
  }

  private flakeCount(): number {
    return this.intensity > 0 ? Math.round(this.maxFlakes * (0.1 + 0.9 * this.intensity)) : 0;
  }

  private applyIntensity(): void {
    const k = this.intensity;
    this.snow?.geometry.setDrawRange(0, this.flakeCount() * 6);
    if (this.snow) this.snow.visible = k > 0;
    this.uniforms.uOpacity.value = 0.55 + 0.4 * k;
    if (this.overlay) {
      const haze = clamp01(this.options.haze ?? 0.25) * k;
      this.overlay.material.uniforms.uFlash!.value = haze;
      this.overlay.material.uniforms.uDarken!.value = haze;
      this.overlay.visible = k > 0;
    }
    this.applyWind();
    this.applySky();
    this.ctx?.requestRepaint();
  }

  private applyWind(): void {
    const [x, z] = windVector(this.wind.directionDeg);
    const drift = 0.8 * this.wind.strength;
    this.fallDir.set(x * drift, -1, z * drift).normalize();
  }

  private applySky(): void {
    if (!this.overcast || !this.ctx) return;
    if (this.ctx.map.isStyleLoaded?.() === false) return;
    if (this.intensity > 0) this.overcast.apply(this.theme, 0.5 + 0.5 * this.intensity);
    else this.overcast.restore();
  }

  /** Snow settles toward the intensity over `settle` seconds and melts as fast. */
  private stepCover(dt: number): boolean {
    const settle = this.options.settle ?? 40;
    if (settle === false || settle === 0 || this.cover === this.intensity) return false;
    const step = dt / settle;
    this.cover =
      this.cover < this.intensity
        ? Math.min(this.intensity, this.cover + step)
        : Math.max(this.intensity, this.cover - step);
    this.applyCover();
    return true;
  }

  private applyCover(): void {
    if (this.options.settle === false) return;
    this.ctx?.core.setSnowCover(this.cover);
  }

  private updateCamera(camera: Camera): void {
    const b = cameraBasis(camera.matrixWorld, camera.projectionMatrix);
    const target = new Vector3(0, this.ground, 0);
    const size = Math.min(6000, Math.max(60, b.position.distanceTo(target) * 1.4));
    const u = this.uniforms;
    u.uBoxSize.value = size;
    u.uCentre.value.lerpVectors(b.position, target, 0.55);
    u.uBoxMin.value.copy(u.uCentre.value).subScalar(size / 2);
  }
}
