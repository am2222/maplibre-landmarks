import { ModuleLayer, type ModuleLayerOptions } from '../core/ModuleLayer';
import {
  FireModule,
  type FireData,
  type FireOptions,
  type FireStats,
  type FireWind,
} from './FireModule';

export interface FireLayerOptions extends FireOptions, ModuleLayerOptions {
  id: string;
}

/**
 * Wildfires from polygon perimeters: burned ground, a spreading flaming front, flames and
 * embers, draped on the terrain. Add it under the 3D layers so buildings stand in front of it.
 */
export class FireLayer extends ModuleLayer {
  private readonly fire: FireModule;

  constructor(options: FireLayerOptions) {
    const fire = new FireModule(options);
    super(options.id, fire, { minZoom: options.minZoom ?? 8, ...options });
    this.fire = fire;
  }

  /** Replace the fire perimeters (GeoJSON polygons); the spread restarts from them. */
  setData(data: FireData | null): void {
    this.fire.setData(data);
  }

  setWind(wind: FireWind): void {
    this.fire.setWind(wind);
  }

  /** Base rate of spread, metres per fire minute. */
  setRate(rate: number): void {
    this.fire.setRate(rate);
  }

  setPlaying(playing: boolean): void {
    this.fire.setPlaying(playing);
  }

  /** Back to the mapped perimeters. */
  resetSpread(): void {
    this.fire.resetSpread();
  }

  getStats(): FireStats {
    return this.fire.getStats();
  }
}
