import { ModuleLayer, type ModuleLayerOptions } from '../core/ModuleLayer';
import { FogModule, type FogOptions, type FogWind } from './FogModule';

export interface FogLayerOptions extends FogOptions, ModuleLayerOptions {
  id: string;
}

/** Volumetric ground fog. Add it after the other 3D layers so it blends over them. */
export class FogLayer extends ModuleLayer {
  private readonly fog: FogModule;

  constructor(options: FogLayerOptions) {
    const fog = new FogModule(options);
    super(options.id, fog, { minZoom: options.minZoom ?? 12, ...options });
    this.fog = fog;
  }

  setDensity(density: number): void {
    this.fog.setDensity(density);
  }

  setWind(wind: FogWind): void {
    this.fog.setWind(wind);
  }

  setHeight(height: number): void {
    this.fog.setHeight(height);
  }

  setAltitude(altitude: number | undefined): void {
    this.fog.setAltitude(altitude);
  }

  setCoverage(coverage: number): void {
    this.fog.setCoverage(coverage);
  }
}
