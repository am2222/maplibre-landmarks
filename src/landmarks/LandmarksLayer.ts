import type { Theme } from '../core/theme';
import { ModuleLayer, type ModuleLayerOptions } from '../core/ModuleLayer';
import {
  DISCOVERY_MIN_ZOOM,
  LandmarksModule,
  type LandmarkInfo,
  type LandmarksOptions,
} from './LandmarksModule';

export interface LandmarksLayerOptions extends LandmarksOptions, ModuleLayerOptions {
  id: string;
}

/** MapLibre custom layer that renders Open Landmarks 3D models. */
export class LandmarksLayer extends ModuleLayer {
  private readonly landmarks: LandmarksModule;

  constructor(options: LandmarksLayerOptions) {
    const landmarks = new LandmarksModule(options.id, options);
    super(options.id, landmarks, { minZoom: DISCOVERY_MIN_ZOOM, ...options });
    this.landmarks = landmarks;
  }

  setTheme(theme: Theme): void {
    this.landmarks.setTheme(theme);
  }

  getVisibleModels(): LandmarkInfo[] {
    return this.landmarks.getVisibleModels();
  }

  getAttribution(): string {
    return this.landmarks.getAttribution();
  }
}
