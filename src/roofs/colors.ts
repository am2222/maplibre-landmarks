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

/**
 * `[material, colour, …]` for a style `match` expression, aliases included; `map` adjusts each
 * colour (walls pass `normalizeFacade`).
 */
export function materialPairs(map: (hex: string) => string = (hex) => hex): string[] {
  return [
    ...Object.entries(MATERIAL_COLORS).flatMap(([m, hex]) => [m, map(hex)]),
    ...Object.entries(MATERIAL_ALIASES).flatMap(([alias, m]) => [alias, map(MATERIAL_COLORS[m]!)]),
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

/** Tagged facade colours keep this share of their saturation (pulled toward their own luma). */
export const FACADE_SATURATION = 0.6;
/** Tagged facade colours are squeezed into this lightness range (sRGB, 0–1). */
export const FACADE_RANGE: readonly [number, number] = [0.3, 0.88];

const LUMA = [0.299, 0.587, 0.114] as const;

/**
 * A tagged facade colour toned down: saturation cut to `FACADE_SATURATION`, then every channel
 * mapped into `FACADE_RANGE`, so no neon or pure black walls. The same sRGB arithmetic as
 * `facadeExpression`, so gable ends match the extruded walls below them.
 */
export function normalizeFacade(hex: string): string {
  const { r, g, b } = new Color(hex).getRGB({ r: 0, g: 0, b: 0 }, SRGBColorSpace);
  const y = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;
  const [lo, hi] = FACADE_RANGE;
  const out = [r, g, b].map((v) => lo + (hi - lo) * (y + FACADE_SATURATION * (v - y)));
  return `#${new Color().setRGB(out[0]!, out[1]!, out[2]!, SRGBColorSpace).getHexString()}`;
}

/** `normalizeFacade` as a style expression over an `rgba` array (channels 0–255). */
export function normalizeFacadeExpression(rgba: unknown): unknown[] {
  const ch = (i: number) => ['at', i, rgba];
  const y = ['+', ...LUMA.map((k, i) => ['*', k, ch(i)])];
  const [lo, hi] = FACADE_RANGE;
  const out = (i: number) => [
    '+',
    255 * lo,
    ['*', hi - lo, ['+', y, ['*', FACADE_SATURATION, ['-', ch(i), y]]]],
  ];
  return ['rgb', out(0), out(1), out(2)];
}
