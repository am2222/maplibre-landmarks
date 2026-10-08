import type { Map as MlMap } from 'maplibre-gl';
import { Camera, Scene, WebGLRenderer, type Object3D } from 'three';
import { createLightRig, type LightRig, type Theme } from './theme';
import { cameraMatrix, originAt } from './mercator';
import type { Origin } from './types';

export interface RendererLike {
  resetState(): void;
  render(scene: Scene, camera: Camera): void;
  /** Compiles shaders without drawing (three's WebGLRenderer.compileAsync). */
  compileAsync?(object: Object3D, camera: Camera, scene?: Scene | null): Promise<unknown>;
  dispose(): void;
}

export type CoreMap = Pick<MlMap, 'getCenter' | 'getCanvas'>;
/** The parts of MapLibre's CustomRenderMethodInput the core needs. */
export interface FrameProjection {
  /** Mercator world → clip (`defaultProjectionData.mainMatrix`). */
  mainMatrix: ArrayLike<number>;
  /** Camera space → clip (`projectionMatrix`). */
  projectionMatrix: ArrayLike<number>;
}

export type RendererFactory = (map: CoreMap, gl: WebGL2RenderingContext) => RendererLike;

/** Anything that wants to hear about theme changes (every LayerModule qualifies). */
export interface ThemeListener {
  themeChanged?(theme: Theme): void;
}

export const createWebGLRenderer: RendererFactory = (map, gl) => {
  const renderer = new WebGLRenderer({
    canvas: map.getCanvas(),
    // Antialiasing is fixed by MapLibre's context attributes, not a renderer option here.
    context: gl as unknown as WebGLRenderingContext,
  });
  renderer.autoClear = false;
  return renderer;
};

const cores = new WeakMap<object, ThreeCore>();
/** Themes set on a map while it has no core (before any layer, or between re-adds). */
const pendingThemes = new WeakMap<object, Theme>();

export function acquireCore(
  map: CoreMap,
  gl: WebGL2RenderingContext,
  factory: RendererFactory = createWebGLRenderer,
): ThreeCore {
  let core = cores.get(map);
  if (!core) {
    core = new ThreeCore(map, factory(map, gl), pendingThemes.get(map) ?? 'day');
    pendingThemes.delete(map);
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
    pendingThemes.set(map, core.theme);
    core.dispose();
    cores.delete(map);
  }
}

/** Switch every plugin layer on `map` to `theme` (remembered if no layer is added yet). */
export function setTheme(map: object, theme: Theme): void {
  const core = cores.get(map);
  if (core) core.setTheme(theme);
  else pendingThemes.set(map, theme);
}

/** One Three.js renderer per map, shared by every module layer on it. */
export class ThreeCore {
  refs = 0;
  private readonly camera = new Camera();
  private readonly rigs = new Map<Scene, LightRig>();
  private readonly listeners = new Set<ThemeListener>();
  private warmQueue: { object: Object3D; scene: Scene; resolve: () => void }[] = [];

  constructor(
    private readonly map: CoreMap,
    readonly renderer: RendererLike,
    private current: Theme = 'day',
  ) {
    // The view matrix is set directly each frame; three must not rebuild it from position.
    this.camera.matrixAutoUpdate = false;
    this.camera.matrixWorldAutoUpdate = false;
  }

  get theme(): Theme {
    return this.current;
  }

  createScene(): Scene {
    const scene = new Scene();
    const rig = createLightRig(this.current);
    scene.add(rig.group);
    this.rigs.set(scene, rig);
    return scene;
  }

  releaseScene(scene: Scene): void {
    this.rigs.delete(scene);
  }

  register(listener: ThemeListener): void {
    this.listeners.add(listener);
  }

  unregister(listener: ThemeListener): void {
    this.listeners.delete(listener);
  }

  setTheme(theme: Theme): void {
    this.current = theme;
    for (const rig of this.rigs.values()) rig.setTheme(theme);
    for (const l of this.listeners) l.themeChanged?.(theme);
  }

  /**
   * Compile `object`'s shaders (lit by `scene`) before it is drawn, so its first frame does not
   * stall. Resolves immediately when the renderer cannot compile ahead; never rejects.
   */
  warmUp(object: Object3D, scene: Scene): Promise<void> {
    if (!this.renderer.compileAsync) return Promise.resolve();
    return new Promise((resolve) => this.warmQueue.push({ object, scene, resolve }));
  }

  /**
   * Start queued compiles. GL state may only be touched inside MapLibre's render callback, so
   * layers call this from `render` (the compile then finishes in the background).
   */
  compilePending(): void {
    if (!this.warmQueue.length || !this.renderer.compileAsync) return;
    const queue = this.warmQueue;
    this.warmQueue = [];
    for (const { object, scene, resolve } of queue) {
      this.renderer.resetState();
      try {
        this.renderer.compileAsync(object, this.camera, scene).then(resolve, resolve);
      } catch {
        resolve();
      } finally {
        this.renderer.resetState();
      }
    }
  }

  /**
   * Splits MapLibre's view-projection into a real projection and a view matrix in local metres,
   * so the camera has a true position for view-dependent shading (specular, environment).
   */
  render(scene: Scene, projection: FrameProjection, place: (origin: Origin) => void): void {
    const center = this.map.getCenter();
    const origin = originAt([center.lng, center.lat]);
    place(origin);
    const camera = this.camera;
    camera.projectionMatrix.fromArray(Array.from(projection.projectionMatrix));
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    camera.matrixWorldInverse.multiplyMatrices(
      camera.projectionMatrixInverse,
      cameraMatrix(projection.mainMatrix, origin),
    );
    camera.matrixWorld.copy(camera.matrixWorldInverse).invert();
    this.renderer.resetState();
    this.renderer.render(scene, this.camera);
    this.renderer.resetState();
  }

  dispose(): void {
    for (const { resolve } of this.warmQueue) resolve();
    this.warmQueue = [];
    this.rigs.clear();
    this.listeners.clear();
    this.renderer.dispose();
  }
}
