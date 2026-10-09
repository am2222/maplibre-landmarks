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

/** Distance in metres from `center` (equirectangular at the centre's latitude). */
export function distanceFrom(center: [number, number]): (lngLat: [number, number]) => number {
  const kx = METRES_PER_DEG * Math.cos((center[1] * Math.PI) / 180);
  return ([lng, lat]) => Math.hypot((lng - center[0]) * kx, (lat - center[1]) * METRES_PER_DEG);
}

/**
 * Share of scattered trees kept at `distanceM` from the view centre: all of them up to `fromM`,
 * then falling as (fromM / d)², which keeps their on-screen density roughly even in a pitched view.
 * The tree budget then reaches several times farther in dense forest instead of ending in a bare
 * edge a few hundred metres out.
 */
export function distanceKeep(distanceM: number, fromM: number): number {
  return distanceM <= fromM ? 1 : (fromM / distanceM) ** 2;
}

/** The k-th smallest value (1-based), by quickselect on a copy: O(n) on average. */
export function kthSmallest(values: ArrayLike<number>, k: number): number {
  const a = Float64Array.from(values);
  let lo = 0;
  let hi = a.length - 1;
  const target = k - 1;
  while (lo < hi) {
    const pivot = a[(lo + hi) >> 1]!;
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (a[i]! < pivot) i++;
      while (a[j]! > pivot) j--;
      if (i <= j) {
        const t = a[i]!;
        a[i++] = a[j]!;
        a[j--] = t;
      }
    }
    if (target <= j) hi = j;
    else if (target >= i) lo = i;
    else break;
  }
  return a[target]!;
}

/** Nearest `maxTrees` to `center`; far beyond `lodDistanceM`; look derived from the key only. */
export function selectTrees(
  candidates: Candidate[],
  center: [number, number],
  opts: { maxTrees: number; lodDistanceM: number; weights: number[]; variants: number[] },
): PlacedTree[] {
  const distance = distanceFrom(center);
  const d = candidates.map((c) => distance(c.lngLat));
  // Only the nearest maxTrees matter: cut at the maxTrees-th distance before sorting (ties at
  // the cut are kept, then ordered by key like the full sort).
  const cut =
    candidates.length > opts.maxTrees ? kthSmallest(d, opts.maxTrees) : Number.POSITIVE_INFINITY;
  const near: { c: Candidate; d: number }[] = [];
  candidates.forEach((c, i) => {
    if (d[i]! <= cut) near.push({ c, d: d[i]! });
  });
  return near
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
