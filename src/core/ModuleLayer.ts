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
  /** Below this zoom the layer draws nothing. */
  minZoom?: number;
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
    this.module.onAdd({
      map,
      core: this.core,
      scene: this.scene,
      requestRepaint: () => map.triggerRepaint(),
    });
    this.core.register(this.module);
    map.on('moveend', this.onMoveEnd);
    map.on('style.load', this.onStyleLoad);
    this.module.update(viewStateOf(map));
  }

  onRemove(_map?: MlMap, _gl?: WebGL2RenderingContext): void {
    if (!this.map) return; // already torn down (e.g. by a style swap)
    clearTimeout(this.timer);
    this.map.off('moveend', this.onMoveEnd);
    this.map.off('style.load', this.onStyleLoad);
    this.core?.unregister(this.module);
    this.module.onRemove();
    if (this.scene) this.core?.releaseScene(this.scene);
    releaseCore(this.map);
    this.map = undefined;
    this.core = undefined;
    this.scene = undefined;
  }

  render(_gl: WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    if (!this.map || !this.core || !this.scene) return;
    this.core.compilePending();
    // Mid globe↔mercator morph the mercator matrix no longer matches what MapLibre draws.
    const drawable =
      options.defaultProjectionData.projectionTransition === 0 &&
      this.map.getZoom() >= (this.options.minZoom ?? 0);
    if (drawable) {
      this.core.render(
        this.scene,
        {
          mainMatrix: options.defaultProjectionData.mainMatrix,
          projectionMatrix: options.projectionMatrix,
        },
        (origin) => this.module.place(origin),
      );
    }
    // Animations keep running while drawing is skipped, so fades never freeze half-way.
    if (this.module.frame?.(performance.now())) this.map.triggerRepaint();
  }

  /** setStyle never calls onRemove on custom layers: re-sync, or tear down if the layer is gone. */
  private readonly onStyleLoad = (): void => {
    if (!this.map) return;
    // Attached only if the style's layer with our id is *this* instance: after a full swap the app
    // may already have added a new layer under the same id (MapLibre's CustomStyleLayer exposes
    // the wrapped object as `implementation`).
    const styleLayer = this.map.getLayer(this.id) as { implementation?: unknown } | undefined;
    const attached =
      !!styleLayer && (!('implementation' in styleLayer) || styleLayer.implementation === this);
    this.module.styleChanged?.(attached);
    if (!attached) this.onRemove();
  };

  private readonly onMoveEnd = (): void => {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.map) this.module.update(viewStateOf(this.map));
    }, this.options.debounceMs ?? 150);
  };
}
