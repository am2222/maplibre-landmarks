import type { BufferGeometry } from 'three';

/** A tree's geometry in metres, glTF axes (Y up), base at y = 0. Colours come from the theme. */
export interface TreeParts {
  /** Trunk and branches (bare branches show when a deciduous tree drops its leaves). */
  trunk: BufferGeometry;
  /**
   * Leaves. An array gives separate leaf clumps, which fall one by one in autumn; a single
   * geometry shrinks as one crown.
   */
  foliage: BufferGeometry | BufferGeometry[];
  /** Brightness multiplier on the theme's trunk colour (e.g. pale birch bark). Default 1. */
  trunkTone?: number;
  /** Brightness multiplier on the theme's foliage colour. Default 1. */
  foliageTone?: number;
}

export interface TreeModel {
  id: string;
  /** Seeded variants to prebuild. Default 4. */
  variants?: number;
  build(seed: number): TreeParts | Promise<TreeParts>;
  /**
   * 'deciduous' (default): fresh green in spring, autumn colours, bare in winter.
   * 'evergreen': green all year, snowy in winter. Matches OSM `leaf_cycle`.
   */
  leafCycle?: 'deciduous' | 'evergreen';
  /** Share of a deciduous model's trees in blossom in spring, 0–1 (default 0). */
  blossom?: number;
  /** Far-LOD stand-in. Default: a cone or round crown derived from variant 0's bounds. */
  impostor?(): TreeParts | Promise<TreeParts>;
}
