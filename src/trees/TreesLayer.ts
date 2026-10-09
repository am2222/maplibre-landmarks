import type { Theme } from '../core/theme';
import { ModuleLayer, type ModuleLayerOptions } from '../core/ModuleLayer';
import { TreesModule, type TreeStats, type TreesOptions, type TreesWind } from './TreesModule';

export interface TreesLayerOptions extends TreesOptions, ModuleLayerOptions {
  id: string;
}

/** MapLibre custom layer drawing instanced, wind-animated, theme-coloured 3D trees. */
export class TreesLayer extends ModuleLayer {
  private readonly trees: TreesModule;

  constructor(options: TreesLayerOptions) {
    const trees = new TreesModule(options);
    super(options.id, trees, options);
    this.trees = trees;
  }

  setWind(wind: TreesWind): void {
    this.trees.setWind(wind);
  }

  setTheme(theme: Theme): void {
    this.trees.setTheme(theme);
  }

  /** Share of trees drawn, 0–1 (mapped and scattered). */
  setDensity(density: number): void {
    this.trees.setDensity(density);
  }

  getStats(): TreeStats {
    return this.trees.getStats();
  }
}
