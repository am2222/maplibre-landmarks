import {
  AdditiveBlending,
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
import { windVector } from '../trees/material';
import {
  boltSegments,
  flashAt,
  nextStrikeIn,
  strikeLength,
  strikePulses,
  type Point3,
  type Pulse,
} from './lightning';
import { Overcast } from './overcast';
import { buildParticles } from './particles';
import {
  BOLT_FRAGMENT,
  BOLT_VERTEX,
  OVERLAY_FRAGMENT,
  OVERLAY_VERTEX,
  RAIN_FRAGMENT,
  RAIN_VERTEX,
} from './shaders';

export interface RainWind {
  /** 0 falls straight down; 1 slants the rain about 20°. Default 0.5. */
  strength?: number;
  /** Where the wind blows from, degrees clockwise from north (default 250). */
  directionDeg?: number;
}

export interface RainLightning {
  /** Mean seconds between strikes (default 10). */
  intervalS?: number;
  /** Share of strikes that show a bolt; the others only flash the clouds (default 0.6). */
  bolts?: number;
}

export interface RainOptions {
  /** 0 (drizzle) to 1 (downpour), default 0.7: drop count, streak opacity and how dark it gets. */
  intensity?: number;
  wind?: RainWind;
  /** Thunderstorm flashes and bolts (default true); false for plain rain. */
  lightning?: boolean | RainLightning;
  /** How much the scene darkens under the clouds at full intensity, 0–1 (default 0.45). */
  darken?: number;
  /** Grey the map's sky while it rains (default true). */
  overcastSky?: boolean;
  /** Wet roofs: darker and glossier, on every RoofsLayer of the map (default true). */
  wet?: boolean;
  /** Drops at full intensity (default 15000). */
  maxDrops?: number;
  /** Random numbers in [0, 1) for drop seeds and lightning (default Math.random). */
  random?: () => number;
}

export interface RainStats {
  drops: number;
  /** Lightning strikes so far. */
  strikes: number;
  /** Current flash brightness, 0–1. */
  flash: number;
}

/** Streak colour per theme: pale in daylight, dimmer at night. */
const RAIN_COLORS: Record<Theme, string> = {
  day: '#d2dae3',
  dawn: '#dccfc8',
  dusk: '#bdb6cc',
  night: '#8e9ab4',
};
const FLASH_COLOR = '#dde5ff';
const BOLT_COLOR = '#b9c8ff';
/** The fall offset wraps at this many metres (a one-frame reshuffle every few minutes). */
const FALL_PERIOD_M = 1e5;

const clamp01 = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));

export interface RainUniforms {
  [name: string]: IUniform;
  uBoxMin: IUniform<Vector3>;
  uBoxSize: IUniform<number>;
  uFall: IUniform<Vector3>;
  uDir: IUniform<Vector3>;
  uLength: IUniform<number>;
  uWidth: IUniform<number>;
  uCentre: IUniform<Vector3>;
  uGround: IUniform<number>;
  uColor: IUniform<Color>;
  uOpacity: IUniform<number>;
}

/**
 * Rain with thunderstorms: streaks falling around the camera, a darker overcast scene and sky,
 * lightning flashes with the odd bolt, and wet roofs.
 */
export class RainModule implements LayerModule {
  readonly uniforms: RainUniforms;
  rain?: Mesh<BufferGeometry, ShaderMaterial>;
  overlay?: Mesh<BufferGeometry, ShaderMaterial>;
  bolt?: Mesh<BufferGeometry, ShaderMaterial>;
  private ctx?: ModuleContext;
  private overcast?: Overcast;
  private theme: Theme = 'day';
  private intensity: number;
  private wind: Required<RainWind>;
  private lightning: Required<RainLightning> | false;
  private readonly random: () => number;
  private readonly maxDrops: number;
  /** Ground under the map centre (terrain), metres. */
  private ground = 0;
  private lastFrame?: number;
  /** Seconds on the module's clock (frame time). */
  private now = 0;
  private nextStrike = 0;
  private strikeAt?: number;
  private pulses: Pulse[] = [];
  private strikes = 0;
  private flash = 0;
  private camera = new Vector3(0, 500, 500);

