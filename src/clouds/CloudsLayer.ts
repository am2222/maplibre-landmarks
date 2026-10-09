import { ModuleLayer, type ModuleLayerOptions } from '../core/ModuleLayer';
import { CloudsModule, type CloudsOptions, type CloudsWind } from './CloudsModule';

export interface CloudsLayerOptions extends CloudsOptions, ModuleLayerOptions {
  id: string;
}

/**
 * Volumetric clouds overhead, drifting with the wind and casting soft shadows on the map. Add it
 * after the other 3D layers so its shadows fall on them.
 */
export class CloudsLayer extends ModuleLayer {
  private readonly clouds: CloudsModule;

  constructor(options: CloudsLayerOptions) {
    const clouds = new CloudsModule(options);
    super(options.id, clouds, { minZoom: options.minZoom ?? 9, ...options });
    this.clouds = clouds;
  }

  /** 0 (clear sky) to 1 (overcast). */
  setCoverage(coverage: number): void {
    this.clouds.setCoverage(coverage);
  }

  setDensity(density: number): void {
    this.clouds.setDensity(density);
  }

  /** Cloud base above the ground under the map centre, and optionally the deck's depth (metres). */
  setAltitude(base: number, thickness?: number): void {
    this.clouds.setAltitude(base, thickness);
  }

  setWind(wind: CloudsWind): void {
    this.clouds.setWind(wind);
  }

  /** Shadow darkness 0–1; 0 or false turns the shadows off. */
  setShadows(shadows: number | false): void {
    this.clouds.setShadows(shadows);
  }
}
