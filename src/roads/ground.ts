import type { LngLat } from '../core/types';
import { metres, type Raised, type Taken } from './network';
import { cut, defaultWidth, lengthsOf, type SegmentPiece, type Span } from './segments';

/** Where roads meet on the ground: a patch over their overlap, and no markings across it. */
export interface Junction {
  at: LngLat;
  /** Half the widest road meeting here, metres. */
  radius: number;
  /** The highest rank meeting here (the patch lies over all of them). */
  rank: number;
}

/** Drawing order on the ground: bigger roads lie over smaller ones where they overlap. */
const RANK: Record<string, number> = {
  motorway: 5,
  trunk: 5,
  primary: 4,
  secondary: 3,
  tertiary: 2,
  residential: 1,
  unclassified: 1,
  living_street: 1,
};

export const rankOf = (s: Pick<Span, 'kind' | 'cls'>): number =>
  s.kind === 'rail' ? 1 : (RANK[s.cls] ?? 0);

/**
 * The ground stretches still on the ground: less what approaches to bridges and cuttings down to
 * tunnels take from their start or end. A stretch taken whole is left out.
 */
export function groundLeft(ground: Span[], takenBy: Taken[]): Span[] {
  const taken = new Map<string, { start: number; end: number }>();
  for (const t of takenBy) {
    const cut = taken.get(t.key) ?? { start: 0, end: 0 };
    if (t.fromStart) cut.start = Math.max(cut.start, t.length);
    else cut.end = Math.max(cut.end, t.length);
    taken.set(t.key, cut);
  }
  return ground.flatMap((g) => {
    const t = taken.get(g.key);
    if (!t) return [g];
    const lengths = lengthsOf(g.coords);
    const total = lengths.at(-1)!;
    if (t.start + t.end >= total - 0.5) return [];
    return [{ ...g, coords: cut(g.coords, lengths, t.start, total - t.end) }];
  });
}

/**
 * Junctions: connectors where roads meet from three or more directions (a segment ending there
 * counts once, one passing through twice). Segments are those given; `connectorAt` places them.
 * Junctions on raised roads are left out (they are not on the ground).
 */
export function junctionsOf(
  segments: SegmentPiece[],
  connectorAt: (id: string) => LngLat | undefined,
  raised: Raised[],
): Junction[] {
  const meeting = new Map<string, { degree: number; radius: number; rank: number }>();
  for (const s of segments) {
    const half = (s.widths[0]?.value ?? defaultWidth(s.kind, s.cls)) / 2;
    for (const c of s.connectors) {
      const m = meeting.get(c.id) ?? { degree: 0, radius: 0, rank: 0 };
      m.degree += c.at <= 1e-6 || c.at >= 1 - 1e-6 ? 1 : 2;
      m.radius = Math.max(m.radius, half);
      m.rank = Math.max(m.rank, rankOf(s));
      meeting.set(c.id, m);
    }
  }
  const out: Junction[] = [];
  for (const [id, m] of meeting) {
    if (m.degree < 3) continue;
    const at = connectorAt(id);
    if (!at) continue;
    if (raised.some((r) => onLine(at, r.coords, Math.max(...r.widths) / 2))) continue;
    out.push({ at, radius: m.radius, rank: m.rank });
  }
  return out;
}

/** Whether `p` is within `d` metres of a line. */
function onLine(p: LngLat, line: LngLat[], d: number): boolean {
  const m = metres(p);
  const toXY = ([lng, lat]: LngLat): [number, number] => [
    (lng - p[0]) * m.kx,
    (lat - p[1]) * 111_320,
  ];
  const xy = line.map(toXY);
  for (let i = 0; i + 1 < xy.length; i++) {
    const [a, b] = [xy[i]!, xy[i + 1]!];
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, (-a[0] * dx - a[1] * dy) / len2)) : 0;
    if (Math.hypot(a[0] + dx * t, a[1] + dy * t) <= d) return true;
  }
  return false;
}