  constructor(private readonly options: RainOptions = {}) {
    this.intensity = clamp01(options.intensity ?? 0.7);
    this.wind = {
      strength: Math.max(0, options.wind?.strength ?? 0.5),
      directionDeg: options.wind?.directionDeg ?? 250,
    };
    this.lightning = RainModule.lightningOf(options.lightning);
    this.random = options.random ?? Math.random;
    this.maxDrops = Math.max(1, Math.floor(options.maxDrops ?? 15000));
    this.uniforms = {
      uBoxMin: { value: new Vector3() },
      uBoxSize: { value: 700 },
      uFall: { value: new Vector3() },
      uDir: { value: new Vector3(0, -1, 0) },
      uLength: { value: 0.026 },
      uWidth: { value: 0.0004 },
      uCentre: { value: new Vector3() },
      uGround: { value: 0 },
      uColor: { value: new Color(RAIN_COLORS.day) },
      uOpacity: { value: 0.3 },
    };
  }

  private static lightningOf(l: RainOptions['lightning']): Required<RainLightning> | false {
    if (l === false) return false;
    const given = typeof l === 'object' ? l : {};
    return {
      intervalS: Math.max(0.5, given.intervalS ?? 10),
      bolts: clamp01(given.bolts ?? 0.6),
    };
  }

