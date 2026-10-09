import type { Map as MlMap } from 'maplibre-gl';
import type { Scene } from 'three';
import type { ThreeCore } from './ThreeCore';
import type { Theme } from './theme';
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
  /**
   * The map's style was replaced (`style.load`). MapLibre does not call onRemove on a style
   * swap, so modules must drop state tied to the old style. `attached` is false when the new
   * style no longer contains this layer; onRemove follows immediately.
   */
  styleChanged?(attached: boolean): void;
  /** The map-wide theme changed (`setTheme(map, theme)`); update palettes, then repaint. */
  themeChanged?(theme: Theme): void;
  /** Surfaces got wetter or drier (a RainLayer), 0 dry to 1 downpour. */
  wetnessChanged?(wetness: number): void;
  onRemove(): void;
}
