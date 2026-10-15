// OSM2World's building height rules (LevelAndHeightData, BuildingDefaults, Roof in
// tordanik/OSM2World), restated so the inspector can predict what it builds from OSM tags.

export type Tags = Record<string, string>;

/** OSM2World's metres per level (BuildingDefaults; 10 for chimneys). */
export const O2W_LEVEL_M = 2.5;
/** OSM2World's roof height when nothing gives one (BuildingPart.DEFAULT_RIDGE_HEIGHT). */
export const O2W_RIDGE_M = 5;

/** OSM measure: "12", "12.5 m", "3,5", "30'", "10'6\"" → metres. */
export function measure(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const s = v.trim();
  const ft = /^(\d+(?:\.\d+)?)'(?:\s*(\d+(?:\.\d+)?)")?$/.exec(s);
  if (ft) return Number(ft[1]) * 0.3048 + Number(ft[2] ?? 0) * 0.0254;
  const m = /^(-?\d+(?:[.,]\d+)?)\s*(m|ft|feet)?$/.exec(s);
  if (!m) return undefined;
  const n = Number(m[1]!.replace(',', '.'));
  return m[2] === 'ft' || m[2] === 'feet' ? n * 0.3048 : n;
}

const int = (v: string | undefined) =>
  v !== undefined && /^-?\d+$/.test(v.trim()) ? Number(v) : undefined;

function defaults(tags: Tags): {
  levels: number;
  perLevel: number;
  roofShape: string;
  hasWalls: boolean;
} {
  const type =
    tags.building !== undefined && tags.building !== 'yes'
      ? tags.building
      : (tags['building:part'] ?? '');
  let levels = 3;
  let perLevel = O2W_LEVEL_M;
  let roofShape = 'flat';
  const hasWalls = type !== 'carport' && type !== 'roof';
  if (['greenhouse', 'garage', 'garages', 'carport', 'hut', 'shed', 'cabin', 'roof'].includes(type))
    levels = 1;
  if (tags.parking === 'multi-storey') levels = 5;
  if (tags.man_made === 'chimney' || type === 'chimney') {
    roofShape = 'chimney';
    levels = 1;
    perLevel = 10;
  }
  return { levels, perLevel, roofShape, hasWalls };
}

export interface O2WHeights {
  levels: number;
  roofShape: string;
  roofHeight: number;
  /** Top including the roof, metres above ground. */
  height: number;
  /** Top of the walls. */
  wallTop: number;
  minHeight: number;
  /** Which rule gave the roof height. */
  roofRule: string;
  /** Which rule gave the height. */
  heightRule: string;
}

/**
 * The heights OSM2World gives a building (part) with these tags. A part with none of
 * building:levels, roof:levels and height takes its building's tags (`parent`).
 * `diameter`: the largest distance across the outline (dome roofs), metres.
 */
export function o2wHeights(own: Tags, parent: Tags | undefined, diameter: number): O2WHeights {
  const inherit = !['building:levels', 'roof:levels', 'height'].some((k) => k in own);
  const tags = inherit && parent ? { ...parent, ...own } : own;
  const d = defaults(parent ? { ...parent, ...own } : own);
  const roofShape = tags['roof:shape'] ?? d.roofShape;
  const tagged =
    measure(tags.height) ?? measure(tags['building:height']) ?? measure(tags.est_height);
  const taggedRoof = measure(tags['roof:height']);
  const minLevel = int(tags['building:min_level']) ?? 0;

  let levels: number;
  const parsed = measure(tags['building:levels']);
  if (parsed !== undefined && parsed >= 0) levels = Math.ceil(parsed);
  else if (tagged !== undefined && taggedRoof !== undefined && tagged <= taggedRoof) levels = 0;
  else if (taggedRoof !== undefined && (tagged ?? 0) - taggedRoof > 0)
    levels = Math.max(minLevel + 1, 1, Math.floor(((tagged ?? 0) - taggedRoof) / d.perLevel));
  else if (minLevel > 0) levels = minLevel + 1;
  else levels = d.levels;

  let roofHeight: number | undefined;
  let roofRule = '';
  if (roofShape === 'flat') [roofHeight, roofRule] = [0, 'flat roof'];
  else if (taggedRoof !== undefined) [roofHeight, roofRule] = [taggedRoof, 'roof:height'];
  else if (levels === 0 && (tagged ?? 0) > 0)
    [roofHeight, roofRule] = [tagged!, 'only roof levels: height'];
  if (roofHeight === undefined && int(tags['roof:levels']) !== undefined)
    [roofHeight, roofRule] = [
      d.perLevel * int(tags['roof:levels'])!,
      `roof:levels × ${d.perLevel} m`,
    ];
  if (roofHeight === undefined) {
    if (roofShape === 'dome') [roofHeight, roofRule] = [diameter / 2, 'dome: half the diameter'];
    else if (levels === 1) [roofHeight, roofRule] = [1, 'default, one level: 1 m'];
    else [roofHeight, roofRule] = [O2W_RIDGE_M, `default ridge: ${O2W_RIDGE_M} m`];
  }

  const height = Math.max(tagged ?? levels * d.perLevel + roofHeight, 0.01);
  const heightRule =
    tagged !== undefined ? 'height tag' : `${levels} levels × ${d.perLevel} m + roof`;
  const wallTop = height - roofHeight;
  let minHeight =
    measure(tags.min_height) ??
    (minLevel > 0 ? (wallTop / levels) * minLevel : d.hasWalls ? 0 : wallTop - 0.3);
  if (minHeight > wallTop) minHeight = wallTop - 0.1;
  return { levels, roofShape, roofHeight, height, wallTop, minHeight, roofRule, heightRule };
}
