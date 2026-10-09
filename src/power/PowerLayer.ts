import { ModuleLayer, type ModuleLayerOptions } from '../core/ModuleLayer';
import { PowerModule, type PowerOptions, type PowerStats } from './PowerModule';

export interface PowerLinesLayerOptions extends PowerOptions, ModuleLayerOptions {
  id: string;
}

/** MapLibre custom layer drawing power lines: pylons, poles and sagging wires. */
export class PowerLinesLayer extends ModuleLayer {
  private readonly power: PowerModule;

  constructor(options: PowerLinesLayerOptions) {
    const power = new PowerModule(options);
    super(options.id, power, options);
    this.power = power;
  }

  getStats(): PowerStats {
    return this.power.getStats();
  }
}