  onAdd(ctx: ModuleContext): void {
    this.ctx = ctx;
    const rain = new Mesh(
      buildParticles(this.maxDrops, this.random),
      new ShaderMaterial({
        vertexShader: RAIN_VERTEX,
        fragmentShader: RAIN_FRAGMENT,
        uniforms: this.uniforms,
        transparent: true,
        depthWrite: false,
        // Quads face the camera either way round.
        side: DoubleSide,
      }),
    );
    rain.onBeforeRender = (_r, _s, camera) => this.updateCamera(camera);
    const overlay = new Mesh(
      new BufferGeometry().setAttribute(
        'position',
        new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3),
      ),
      new ShaderMaterial({
        vertexShader: OVERLAY_VERTEX,
        fragmentShader: OVERLAY_FRAGMENT,
        uniforms: {
          uFlashColor: { value: new Color(FLASH_COLOR) },
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
    const bolt = new Mesh(
      new BufferGeometry(),
      new ShaderMaterial({
        vertexShader: BOLT_VERTEX,
        fragmentShader: BOLT_FRAGMENT,
        uniforms: { uColor: { value: new Color(BOLT_COLOR) }, uFlash: { value: 0 } },
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        blending: AdditiveBlending,
      }),
    );
    bolt.visible = false;
    // The overcast first (it dims what is already drawn), then the rain and the bolt over it.
    overlay.renderOrder = 1;
    rain.renderOrder = 2;
    bolt.renderOrder = 3;
    for (const m of [overlay, rain, bolt]) {
      m.frustumCulled = false;
      ctx.scene.add(m);
    }
    this.rain = rain;
    this.overlay = overlay;
    this.bolt = bolt;
    if (this.options.overcastSky ?? true) this.overcast = new Overcast(ctx.map);
    this.themeChanged(ctx.core.theme);
    this.applyIntensity();
    this.scheduleStrike();
  }

  update(view: ViewState): void {
    const map = this.ctx?.map;
    this.ground = map?.getTerrain?.() ? (map.queryTerrainElevation(view.center) ?? 0) : 0;
    this.uniforms.uGround.value = map?.getTerrain?.() ? -1e6 : 0;
  }

  place(_origin: Origin): void {
    // Drops are placed around the camera each frame (updateCamera), not at map positions.
  }

  frame(timeMs: number): boolean {
    const t = timeMs / 1000;
    const dt = this.lastFrame === undefined ? 0 : Math.min(0.1, t - this.lastFrame);
    this.lastFrame = t;
    this.now += dt;
    const u = this.uniforms;
    // Faster in a bigger box (zoomed out), so drops cross the screen at the same pace.
    const speed = u.uBoxSize.value * 0.9;
    const fall = u.uFall.value.addScaledVector(u.uDir.value, -speed * dt);
    fall.set(fall.x % FALL_PERIOD_M, fall.y % FALL_PERIOD_M, fall.z % FALL_PERIOD_M);
    this.stepLightning();
    return !!this.rain && this.intensity > 0;
  }

  themeChanged(theme: Theme): void {
    this.theme = theme;
    this.uniforms.uColor.value.set(RAIN_COLORS[theme]);
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
    for (const m of [this.rain, this.overlay, this.bolt]) {
      if (!m) continue;
      ctx.scene.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    }
    this.overcast?.restore();
    ctx.core.setWetness(0);
    this.rain = this.overlay = this.bolt = undefined;
    this.ctx = undefined;
  }

  /** 0 (drizzle) to 1 (downpour); 0 stops the rain. */
  setIntensity(intensity: number): void {
    this.intensity = clamp01(intensity);
    this.applyIntensity();
  }

  setWind(wind: RainWind): void {
    this.wind = { ...this.wind, ...wind };
    this.wind.strength = Math.max(0, this.wind.strength);
    this.applyWind();
    this.ctx?.requestRepaint();
  }

  /** Switch the thunderstorm on (optionally with new timing) or off. */
  setLightning(lightning: boolean | RainLightning): void {
    this.lightning = RainModule.lightningOf(lightning);
    if (!this.lightning) this.endStrike();
    this.scheduleStrike();
  }

  /** A lightning strike now, with a bolt unless `bolt` is false (also with lightning off). */
  strike(bolt = true): void {
    this.strikeAt = this.now;
    this.pulses = strikePulses(this.random);
    this.strikes++;
    if (bolt) this.buildBolt();
    else if (this.bolt) this.bolt.visible = false;
    this.ctx?.requestRepaint();
  }

  getStats(): RainStats {
    return {
      drops: this.dropCount(),
      strikes: this.strikes,
      flash: this.flash,
    };
  }

  private dropCount(): number {
    return this.intensity > 0 ? Math.round(this.maxDrops * (0.15 + 0.85 * this.intensity)) : 0;
  }

  private applyIntensity(): void {
    const k = this.intensity;
    this.rain?.geometry.setDrawRange(0, this.dropCount() * 6);
    if (this.rain) this.rain.visible = k > 0;
    this.uniforms.uOpacity.value = 0.12 + 0.3 * k;
    if (this.overlay) {
      this.overlay.material.uniforms.uDarken!.value = clamp01(this.options.darken ?? 0.45) * k;
      this.overlay.visible = k > 0;
    }
    this.applyWind();
    this.applySky();
    if (this.options.wet ?? true) this.ctx?.core.setWetness(k);
    this.ctx?.requestRepaint();
  }

  private applyWind(): void {
    const [x, z] = windVector(this.wind.directionDeg);
    const slant = 0.35 * this.wind.strength;
    this.uniforms.uDir.value.set(x * slant, -1, z * slant).normalize();
  }

  private applySky(): void {
    if (!this.overcast || !this.ctx) return;
    // During a style reload setSky throws; styleChanged(true) re-applies it afterwards.
    if (this.ctx.map.isStyleLoaded?.() === false) return;
    if (this.intensity > 0) this.overcast.apply(this.theme, 0.4 + 0.6 * this.intensity);
    else this.overcast.restore();
  }

  private scheduleStrike(): void {
    if (this.lightning)
      this.nextStrike = this.now + nextStrikeIn(this.lightning.intervalS, this.random);
  }

  private stepLightning(): void {
    if (
      this.strikeAt === undefined &&
      this.lightning &&
      this.intensity > 0 &&
      this.now >= this.nextStrike
    )
      this.strike(this.random() < this.lightning.bolts);
    if (this.strikeAt === undefined) {
      this.flash = 0;
    } else {
      const t = this.now - this.strikeAt;
      this.flash = flashAt(this.pulses, t);
      if (t > strikeLength(this.pulses)) {
        this.endStrike();
        this.scheduleStrike();
      }
    }
    if (this.overlay) this.overlay.material.uniforms.uFlash!.value = this.flash * 0.45;
    if (this.bolt) this.bolt.material.uniforms.uFlash!.value = Math.min(1, this.flash * 1.5);
  }

  private endStrike(): void {
    this.strikeAt = undefined;
    this.flash = 0;
    if (this.bolt) this.bolt.visible = false;
  }

  /** A bolt to the ground ahead of the camera, as camera-facing ribbons. */
  private buildBolt(): void {
    const bolt = this.bolt;
    if (!bolt) return;
    const rand = this.random;
    const cam = this.camera;
    const reach = Math.hypot(cam.x, cam.y - this.ground, cam.z);
    // Ahead of the camera, up to 60° either side of where it looks.
    const ahead = Math.atan2(-cam.z, -cam.x);
    const angle =
      (Math.hypot(cam.x, cam.z) > 1 ? ahead : rand() * Math.PI * 2) +
      ((rand() - 0.5) * (Math.PI * 2)) / 3;
    const dist = reach * (0.5 + rand() * 0.8);
    const groundPt: Point3 = [Math.cos(angle) * dist, this.ground, Math.sin(angle) * dist];
    const cloud = Math.min(3000, Math.max(300, reach * 1.5));
    const top: Point3 = [
      groundPt[0] + (rand() - 0.5) * cloud * 0.3,
      this.ground + cloud,
      groundPt[2] + (rand() - 0.5) * cloud * 0.3,
    ];
    const width = Math.max(0.6, reach * 0.004);
    const pos: number[] = [];
    const side: number[] = [];
    const a = new Vector3();
    const b = new Vector3();
    const dir = new Vector3();
    const toCam = new Vector3();
    const off = new Vector3();
    for (const [p, q] of boltSegments(top, groundPt, rand)) {
      a.set(...p);
      b.set(...q);
      dir.subVectors(b, a).normalize();
      toCam.subVectors(cam, a).normalize();
      off.crossVectors(dir, toCam).normalize().multiplyScalar(width);
      const corners = [
        [a.x - off.x, a.y - off.y, a.z - off.z, -1],
        [a.x + off.x, a.y + off.y, a.z + off.z, 1],
        [b.x - off.x, b.y - off.y, b.z - off.z, -1],
        [b.x + off.x, b.y + off.y, b.z + off.z, 1],
      ];
      for (const i of [0, 2, 1, 1, 2, 3]) {
        const c = corners[i]!;
        pos.push(c[0]!, c[1]!, c[2]!);
        side.push(c[3]!);
      }
    }
    bolt.geometry.dispose();
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    g.setAttribute('aSide', new Float32BufferAttribute(side, 1));
    bolt.geometry = g;
    bolt.visible = true;
  }

  /** The rain box follows the camera: between it and the ground it looks at, sized by distance. */
  private updateCamera(camera: Camera): void {
    const b = cameraBasis(camera.matrixWorld, camera.projectionMatrix);
    this.camera.copy(b.position);
    const target = new Vector3(0, this.ground, 0);
    const reach = b.position.distanceTo(target);
    const size = Math.min(6000, Math.max(60, reach * 1.4));
    const u = this.uniforms;
    u.uBoxSize.value = size;
    u.uCentre.value.lerpVectors(b.position, target, 0.55);
    u.uBoxMin.value.copy(u.uCentre.value).subScalar(size / 2);
    // Per metre from the camera: streaks about 1 px wide and 35 px long on a 900 px tall view.
    u.uLength.value = 0.026;
    u.uWidth.value = 0.0004;
  }
}
