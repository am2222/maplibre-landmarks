import { DEFAULT_ROOF_COLOR, materialColor, parseColor } from './colors';

export type FieldName =
  | 'height'
  | 'min_height'
  | 'roof_shape'
  | 'roof_height'
  | 'roof_angle'
  | 'roof_direction'
  | 'roof_orientation'
  | 'roof_color'
  | 'roof_material'
  | 'facade_color'
  | 'facade_material'
  | 'has_parts'
  | 'num_floors'
  | 'min_floor';
export type Fields = Record<FieldName, string>;

export const DEFAULT_FIELDS: Fields = {
  height: 'height',
  min_height: 'min_height',
  roof_shape: 'roof_shape',
  roof_height: 'roof_height',
  roof_angle: 'roof_angle',
  roof_direction: 'roof_direction',
  roof_orientation: 'roof_orientation',
  roof_color: 'roof_color',
  roof_material: 'roof_material',
  facade_color: 'facade_color',
  facade_material: 'facade_material',
  has_parts: 'has_parts',
  num_floors: 'num_floors',
  min_floor: 'min_floor',
};

/** Storey height used when a building has floor counts but no height (metres). */
export const FLOOR_M = 3;

export const resolveFields = (over: Partial<Fields> = {}): Fields => ({
  ...DEFAULT_FIELDS,
  ...over,
});

export type ProfileShape =
  | 'gabled'
  | 'saltbox'
  | 'hipped'
  | 'half_hipped'
  | 'side_hipped'
  | 'side_half_hipped'
  | 'hipped_and_gabled'
  | 'gambrel'
  | 'mansard'
  | 'skillion'
  | 'round'
  | 'bellcast_gable'
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
  'side_hipped',
  'side_half_hipped',
  'hipped_and_gabled',
  'gambrel',
  'mansard',
  'skillion',
  'round',
  'bellcast_gable',
  'butterfly',
  'crosspitched',
  'sawtooth',
];
const SHAPES = new Set<string>([...PROFILE_SHAPES, 'pyramidal', 'cone', 'dome', 'onion']);
const ALIASES: Record<string, RoofShape> = {
  double_saltbox: 'mansard',
  quadruple_saltbox: 'mansard',
  gabled_height_moved: 'saltbox',
  gabled_irregular: 'saltbox',
  pitched: 'gabled',
  lean_to: 'skillion',
  monopitch: 'skillion',
  shed: 'skillion',
  pyramid: 'pyramidal',
  // Overture's name for a dome.
  spherical: 'dome',
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
  /** Pitch of the roof faces in degrees (0–90 exclusive), if tagged; `roofHeight` wins. */
  roofAngle?: number;
  /** Bearing the roof faces, degrees clockwise from north. */
  direction?: number;
  /**
   * How far the direction may turn to line up with a wall, from how precisely it was tagged:
   * 45° for compass letters, 10° for whole degrees, 0.5° for decimals (as OSM2World does).
   */
  directionSnap?: number;
  orientation?: 'along' | 'across';
  roofColor: string;
  wallColor: string;
}

const num = (v: unknown): number | undefined => {
  // OSM sometimes writes decimals with a comma ("3,5").
  const n =
    typeof v === 'string' && v.trim() !== ''
      ? Number(v.trim().replace(/^(-?\d+),(\d+)$/, '$1.$2'))
      : v;
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

function direction(v: unknown): { deg: number; snap: number } | undefined {
  const n = num(v);
  if (n !== undefined) return { deg: n, snap: Number.isInteger(n) ? 10 : 0.5 };
  const i = typeof v === 'string' ? COMPASS.indexOf(v.trim().toUpperCase()) : -1;
  return i >= 0 ? { deg: i * 22.5, snap: 45 } : undefined;
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
  const roofHeight = num(p[fields.roof_height]);
  // Without heights, floor counts: walls of FLOOR_M a floor, a tagged roof on top.
  const floors = num(p[fields.num_floors]);
  const height =
    num(p[fields.height]) ??
    (floors !== undefined && floors > 0
      ? floors * FLOOR_M + (roofHeight !== undefined && roofHeight > 0 ? roofHeight : 0)
      : undefined);
  const minFloor = num(p[fields.min_floor]);
  const minHeight = num(p[fields.min_height]) ?? (minFloor !== undefined ? minFloor * FLOOR_M : 0);
  if (height === undefined || !(height > minHeight)) return null;
  const roofAngle = num(p[fields.roof_angle]);
  const orientation = String(p[fields.roof_orientation] ?? '').toLowerCase();
  return {
    shape,
    height,
    minHeight,
    roofHeight: roofHeight !== undefined && roofHeight > 0 ? roofHeight : undefined,
    roofAngle: roofAngle !== undefined && roofAngle > 0 && roofAngle < 90 ? roofAngle : undefined,
    ...((d) => (d ? { direction: d.deg, directionSnap: d.snap } : { direction: undefined }))(
      direction(p[fields.roof_direction]),
    ),
    orientation: orientation === 'along' || orientation === 'across' ? orientation : undefined,
    roofColor:
      parseColor(p[fields.roof_color]) ??
      materialColor(p[fields.roof_material]) ??
      DEFAULT_ROOF_COLOR,
    wallColor:
      parseColor(p[fields.facade_color]) ?? materialColor(p[fields.facade_material]) ?? gableColor,
  };
}

/**
 * `fill-extrusion-height` for walls under roofs: the tagged height, else floors (`FLOOR_M` each)
 * plus a tagged roof, else `fallback` metres. The same heights `readRoofProps` uses, so roofs
 * sit on their walls.
 */
export function buildingHeight(fields: Fields = DEFAULT_FIELDS, fallback = 10): unknown[] {
  const floors = ['to-number', ['get', fields.num_floors], 0];
  return [
    'case',
    ['has', fields.height],
    ['to-number', ['get', fields.height], fallback],
    ['>', floors, 0],
    ['+', ['*', floors, FLOOR_M], ['max', 0, ['to-number', ['get', fields.roof_height], 0]]],
    fallback,
  ];
}

/** `fill-extrusion-base` to match `buildingHeight`: the tagged base, else `min_floor` floors. */
export function buildingBase(fields: Fields = DEFAULT_FIELDS): unknown[] {
  return [
    'case',
    ['has', fields.min_height],
    ['to-number', ['get', fields.min_height], 0],
    ['*', ['to-number', ['get', fields.min_floor], 0], FLOOR_M],
  ];
}
