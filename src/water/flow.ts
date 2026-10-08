import { mercatorX, mercatorY } from '../core/mercator';

/** A line segment in mercator, in flow direction. */
export type Segment = [x0: number, y0: number, x1: number, y1: number];

export interface FlowFeature {
  geometry: { type: string; coordinates: unknown };
  properties?: Record<string, unknown> | null;
}

const FLOW_KINDS = new Set(['river', 'canal']);

/** Segments of river and canal lines (OSM draws them downstream). */
export function segmentsOf(features: FlowFeature[]): Segment[] {
  const out: Segment[] = [];
  for (const f of features) {
    if (!FLOW_KINDS.has(String(f.properties?.kind ?? ''))) continue;
    const g = f.geometry;
    const lines =
      g.type === 'LineString'
        ? [g.coordinates as number[][]]
        : g.type === 'MultiLineString'
          ? (g.coordinates as number[][][])
          : [];
    for (const l of lines)
      for (let i = 0; i + 1 < l.length; i++) {
        const [a, b] = [l[i]!, l[i + 1]!];
        out.push([mercatorX(a[0]!), mercatorY(a[1]!), mercatorX(b[0]!), mercatorY(b[1]!)]);
      }
  }
  return out;
}

/** Nearest-segment lookup on a grid of `radius`-sized cells. */
export class FlowIndex {
  private readonly cells = new Map<string, number[]>();

  constructor(
    private readonly segments: Segment[],
    private readonly radius: number,
  ) {
    segments.forEach(([x0, y0, x1, y1], i) => {
      for (let cx = this.cell(Math.min(x0, x1)); cx <= this.cell(Math.max(x0, x1)); cx++)
        for (let cy = this.cell(Math.min(y0, y1)); cy <= this.cell(Math.max(y0, y1)); cy++) {
          const key = `${cx},${cy}`;
          let list = this.cells.get(key);
          if (!list) this.cells.set(key, (list = []));
          list.push(i);
        }
    });
  }

  /** Unit flow direction (x east, z south) of the nearest segment within the radius, else [0, 0]. */
  at(x: number, y: number): [number, number] {
    let best = Infinity;
    let dir: [number, number] = [0, 0];
    const [cx, cy] = [this.cell(x), this.cell(y)];
    for (let i = cx - 1; i <= cx + 1; i++)
      for (let j = cy - 1; j <= cy + 1; j++)
        for (const s of this.cells.get(`${i},${j}`) ?? []) {
          const [x0, y0, x1, y1] = this.segments[s]!;
          const [dx, dy] = [x1 - x0, y1 - y0];
          const l2 = dx * dx + dy * dy;
          if (l2 === 0) continue;
          const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / l2));
          const d = Math.hypot(x0 + t * dx - x, y0 + t * dy - y);
          if (d <= this.radius && d < best) {
            best = d;
            const l = Math.sqrt(l2);
            dir = [dx / l, dy / l];
          }
        }
    return dir;
  }

  private cell(v: number): number {
    return Math.floor(v / this.radius);
  }
}
