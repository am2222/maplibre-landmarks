import { ModuleLayer, type ModuleLayerOptions } from '../core/ModuleLayer';
import {
  RainModule,
  type RainLightning,
  type RainOptions,
  type RainStats,
  type RainWind,
} from './RainModule';

export interface RainLayerOptions extends RainOptions, ModuleLayerOptions {
  id: string;
}

/**
 * Rain and thunderstorms: falling streaks, an overcast sky and scene, lightning, wet roofs.
 * Add it after the other 3D layers (and after a FogLayer) so it dims and lights them all.
 */
export class RainLayer extends ModuleLayer {
  private readonly rain: RainModule;

  constructor(options: RainLayerOptions) {
    const rain = new RainModule(options);
    super(options.id, rain, { minZoom: options.minZoom ?? 10, ...options });
    this.rain = rain;
  }

  /** 0 (drizzle) to 1 (downpour); 0 stops the rain. */
  setIntensity(intensity: number): void {
    this.rain.setIntensity(intensity);
  }

  setWind(wind: RainWind): void {
    this.rain.setWind(wind);
  }

  /** Switch the thunderstorm on (optionally with new timing) or off. */
  setLightning(lightning: boolean | RainLightning): void {
    this.rain.setLightning(lightning);
  }

  /** A lightning strike now, with a bolt unless `bolt` is false. */
  strike(bolt?: boolean): void {
    this.rain.strike(bolt);
  }

  getStats(): RainStats {
    return this.rain.getStats();
  }
}
