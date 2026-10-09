import type { LngLat } from '../core/types';

const M_PER_DEG = 111_320;

type Bbox = [number, number, number, number];

function bboxOf(polygons: number[][][][]): Bbox {
  const b: Bbox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const rings of polygons)
    for (const [x, y] of rings[0] ?? []) {
      b[0] = Math.min(b[0], x!);
      b[1] = Math.min(b[1], y!);
      b[2] = Math.max(b[2], x!);
      b[3] = Math.max(b[3], y!);
    }
  return b;
}

/**
 * Vertices of `others` lying on `target`'s outline (within `toleranceM`): where other parts are
 * attached to it, e.g. to tell which end of a side-hipped roof stays gabled.
 */
export function contactPoints(
  target: number[][][][],
  others: number[][][][][],
  toleranceM = 0.75,
): LngLat[] {
  const box = bboxOf(target);
  const lat = (box[1] + box[3]) / 2;
  const kx = M_PER_DEG * Math.cos((lat * Math.PI) / 180);
  const pad = toleranceM / M_PER_DEG / Math.cos((lat * Math.PI) / 180);
  const near = (b: Bbox) =>
    b[0] <= box[2] + pad && box[0] - pad <= b[2] && b[1] <= box[3] + pad && box[1] - pad <= b[3];
  const edges: [number, number, number, number][] = [];
  for (const rings of target)
    for (const ring of rings)
      for (let i = 0; i + 1 < ring.length; i++)
        edges.push([ring[i]![0]!, ring[i]![1]!, ring[i + 1]![0]!, ring[i + 1]![1]!]);
  /** Ground distance from a point to the outline, metres. */
  const distance = ([x, y]: number[]) => {
    let best = Infinity;
    for (const [x0, y0, x1, y1] of edges) {
      const [ax, ay, bx, by, px, py] = [
        x0 * kx,
        y0 * M_PER_DEG,
        x1 * kx,
        y1 * M_PER_DEG,
        x! * kx,
        y! * M_PER_DEG,
      ];
      const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
      const t = len2
        ? Math.min(1, Math.max(0, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / len2))
        : 0;
      best = Math.min(best, Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay))));
    }
    return best;
  };
  const out: LngLat[] = [];
  for (const polygons of others) {
    if (!near(bboxOf(polygons))) continue;
    for (const rings of polygons)
      for (const p of (rings[0] ?? []).slice(0, -1))
        // closed ring: skip the repeated end
        if (distance(p) <= toleranceM) out.push([p[0]!, p[1]!]);
  }
  return out;
}
