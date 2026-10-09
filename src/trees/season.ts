/**
 * A season name, `'auto'` (from today's date and the map's latitude), or a position in the year:
 * 0 spring, 1 summer, 2 autumn, 3 winter, wrapping back to spring at 4.
 */
export type TreeSeason = 'spring' | 'summer' | 'autumn' | 'winter' | 'auto' | number;

const NAMED: Record<string, number> = { spring: 0, summer: 1, autumn: 2, winter: 3 };

/** Tropical trees don't follow four seasons: 'auto' keeps them in summer. */
const TROPICS_DEG = 23.44;
/** Day of the year (0-based) at each season's peak in the north: about 15 April, July, October, January. */
const SPRING_PEAK_DAY = 104;
const DAYS_PER_YEAR = 365.2425;

export const wrapSeason = (s: number): number => ((s % 4) + 4) % 4;

/** The season at `date` for a place at latitude `lat` (south of the equator, half a year on). */
export function seasonAt(date: Date, lat: number): number {
  if (Math.abs(lat) < TROPICS_DEG) return 1;
  const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 1);
  const day = (date.getTime() - startOfYear) / 86_400_000;
  const north = ((day - SPRING_PEAK_DAY) / DAYS_PER_YEAR) * 4;
  return wrapSeason(lat < 0 ? north + 2 : north);
}

/** A season option as a number in [0, 4), or undefined for 'auto'. */
export function seasonValue(season: TreeSeason): number | undefined {
  if (season === 'auto') return undefined;
  if (typeof season === 'number') return Number.isFinite(season) ? wrapSeason(season) : 1;
  return NAMED[season] ?? 1;
}

/**
 * Seasonal foliage colours for the day theme (sRGB hex). Other themes scale them by the ratio of
 * their foliage colour to the day theme's.
 */
export const SEASON_COLORS = {
  /** Fresh spring leaves, from yellow-green to green by tree. */
  spring: [0x8cc251, 0xa6c95a],
  /** Spring blossom: pink and white. */
  blossom: [0xf4c7d6, 0xf2efe4],
  /** Autumn ramp: each tree picks a point on it. */
  autumn: [0xb23a24, 0xd0612a, 0xe0952f, 0xd8b23c, 0x7f8a3a],
  /** The last withered leaves before a crown is bare. */
  bare: 0x7a5c3a,
  snow: 0xf0f4f8,
} as const;
