import { ModuleLayer, type ModuleLayerOptions } from '../core/ModuleLayer';
import {
  StreetFurnitureModule,
  type StreetFurnitureOptions,
  type StreetFurnitureStats,
} from './StreetFurnitureModule';

export interface StreetFurnitureLayerOptions extends StreetFurnitureOptions, ModuleLayerOptions {
  id: string;
}

/** MapLibre custom layer drawing street furniture: benches, bins, bollards, hydrants and more. */
export class StreetFurnitureLayer extends ModuleLayer {
  private readonly street: StreetFurnitureModule;

  constructor(options: StreetFurnitureLayerOptions) {
    const street = new StreetFurnitureModule(options);
    super(options.id, street, options);
    this.street = street;
  }

  getStats(): StreetFurnitureStats {
    return this.street.getStats();
  }
}
