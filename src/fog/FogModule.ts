import {
  Color,
  DoubleSide,
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
import { noiseCell, valleyFloor } from './profile';
import { FOG_FRAGMENT, FOG_VERTEX } from './shaders';
import {
  buildSliceGeometry,
  cameraBasis,
  indexFor,
  layerAltitudes,
  layerOrder,
  MAX_SLICES,
  NOISE_PERIOD_M,
  noiseOrigin,
} from './slices';

export interface FogWind {
  /** Metres per second. */
  speed?: number;
  /** Compass bearing the wind blows toward, degrees. */
  direction?: number;
}

export interface FogOptions {
  density?: number;
  /** Fog thickness in metres above the ground (flat maps) or the valley floor (terrain). */
  height?: number;
  /** With terrain: absolute fog top in metres; overrides `height`. */
  altitude?: number;
  /** 0..1: from scattered patches to a full blanket. */
  coverage?: number;
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
  /** Altitude of each layer (band centre), metres. */
  uAlt: IUniform<number[]>;
  /** Height of each layer's band of air, metres. */
  uStep: IUniform<number>;
  uFogColor: IUniform<Color>;
  uSunColor: IUniform<Color>;
  uSunDir: IUniform<Vector3>;
  uOrigin: IUniform<Vector2>;
  uScroll: IUniform<Vector2>;
  uNoiseScale: IUniform<number>;
  uTop: IUniform<number>;
  uSoft: IUniform<number>;
  uClip: IUniform<number>;
  uCoverage: IUniform<number>;
  uCell: IUniform<number>;
  uPeriod: IUniform<number>;
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
  private height: number;
  private altitude?: number;
  /** Valley floor (terrain) or ground plane (0), metres. */
  private floor = 0;
  /** Ground under the map centre, for the camera distance. */
  private centreGround = 0;
  /** Metres from the map centre to the farthest corner of the visible bounds. */
  private viewReach = 0;
  private zoomOk = true;
  private lastFrame?: number;
  /** Draw order last uploaded (changes only when the camera crosses a layer). */
  private orderKey = '';
  private lastView?: ViewState;

  constructor(private readonly options: FogOptions = {}) {
    this.density = Math.max(0, options.density ?? 0.6);
    this.speed = Math.max(0, options.wind?.speed ?? 2);
    this.direction = options.wind?.direction ?? 270;
    this.slices = clamp(Math.round(options.slices ?? 32), 8, MAX_SLICES);
    this.height = Math.max(1, options.height ?? 40);
    this.altitude = options.altitude;
    this.uniforms = {
      uCamPos: { value: new Vector3() },
      uAlt: { value: new Array<number>(MAX_SLICES).fill(0) },
      uStep: { value: 1 },
      uFogColor: { value: new Color() },
      uSunColor: { value: new Color() },
      uSunDir: { value: new Vector3(0, 1, 0) },
      uOrigin: { value: new Vector2() },
      uScroll: { value: new Vector2() },
      uNoiseScale: { value: 1 },
      uTop: { value: this.height },
      uSoft: { value: 8 },
      uClip: { value: 0 },
      uCoverage: { value: clamp(options.coverage ?? 0.65, 0, 1) },
      uCell: { value: 128 },
      uPeriod: { value: 32 },
      uDensity: { value: this.density },
      uRadius: { value: Math.max(100, options.radius ?? 1500) },
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
      // Layers are seen from above and below.
      side: DoubleSide,
    });
    const mesh = new Mesh(buildSliceGeometry(this.slices), material);
    mesh.frustumCulled = false;
    mesh.onBeforeRender = (_renderer, _scene, camera) => this.updateCamera(camera);
    this.mesh = mesh;
    ctx.scene.add(mesh);
    if (this.options.horizonHaze ?? true) this.haze = new Haze(ctx.map);
    this.themeChanged((ctx.core as { theme?: Theme }).theme ?? 'day');
    ctx.map.on('terrain', this.onTerrain);
    ctx.map.on('sourcedata', this.onSourceData);
    this.applyVisibility();
  }

  update(view: ViewState): void {
    this.lastView = view;
    // Low, pitched views see the ground tens of kilometres away: the fog must reach as far, or
    // a clear strip opens between it and MapLibre's horizon haze.
    const [cx, cy] = view.center;
    const [w, s, e, n] = view.bounds;
    const kx = 111_195 * Math.cos((cy * Math.PI) / 180);
    this.viewReach = Math.max(
      ...[
        [w, s],
        [e, s],
        [e, n],
        [w, n],
      ].map(([x, y]) => Math.hypot((x! - cx) * kx, (y! - cy) * 111_195)),
    );
    this.zoomOk = view.zoom >= (this.options.minZoom ?? 12);
    // Noise scale follows the zoom, set when the camera settles (no swimming while zooming).
    const cell = noiseCell(view.zoom);
    this.uniforms.uCell.value = cell;
    this.uniforms.uPeriod.value = NOISE_PERIOD_M / cell;
    this.updateGround();
    this.applyVisibility();
  }

  place(origin: Origin): void {
    const [x, z, scale] = noiseOrigin(origin);
    this.uniforms.uOrigin.value.set(x, z);
    this.uniforms.uNoiseScale.value = scale;
  }

  frame(timeMs: number): boolean {
    const dt = this.lastFrame === undefined ? 0 : Math.min(0.1, (timeMs - this.lastFrame) / 1000);
    this.lastFrame = timeMs;
    const [wx, wz] = bearingVector(this.direction);
    const scroll = this.uniforms.uScroll.value;
    const wrap = (v: number) => ((v % NOISE_PERIOD_M) + NOISE_PERIOD_M) % NOISE_PERIOD_M;
    const step = this.speed * dt * this.uniforms.uNoiseScale.value; // ground m → noise m
    scroll.set(wrap(scroll.x + wx * step), wrap(scroll.y + wz * step));
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
    // During a style reload setSky throws; styleChanged(true) re-applies the tint afterwards.
    if (this.ctx?.map.isStyleLoaded() !== false) this.haze?.apply(color);
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

  setHeight(height: number): void {
    this.height = Math.max(1, height);
    this.applyTop();
  }

  setAltitude(altitude: number | undefined): void {
    this.altitude = altitude;
    this.applyTop();
  }

  setCoverage(coverage: number): void {
    this.uniforms.uCoverage.value = clamp(coverage, 0, 1);
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
    ctx.map.off('sourcedata', this.onSourceData);
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

  /** Valley floor (lowest terrain in view) and centre ground, or the flat ground plane. */
  private updateGround(): void {
    const map = this.ctx?.map;
    const center = this.lastView?.center;
    if (!map || !center) return;
    if (map.getTerrain()) {
      const floor = valleyFloor(map, 6 * noiseCell(this.lastView!.zoom));
      this.floor = floor ?? 0;
      this.centreGround = map.queryTerrainElevation(center) ?? this.floor;
    } else {
      this.floor = 0;
      this.centreGround = 0;
    }
    this.applyTop();
  }

  /** Fog top and soft edge; clipping at the ground plane only on flat maps. */
  private applyTop(): void {
    const terrain = !!this.ctx?.map.getTerrain();
    const u = this.uniforms;
    u.uTop.value = terrain ? (this.altitude ?? this.floor + this.height) : this.height;
    u.uClip.value = terrain ? -1e6 : 0;
    u.uSoft.value = Math.max(8, 0.35 * (u.uTop.value - this.floor));
    // Layers stack from the ground (or valley floor) to the highest the billowing top can reach.
    const base = terrain ? this.floor : 0;
    const { altitudes, step } = layerAltitudes(base, u.uTop.value + u.uSoft.value, this.slices);
    for (let i = 0; i < MAX_SLICES; i++)
      u.uAlt.value[i] = altitudes[Math.min(i, altitudes.length - 1)]!;
    u.uStep.value = step;
    this.orderKey = '';
    this.ctx?.requestRepaint();
  }

  private applyVisibility(): void {
    if (!this.mesh) return;
    const visible = this.zoomOk && this.density > 0;
    if (visible !== this.mesh.visible) this.ctx?.requestRepaint();
    this.mesh.visible = visible;
  }

  /** DEM tiles arriving refine the ground height (the terrain event fires before they load). */
  private readonly onSourceData = (e: { sourceId?: string }): void => {
    const terrain = this.ctx?.map.getTerrain();
    if (!terrain || e.sourceId !== terrain.source) return;
    this.updateGround();
    this.ctx?.requestRepaint();
  };

  /** Camera uniforms and layer draw order for this frame (three has just set the camera). */
  private updateCamera(camera: Camera): void {
    const b = cameraBasis(camera.matrixWorld, camera.projectionMatrix);
    const u = this.uniforms;
    u.uCamPos.value.copy(b.position);
    const toCentre = b.position.distanceTo(new Vector3(0, this.centreGround, 0));
    u.uRadius.value = this.options.radius ?? Math.max(1500, 1.5 * toCentre, this.viewReach);
    const order = layerOrder(u.uAlt.value.slice(0, this.slices), b.position.y);
    const key = order.join();
    if (key !== this.orderKey && this.mesh) {
      this.orderKey = key;
      this.mesh.geometry.setIndex(indexFor(order));
    }
  }
}
