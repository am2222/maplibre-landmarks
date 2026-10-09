import type { LngLat } from '../core/types';

/** A pylon or pole as mapped (heights are optional in the data). */
export interface Support {
  lngLat: LngLat;
  kind: 'tower' | 'pole';
  /** Metres, when tagged. */
  height?: number;
}

/** One tile's piece of a power line (lines are cut at tile edges, past them by the buffer). */
export interface LinePiece {
  /** The line's id: the same in every tile it crosses. */
  id: string;
  kind: 'line' | 'minor_line';
  coords: LngLat[];
}

export interface PlacedSupport extends Required<Support> {
  /** Compass bearing of the line through it (its arms are across it). */
  bearing: number;
}

export interface Network {
  supports: PlacedSupport[];
  /** Index pairs into `supports`: a span of wires between two supports. */
  spans: [number, number][];
}

/** Default heights where none is tagged: transmission pylons, distribution poles. */
export const DEFAULT_HEIGHT = { tower: 30, pole: 10 } as const;
/** A support this close to a line (metres) carries it. */
const SNAP_M = 5;
/** Cut spans are joined to a tower within this angle of the line's heading past the cut. */
const JOIN_DEG = 2;
const JOIN_MAX_M = 2000;

const M_PER_DEG = 111_320;

/**
 * Power lines as spans between their supports. Tiles simplify line geometry (towers on a
 * straight run vanish from it) but keep the tower points, so supports come from the points,
 * ordered along each line; a line with no mapped supports hangs from its own vertices. A span
 * cut by a tile edge (spans are longer than the tile buffer) is joined to the first tower of
 * the same line straight ahead in the next tile.
 */
export function buildNetwork(
  pieces: LinePiece[],
  mapped: Support[],
  /** Water: a line without mapped supports gets no pole where its vertex is in water. */
  inWater: (lngLat: LngLat) => boolean = () => false,
): Network {
  const origin = pieces[0]?.coords[0] ?? mapped[0]?.lngLat;
  if (!origin) return { supports: [], spans: [] };
  const kx = M_PER_DEG * Math.cos((origin[1] * Math.PI) / 180);
  const xy = ([lng, lat]: LngLat): [number, number] => [
    (lng - origin[0]) * kx,
    (lat - origin[1]) * M_PER_DEG,
  ];

  const supports: (Support & { dir?: [number, number] })[] = [];
  const index = new Map<string, number>();
  const add = (s: Support): number => {
    const key = `${s.lngLat[0].toFixed(6)},${s.lngLat[1].toFixed(6)}`;
    let i = index.get(key);
    if (i === undefined) index.set(key, (i = supports.push({ ...s }) - 1));
    else if (s.height !== undefined) supports[i]!.height ??= s.height;
    return i;
  };
  for (const s of mapped) add(s);
  const points = supports.map((s) => xy(s.lngLat));

  const spans = new Map<string, [number, number]>();
  const span = (i: number, j: number) => {
    if (i !== j) spans.set(i < j ? `${i}-${j}` : `${j}-${i}`, [i, j]);
  };
  /** Per piece: its supports in order, and where the line goes past the last one. */
  const runs: { id: string; order: number[]; end: [number, number] }[] = [];

  for (const piece of pieces) {
    const line = piece.coords.map(xy);
    if (line.length < 2) continue;
    // Distance along the line of every support near it.
    const along: [number, number][] = [];
    let start = 0;
    for (let k = 0; k + 1 < line.length; k++) {
      const [a, b] = [line[k]!, line[k + 1]!];
      const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
      const len = Math.hypot(dx, dy);
      if (len > 0)
        points.forEach(([px, py], i) => {
          const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / len ** 2));
          if (Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy)) > SNAP_M) return;
          along.push([start + t * len, i]);
          supports[i]!.dir ??= [dx / len, dy / len];
        });
      start += len;
    }
    let order = [...new Map(along.sort((p, q) => p[0] - q[0]).map(([, i]) => [i, i])).keys()];
    if (!order.length) {
      // No mapped supports: hang the line from its own vertices.
      const kind = piece.kind === 'minor_line' ? 'pole' : 'tower';
      const dry = piece.coords.map((c, k) => [c, k] as const).filter(([c]) => !inWater(c));
      order = dry.map(([c, k]) => {
        const i = add({ lngLat: c, kind });
        const [a, b] = [line[Math.max(0, k - 1)]!, line[Math.min(line.length - 1, k + 1)]!];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        supports[i]!.dir ??= [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
        points[i] = line[k]!;
        return i;
      });
    }
    if (!order.length) continue; // all of it over water
    for (let k = 0; k + 1 < order.length; k++) span(order[k]!, order[k + 1]!);
    runs.push({ id: piece.id, order, end: line.at(-1)! });
  }

  // Spans cut by a tile edge: past its last support the line heads straight for the next one.
  for (const run of runs) {
    const last = run.order.at(-1)!;
    const t = points[last]!;
    const ahead = [run.end[0] - t[0], run.end[1] - t[1]];
    const reach = Math.hypot(ahead[0]!, ahead[1]!);
    if (reach < 1) continue; // the line ends at this support
    let best: number | undefined;
    let bestDistance = JOIN_MAX_M;
    for (const other of runs) {
      if (other === run || other.id !== run.id) continue;
      const first = other.order[0]!;
      const [dx, dy] = [points[first]![0] - t[0], points[first]![1] - t[1]];
      const distance = Math.hypot(dx, dy);
      if (first === last || distance <= reach || distance > bestDistance) continue;
      const cos = (dx * ahead[0]! + dy * ahead[1]!) / (distance * reach);
      if (cos < Math.cos((JOIN_DEG * Math.PI) / 180)) continue;
      best = first;
      bestDistance = distance;
    }
    if (best !== undefined) span(last, best);
  }

  return {
    supports: supports.map(({ lngLat, kind, height, dir }) => ({
      lngLat,
      kind,
      height: height ?? DEFAULT_HEIGHT[kind],
      bearing: dir ? ((Math.atan2(dir[0], dir[1]) * 180) / Math.PI + 360) % 360 : 0,
    })),
    spans: [...spans.values()],
  };
}
