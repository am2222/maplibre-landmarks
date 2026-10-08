import { EARTH_RADIUS_M } from '../core/mercator';
import { hashValues } from './hash';

export interface Candidate {
  key: string;
  lngLat: [number, number];
}

export interface PlacedTree extends Candidate {
  distanceM: number;
  far: boolean;
  model: number;
  variant: number;
  scale: number;
  rotation: number;
  tint: number;
}

const METRES_PER_DEG = (2 * Math.PI * EARTH_RADIUS_M) / 360;

export function pickModel(weights: number[], u: number): number {
  const total = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (!(total > 0)) return Math.min(weights.length - 1, Math.floor(u * weights.length));
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += Math.max(0, weights[i]!) / total;
    if (u < acc) return i;
  }
  return weights.length - 1;
}

/** Nearest `maxTrees` to `center`; far beyond `lodDistanceM`; look derived from the key only. */
export function selectTrees(
  candidates: Candidate[],
  center: [number, number],
  opts: { maxTrees: number; lodDistanceM: number; weights: number[]; variants: number[] },
): PlacedTree[] {
  const kx = METRES_PER_DEG * Math.cos((center[1] * Math.PI) / 180);
  return candidates
    .map((c) => ({
      c,
      d: Math.hypot((c.lngLat[0] - center[0]) * kx, (c.lngLat[1] - center[1]) * METRES_PER_DEG),
    }))
    .sort((a, b) => a.d - b.d || (a.c.key < b.c.key ? -1 : 1))
    .slice(0, opts.maxTrees)
    .map(({ c, d }) => {
      const [hm, hv, hs, hr, ht] = hashValues(c.key, 5) as [number, number, number, number, number];
      const model = pickModel(opts.weights, hm);
      return {
        key: c.key,
        lngLat: c.lngLat,
        distanceM: d,
        far: d > opts.lodDistanceM,
        model,
        variant: Math.floor(hv * (opts.variants[model] ?? 1)),
        scale: 0.8 + 0.4 * hs,
        rotation: 2 * Math.PI * hr,
        tint: ht,
      };
    });
}
