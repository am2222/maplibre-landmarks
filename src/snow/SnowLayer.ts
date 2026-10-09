import { ModuleLayer, type ModuleLayerOptions } from '../core/ModuleLayer';
import { SnowModule, type SnowOptions, type SnowStats, type SnowWind } from './SnowModule';

export interface SnowLayerOptions extends SnowOptions, ModuleLayerOptions {
  id: string;
}

/**
 * Falling snow: swaying flakes, a pale haze and grey sky, and snow settling on roofs. Add it after
 * the other 3D layers (and after a FogLayer) so its haze lies over them all.
 */
export class SnowLayer extends ModuleLayer {
  private readonly snow: SnowModule;

  constructor(options: SnowLayerOptions) {
    const snow = new SnowModule(options);
    super(options.id, snow, { minZoom: options.minZoom ?? 10, ...options });
    this.snow = snow;
  }

  /** 0 (a few flakes) to 1 (heavy snowfall); 0 stops the snow (what settled melts away). */
  setIntensity(intensity: number): void {
    this.snow.setIntensity(intensity);
  }

  setWind(wind: SnowWind): void {
    this.snow.setWind(wind);
  }

  getStats(): SnowStats {
    return this.snow.getStats();
  }
}
