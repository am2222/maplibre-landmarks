export type Ring = number[][];

/** Even-odd ray cast; `ring` may be open or closed. */
export function pointInRing([x, y]: number[], ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi! > y! !== yj! > y! && x! < ((xj! - xi!) * (y! - yi!)) / (yj! - yi!) + xi!)
      inside = !inside;
  }
  return inside;
}

/** Inside any polygon's outer ring and none of its holes. */
export function pointInPolygons(p: number[], polygons: number[][][][]): boolean {
  return polygons.some(
    ([outer, ...holes]) => pointInRing(p, outer!) && !holes.some((h) => pointInRing(p, h)),
  );
}

/** Polygon / MultiPolygon coordinates as a list of polygons; anything else is empty. */
export function polygonsOf(
  geometry: { type: string; coordinates: unknown } | null | undefined,
): number[][][][] {
  if (geometry?.type === 'Polygon') return [geometry.coordinates as number[][][]];
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates as number[][][][];
  return [];
}
