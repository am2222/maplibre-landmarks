import { ModuleLayer, type ModuleLayerOptions } from '../core/ModuleLayer';
import { WaterModule, type WaterOptions } from './WaterModule';

export interface WaterLayerOptions extends WaterOptions, ModuleLayerOptions {
  id: string;
}

/** MapLibre custom layer drawing animated water over the basemap's water polygons. */
export class WaterLayer extends ModuleLayer {
  private readonly water: WaterModule;

  constructor(options: WaterLayerOptions) {
    const water = new WaterModule(options);
    super(options.id, water, { minZoom: options.minZoom ?? 12, ...options });
    this.water = water;
  }

  setWaves(waves: number): void {
    this.water.setWaves(waves);
  }

  getStats(): { pieces: number; triangles: number } {
    return this.water.getStats();
  }
}
