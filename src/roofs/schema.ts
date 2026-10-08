import { DEFAULT_ROOF_COLOR, materialColor, parseColor } from './colors';

export type FieldName =
  | 'height'
  | 'min_height'
  | 'roof_shape'
  | 'roof_height'
  | 'roof_direction'
  | 'roof_orientation'
  | 'roof_color'
  | 'roof_material'
  | 'facade_color'
  | 'facade_material'
  | 'has_parts';
export type Fields = Record<FieldName, string>;

export const DEFAULT_FIELDS: Fields = {
  height: 'height',
  min_height: 'min_height',
  roof_shape: 'roof_shape',
  roof_height: 'roof_height',
  roof_direction: 'roof_direction',
  roof_orientation: 'roof_orientation',
  roof_color: 'roof_color',
  roof_material: 'roof_material',
  facade_color: 'facade_color',
  facade_material: 'facade_material',
  has_parts: 'has_parts',
};

export const resolveFields = (over: Partial<Fields> = {}): Fields => ({
  ...DEFAULT_FIELDS,
  ...over,
});

export type ProfileShape =
  | 'gabled'
  | 'saltbox'
  | 'hipped'
  | 'half_hipped'
  | 'gambrel'
  | 'mansard'
  | 'skillion'
  | 'round'
  | 'butterfly'
  | 'crosspitched'
  | 'sawtooth';
export type RadialShape = 'pyramidal' | 'cone' | 'dome' | 'onion';
export type RoofShape = ProfileShape | RadialShape;

export const PROFILE_SHAPES: ProfileShape[] = [
  'gabled',
  'saltbox',
  'hipped',
  'half_hipped',
  'gambrel',
  'mansard',
  'skillion',
  'round',
  'butterfly',
  'crosspitched',
  'sawtooth',
];
const SHAPES = new Set<string>([...PROFILE_SHAPES, 'pyramidal', 'cone', 'dome', 'onion']);
const ALIASES: Record<string, RoofShape> = {
  double_saltbox: 'mansard',
  quadruple_saltbox: 'mansard',
  side_hipped: 'hipped',
  side_half_hipped: 'half_hipped',
  hipped_and_gabled: 'hipped',
  gabled_height_moved: 'saltbox',
  bellcast_gable: 'gabled',
  pitched: 'gabled',
  lean_to: 'skillion',
  monopitch: 'skillion',
  shed: 'skillion',
  pyramid: 'pyramidal',
};

/** Every `_` / `-` spelling of `v` (OSM mixes them, e.g. `side_half-hipped`). */
const spellings = (v: string): string[] => {
  const i = v.indexOf('_');
  if (i < 0) return [v];
  const rest = spellings(v.slice(i + 1));
  return ['_', '-'].flatMap((sep) => rest.map((r) => v.slice(0, i) + sep + r));
};

/** Every raw `roof_shape` value that draws a roof (lower case, all `_` / `-` spellings). */
export const ROOF_SHAPE_VALUES: string[] = [...SHAPES, ...Object.keys(ALIASES)].flatMap(spellings);

export function normaliseShape(value: unknown): RoofShape | null {
  if (typeof value !== 'string') return null;
  const s = value.trim().toLowerCase().replaceAll('-', '_');
  if (SHAPES.has(s)) return s as RoofShape;
  return ALIASES[s] ?? null;
}

export interface RoofProps {
  shape: RoofShape;
  /** Top of the building including its roof, metres above ground. */
  height: number;
  minHeight: number;
  /** Explicit roof height (positive), if tagged. */
  roofHeight?: number;
  /** Bearing the roof faces, degrees clockwise from north. */
  direction?: number;
  orientation?: 'along' | 'across';
  roofColor: string;
  wallColor: string;
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};

const COMPASS = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
];

function direction(v: unknown): number | undefined {
  const n = num(v);
  if (n !== undefined) return n;
  const i = typeof v === 'string' ? COMPASS.indexOf(v.trim().toUpperCase()) : -1;
  return i >= 0 ? i * 22.5 : undefined;
}

const truthy = (v: unknown) => v === true || v === 1 || v === 'true' || v === 'yes';

/** The roof described by a feature's properties, or null when it gets no roof. */
export function readRoofProps(
  p: Record<string, unknown>,
  fields: Fields,
  gableColor: string,
): RoofProps | null {
  if (truthy(p[fields.has_parts])) return null;
  const shape = normaliseShape(p[fields.roof_shape]);
  if (!shape) return null;
  const height = num(p[fields.height]);
  const minHeight = num(p[fields.min_height]) ?? 0;
  if (height === undefined || !(height > minHeight)) return null;
  const roofHeight = num(p[fields.roof_height]);
  const orientation = String(p[fields.roof_orientation] ?? '').toLowerCase();
  return {
    shape,
    height,
    minHeight,
    roofHeight: roofHeight !== undefined && roofHeight > 0 ? roofHeight : undefined,
    direction: direction(p[fields.roof_direction]),
    orientation: orientation === 'along' || orientation === 'across' ? orientation : undefined,
    roofColor:
      parseColor(p[fields.roof_color]) ??
      materialColor(p[fields.roof_material]) ??
      DEFAULT_ROOF_COLOR,
    wallColor:
      parseColor(p[fields.facade_color]) ?? materialColor(p[fields.facade_material]) ?? gableColor,
  };
}
