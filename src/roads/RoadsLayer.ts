import { ModuleLayer, type ModuleLayerOptions } from '../core/ModuleLayer';
import { RoadsModule, type RoadsOptions, type RoadsStats } from './RoadsModule';

export interface RoadsLayerOptions extends RoadsOptions, ModuleLayerOptions {
  id: string;
}

/**
 * MapLibre custom layer drawing roads and railways off the ground in 3D: bridges on piers, and the
 * roads ramping up onto them.
 */
export class RoadsLayer extends ModuleLayer {
  private readonly roads: RoadsModule;

  constructor(options: RoadsLayerOptions) {
    const roads = new RoadsModule(options);
    super(options.id, roads, { minZoom: options.minZoom ?? 15, ...options });
    this.roads = roads;
  }

  getStats(): RoadsStats {
    return this.roads.getStats();
  }
}
