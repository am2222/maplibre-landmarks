import type { Theme } from '../core/theme';
import { ModuleLayer, type ModuleLayerOptions } from '../core/ModuleLayer';
import type { TreeSeason } from './season';
import {
  TreesModule,
  type SeasonTransition,
  type TreeStats,
  type TreesOptions,
  type TreesWind,
} from './TreesModule';

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

  /**
   * Time of year: 'spring' | 'summer' | 'autumn' | 'winter', 'auto' (today's date at the map's
   * latitude) or 0 spring … 3 winter. Eases forward through the year over `durationMs` (1500).
   */
  setSeason(season: TreeSeason, transition?: SeasonTransition): void {
    this.trees.setSeason(season, transition);
  }

  /** The current time of year, 0 spring … 3 winter (mid-transition while easing). */
  getSeason(): number {
    return this.trees.getSeason();
  }

  /** Snow on evergreens and bare branches in winter. */
  setSnow(snow: boolean): void {
    this.trees.setSnow(snow);
  }

  /** Share of trees drawn, 0–1 (mapped and scattered). */
  setDensity(density: number): void {
    this.trees.setDensity(density);
  }

  getStats(): TreeStats {
    return this.trees.getStats();
  }
}
