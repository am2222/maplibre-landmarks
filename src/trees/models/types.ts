import type { BufferGeometry } from 'three';

/** A tree's geometry in metres, glTF axes (Y up), base at y = 0. Colours come from the theme. */
export interface TreeParts {
  trunk: BufferGeometry;
  foliage: BufferGeometry;
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
  /** Far-LOD stand-in. Default: a cone or round crown derived from variant 0's bounds. */
  impostor?(): TreeParts | Promise<TreeParts>;
}
