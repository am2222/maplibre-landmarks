import { Color, SRGBColorSpace } from 'three';

export const DEFAULT_ROOF_COLOR = '#b9a99a';

/** Material colours, from OSMBuildings (src/triangulate/index.js, BSD-2-Clause). */
const MATERIAL_COLORS: Record<string, string> = {
  brick: '#cc7755',
  bronze: '#ffeecc',
  canvas: '#fff8f0',
  concrete: '#999999',
  copper: '#a0e0d0',
  glass: '#e8f8f8',
  gold: '#ffcc00',
  plants: '#009933',
  metal: '#aaaaaa',
  panel: '#fff8f0',
  plaster: '#999999',
  roof_tiles: '#f08060',
  silver: '#cccccc',
  slate: '#666666',
  stone: '#996666',
  tar_paper: '#333333',
  wood: '#deb887',
};

const MATERIAL_ALIASES: Record<string, string> = {
  asphalt: 'tar_paper',
  bitumen: 'tar_paper',
  block: 'stone',
  bricks: 'brick',
  glas: 'glass',
  glassfront: 'glass',
  grass: 'plants',
  masonry: 'stone',
  granite: 'stone',
  panels: 'panel',
  paving_stones: 'stone',
  plastered: 'plaster',
  rooftiles: 'roof_tiles',
  roofingfelt: 'tar_paper',
  sandstone: 'stone',
  sheet: 'canvas',
  sheets: 'canvas',
  shingle: 'tar_paper',
  shingles: 'tar_paper',
  slates: 'slate',
  steel: 'metal',
  tar: 'tar_paper',
  tent: 'canvas',
  thatch: 'plants',
  tile: 'roof_tiles',
  tiles: 'roof_tiles',
};

export function materialColor(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined;
  const key = name.trim().toLowerCase();
  return MATERIAL_COLORS[MATERIAL_ALIASES[key] ?? key];
}

/** `[material, colour, …]` for a style `match` expression, aliases included. */
export function materialPairs(): string[] {
  return [
    ...Object.entries(MATERIAL_COLORS).flat(),
    ...Object.entries(MATERIAL_ALIASES).flatMap(([alias, m]) => [alias, MATERIAL_COLORS[m]!]),
  ];
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/;
const FUNCTIONAL = /^(?:rgb|hsl)a?\(/;

/** A CSS colour as lower-case `#rrggbb`, or undefined. */
export function parseColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.trim().toLowerCase();
  if (HEX.test(s)) return s.length === 4 ? `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}` : s;
  const named = (Color.NAMES as Record<string, number>)[s];
  if (named !== undefined) return `#${named.toString(16).padStart(6, '0')}`;
  if (FUNCTIONAL.test(s)) return `#${new Color().setStyle(s).getHexString()}`;
  return undefined;
}

/** Linear RGB (three's working colour space) for vertex colours. */
export function toRGB(hex: string): [number, number, number] {
  const c = new Color(hex);
  return [c.r, c.g, c.b];
}

/** OSM Buildings tones tagged colours down to 70 % of their saturation. */
const ROOF_SATURATION = 0.7;
/** Lightness shifts that keep neighbouring roofs apart (OSM Buildings' colour variance). */
const VARIANCE = [0.06, 0.03, -0.06, -0.03];

/** A building's lightness shift, stable for its feature id. */
export function colorVariance(id: number | string): number {
  let n = typeof id === 'number' ? Math.abs(Math.trunc(id)) : 0;
  if (typeof id === 'string')
    for (let i = 0; i < id.length; i++) n = (n * 31 + id.charCodeAt(i)) >>> 0;
  return VARIANCE[n % VARIANCE.length]!;
}

/** A roof colour as linear RGB: desaturated, with its lightness shifted by `variance`. */
export function roofRGB(hex: string, variance = 0): [number, number, number] {
  const c = new Color(hex);
  const { h, s, l } = c.getHSL({ h: 0, s: 0, l: 0 }, SRGBColorSpace);
  c.setHSL(h, s * ROOF_SATURATION, Math.min(1, Math.max(0, l + variance)), SRGBColorSpace);
  return [c.r, c.g, c.b];
}
