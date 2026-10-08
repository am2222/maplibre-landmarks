import type { Map as MlMap } from 'maplibre-gl';
import type { LngLat } from '../core/types';

/** Antiderivative of clamp(t, 0, 1). */
export function rampIntegral(t: number): number {
  if (t <= 0) return 0;
  return t < 1 ? 0.5 * t * t : t - 0.5;
}

/**
 * Mean of clamp(t, 0, 1) as t runs linearly from `ta` to `tb`: how much of a ray segment lies
 * inside the fog's soft top (t = (top − altitude) / soft). The fragment shader mirrors this.
 */
export function fogFill(ta: number, tb: number): number {
  const dt = tb - ta;
  if (Math.abs(dt) > 1e-4) return (rampIntegral(tb) - rampIntegral(ta)) / dt;
  return Math.min(1, Math.max(0, ta));
}

/** Noise cell size in metres for a zoom: a power of two dividing the 4096 m noise period. */
export function noiseCell(zoom: number): number {
  return 2 ** Math.min(10, Math.max(7, Math.round(23 - zoom)));
}

export type FloorMap = Pick<MlMap, 'getCenter' | 'queryTerrainElevation'>;

const M_PER_DEG = (2 * Math.PI * 6371008.8) / 360;

/**
 * Lowest terrain elevation on a grid within `halfSpanM` metres of the map centre (and the centre
 * itself); null if no elevation is known yet. Sampling near the centre, not the whole view: a
 * pitched view reaches lowlands at the horizon that would sink the fog out of sight.
 */
export function valleyFloor(map: FloorMap, halfSpanM: number, grid = 6): number | null {
  const c = map.getCenter();
  const dLat = halfSpanM / M_PER_DEG;
  const dLng = dLat / Math.cos((c.lat * Math.PI) / 180);
  const points: LngLat[] = [[c.lng, c.lat]];
  for (let i = 0; i <= grid; i++) {
    for (let j = 0; j <= grid; j++) {
      points.push([c.lng + dLng * ((2 * i) / grid - 1), c.lat + dLat * ((2 * j) / grid - 1)]);
    }
  }
  let min: number | null = null;
  for (const p of points) {
    const e = map.queryTerrainElevation(p);
    if (typeof e === 'number' && Number.isFinite(e)) min = min === null ? e : Math.min(min, e);
  }
  return min;
}
