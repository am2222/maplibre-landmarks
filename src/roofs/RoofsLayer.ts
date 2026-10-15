import { ModuleLayer, type ModuleLayerOptions } from '../core/ModuleLayer';
import type { LngLat } from '../core/types';
import { RoofsModule, type RoofAt, type RoofsOptions } from './RoofsModule';

export interface RoofsLayerOptions extends RoofsOptions, ModuleLayerOptions {
  id: string;
}

/** MapLibre custom layer drawing roof shapes on an app's fill-extrusion buildings. */
export class RoofsLayer extends ModuleLayer {
  private readonly roofs: RoofsModule;

  constructor(options: RoofsLayerOptions) {
    const roofs = new RoofsModule(options);
    super(options.id, roofs, { minZoom: options.minZoom ?? 15, ...options });
    this.roofs = roofs;
  }

  getStats(): { buildings: number; triangles: number } {
    return this.roofs.getStats();
  }

  /** The roofs drawn whose footprint holds a point, for inspecting what was built and why. */
  roofsAt(lngLat: LngLat): RoofAt[] {
    return this.roofs.roofsAt(lngLat);
  }
}
