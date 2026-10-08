import { Color } from 'three';
import type { Theme } from '../core/theme';

export type WaterStyle = 'sea' | 'lake' | 'river' | 'pool';
/** Shader index order (`aStyle`). */
export const WATER_STYLES: WaterStyle[] = ['sea', 'lake', 'river', 'pool'];

export interface WaveParams {
  /** Main wavelength, metres. */
  scale: number;
  /** Wave steepness multiplier. */
  amplitude: number;
  /** Time scale of the waves (and of the river flow). */
  speed: number;
  /** Sun glint exponent. */
  shininess: number;
}

export const WAVES: Record<WaterStyle, WaveParams> = {
  sea: { scale: 40, amplitude: 1, speed: 1, shininess: 120 },
  lake: { scale: 12, amplitude: 0.45, speed: 0.6, shininess: 200 },
  river: { scale: 8, amplitude: 0.6, speed: 1, shininess: 160 },
  pool: { scale: 1.5, amplitude: 0.25, speed: 0.5, shininess: 300 },
};

type Pair = { shallow: string; deep: string };

/** Shallow (shore) and deep colours per theme, sRGB. */
export const WATER_COLORS: Record<Theme, Record<WaterStyle, Pair>> = {
  day: {
    sea: { shallow: '#5fa8c8', deep: '#1d4f73' },
    lake: { shallow: '#6aa9b8', deep: '#2a5d6e' },
    river: { shallow: '#7aa9a8', deep: '#3b6670' },
    pool: { shallow: '#7fe3f0', deep: '#2fb3d0' },
  },
  dawn: {
    sea: { shallow: '#8aa6b8', deep: '#3a4f6a' },
    lake: { shallow: '#93a9b0', deep: '#44586a' },
    river: { shallow: '#9aaba5', deep: '#4f6268' },
    pool: { shallow: '#9fe0e8', deep: '#4fb0c8' },
  },
  dusk: {
    sea: { shallow: '#4a5f86', deep: '#1f2a4a' },
    lake: { shallow: '#55688a', deep: '#263354' },
    river: { shallow: '#5f6f88', deep: '#2e3a52' },
    pool: { shallow: '#6fb8d0', deep: '#2f7a9a' },
  },
  night: {
    sea: { shallow: '#2c3d5c', deep: '#0d1626' },
    lake: { shallow: '#34455f', deep: '#111b2c' },
    river: { shallow: '#3a4a60', deep: '#152030' },
    pool: { shallow: '#4f9fc0', deep: '#1d5a78' },
  },
};

/** Style of a water feature (Protomaps `water` layer), or null for lines and points. */
export function waterStyle(properties: Record<string, unknown>, type: string): WaterStyle | null {
  if (type !== 'Polygon' && type !== 'MultiPolygon') return null;
  const kind = String(properties.kind ?? '');
  const detail = String(properties.kind_detail ?? '');
  if (kind === 'ocean') return 'sea';
  if (kind === 'swimming_pool' || kind === 'fountain' || detail === 'basin') return 'pool';
  if (detail === 'river' || detail === 'canal') return 'river';
  return 'lake';
}

/** Theme colours; an override sets a style's shallow colour and derives its deep colour. */
export function waterColors(
  theme: Theme,
  overrides: Partial<Record<WaterStyle, string>> = {},
): Record<WaterStyle, Pair> {
  const out = { ...WATER_COLORS[theme] };
  for (const s of Object.keys(overrides) as WaterStyle[]) {
    const shallow = overrides[s]!;
    out[s] = { shallow, deep: `#${new Color(shallow).multiplyScalar(0.35).getHexString()}` };
  }
  return out;
}
