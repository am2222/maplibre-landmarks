import type { LngLat } from '../core/types';
import type { Span } from './segments';

/** Bridges joined end to end: one deck and one height profile for a bridge mapped in pieces. */
export interface Chain {
  key: string;
  kind: Span['kind'];
  cls: string;
  level: number;
  coords: LngLat[];
  /** Width at each vertex, metres. */
  widths: number[];
}

/**
 * A bridge with the roads that ramp up to it: `coords` runs from the far end of one approach,
 * over the bridge, to the far end of the other. `approaches` are those approaches' lengths, metres
 * (0 where none was found: the bridge then ramps within its own length).
 */
export interface Raised extends Chain {
  approaches: [number, number];
}

const M_PER_DEG = 111_320;
/** Line ends this close (metres) are the same point. */
const JOIN_M = 1.5;
/** An approach continues the bridge within this angle. */
const APPROACH_DEG = 35;

/** Planar metres around an origin (enough for the few kilometres a view holds). */
function metres(o: LngLat) {
  const kx = M_PER_DEG * Math.cos((o[1] * Math.PI) / 180);
  return {
    kx,
    dist: (a: LngLat, b: LngLat) => Math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * M_PER_DEG),
    /** Unit heading from a to b in (east, north) metres. */
    heading: (a: LngLat, b: LngLat): [number, number] => {
      const v: [number, number] = [(b[0] - a[0]) * kx, (b[1] - a[1]) * M_PER_DEG];
      const l = Math.hypot(v[0], v[1]) || 1;
      return [v[0] / l, v[1] / l];
    },
  };
}

interface End {
  line: number;
  first: boolean;
}

/** The ends of a set of lines, found by position. */
class Ends {
  private readonly cells = new Map<string, End[]>();

  constructor(
    private readonly lines: { coords: LngLat[] }[],
    private readonly m: ReturnType<typeof metres>,
    private readonly o: LngLat,
  ) {
    lines.forEach((l, i) => {
      for (const first of [true, false]) {
        const key = this.cell(first ? l.coords[0]! : l.coords.at(-1)!).join();
        this.cells.set(key, [...(this.cells.get(key) ?? []), { line: i, first }]);
      }
    });
  }

  private cell([lng, lat]: LngLat): [number, number] {
    return [
      Math.round(((lng - this.o[0]) * this.m.kx) / JOIN_M),
      Math.round(((lat - this.o[1]) * M_PER_DEG) / JOIN_M),
    ];
  }

  /** Ends within JOIN_M of `p`. */
  at(p: LngLat): End[] {
    const [cx, cy] = this.cell(p);
    const found: End[] = [];
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        found.push(...(this.cells.get(`${cx + dx},${cy + dy}`) ?? []));
    return found.filter((e) => {
      const c = this.lines[e.line]!.coords;
      return this.m.dist(e.first ? c[0]! : c.at(-1)!, p) <= JOIN_M;
    });
  }
}

/**
 * Join bridges of the same kind and level that meet end to end where no other bridge meets them
 * (a junction of three ends its chains). Each chain is drawn as one bridge.
 */
export function chainSpans(spans: Span[]): Chain[] {
  if (!spans.length) return [];
  const o = spans[0]!.coords[0]!;
  const ends = new Ends(spans, metres(o), o);
  const used = new Set<number>();
  /** The one other span continuing `span` at its `first` end, if exactly one does. */
  const next = (span: number, first: boolean) => {
    const s = spans[span]!;
    const here = ends.at(first ? s.coords[0]! : s.coords.at(-1)!).filter((e) => e.line !== span);
    if (here.length !== 1) return undefined;
    const other = spans[here[0]!.line]!;
    return other.kind === s.kind && other.level === s.level && !used.has(here[0]!.line)
      ? here[0]
      : undefined;
  };
  const chains: Chain[] = [];
  spans.forEach((s, i) => {
    if (used.has(i)) return;
    used.add(i);
    let coords = [...s.coords];
    let widths = coords.map(() => s.width);
    const keys = [s.key];
    // Grow forward from the last point, then backward from the first.
    for (const forward of [true, false]) {
      let at: End = { line: i, first: !forward };
      for (let link = next(at.line, at.first); link; link = next(at.line, at.first)) {
        used.add(link.line);
        const o = spans[link.line]!;
        // Join at the end it meets: walk it from there.
        const run = link.first ? o.coords : [...o.coords].reverse();
        const joined = forward ? run : [...run].reverse();
        const w = joined.map(() => o.width);
        if (forward) {
          widths[widths.length - 1] = Math.max(widths.at(-1)!, o.width);
          coords = [...coords, ...joined.slice(1)];
          widths = [...widths, ...w.slice(1)];
        } else {
          widths[0] = Math.max(widths[0]!, o.width);
          coords = [...joined.slice(0, -1), ...coords];
          widths = [...w.slice(0, -1), ...widths];
        }
        keys.push(o.key);
        // Continue from the far end of the span just added.
        at = { line: link.line, first: !link.first };
      }
    }
    chains.push({
      key: keys.sort().join('+'),
      kind: s.kind,
      cls: s.cls,
      level: s.level,
      coords,
      widths,
    });
  });
  return chains;
}

/** The part of a line within `length` metres of its start. */
function head(coords: LngLat[], length: number, m: ReturnType<typeof metres>): LngLat[] {
  const out = [coords[0]!];
  let run = 0;
  for (let i = 1; i < coords.length; i++) {
    const d = m.dist(coords[i - 1]!, coords[i]!);
    if (run + d >= length) {
      const t = d ? (length - run) / d : 0;
      const [a, b] = [coords[i - 1]!, coords[i]!];
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      return out;
    }
    run += d;
    out.push(coords[i]!);
  }
  return out;
}

/**
 * Each bridge with its approaches: from each end, the ground roads of the same kind that carry on
 * from it (the straightest within APPROACH_DEG where several meet the end), followed through
 * simple joins until `rampOf(level)` metres are found or a junction is reached. Underpasses
 * (level below 0) are never approaches; an end where another bridge meets gets none.
 */
export function withApproaches(
  chains: Chain[],
  ground: Span[],
  rampOf: (level: number) => number,
): Raised[] {
  if (!chains.length) return [];
  const o = chains[0]!.coords[0]!;
  const m = metres(o);
  const roads = ground.filter((g) => g.level >= 0);
  const groundEnds = new Ends(roads, m, o);
  const bridgeEnds = new Ends(chains, m, o);
  const cos = Math.cos((APPROACH_DEG * Math.PI) / 180);

  /** Outward from `p`, heading `dir`: the approach's points (p first) and widths. */
  const walk = (chain: Chain, p: LngLat, dir: [number, number], want: number) => {
    const coords: LngLat[] = [p];
    const widths: number[] = [];
    const seen = new Set<number>();
    let here = p;
    let heading = dir;
    while (want > 0) {
      const options = groundEnds
        .at(here)
        .filter((e) => !seen.has(e.line) && roads[e.line]!.kind === chain.kind)
        .map((e) => {
          const line = roads[e.line]!;
          const run = e.first ? line.coords : [...line.coords].reverse();
          const h = m.heading(run[0]!, run[1]!);
          return { e, run, line, along: h[0] * heading[0] + h[1] * heading[1] };
        });
      // Past the bridge's own end, any number may meet (a T at the abutment): the straightest.
      // Further on, only a simple join is followed.
      const pick =
        coords.length === 1
          ? options.filter((x) => x.along >= cos).sort((a, b) => b.along - a.along)[0]
          : options.length === 1 && options[0]!.along >= cos
            ? options[0]
            : undefined;
      if (!pick) break;
      seen.add(pick.e.line);
      const part = head(pick.run, want, m);
      for (let i = 1; i < part.length; i++) {
        want -= m.dist(part[i - 1]!, part[i]!);
        coords.push(part[i]!);
        widths.push(pick.line.width);
      }
      here = coords.at(-1)!;
      if (part.length < pick.run.length || want <= 0) break;
      heading = m.heading(pick.run.at(-2)!, pick.run.at(-1)!);
    }
    return { coords, widths };
  };

  return chains.map((chain) => {
    const want = rampOf(chain.level);
    const ends = [chain.coords[0]!, chain.coords.at(-1)!] as const;
    const dirs = [
      m.heading(chain.coords[1]!, chain.coords[0]!),
      m.heading(chain.coords.at(-2)!, chain.coords.at(-1)!),
    ] as const;
    const [before, after] = ([0, 1] as const).map((k) =>
      // Another bridge carries on here: it ramps down at its own far end.
      bridgeEnds.at(ends[k]).length > 1
        ? { coords: [ends[k]], widths: [] as number[] }
        : walk(chain, ends[k], dirs[k], want),
    ) as [ReturnType<typeof walk>, ReturnType<typeof walk>];
    const length = (c: LngLat[]) => c.slice(1).reduce((s, p, i) => s + m.dist(c[i]!, p), 0);
    return {
      ...chain,
      coords: [
        ...[...before.coords].reverse().slice(0, -1),
        ...chain.coords,
        ...after.coords.slice(1),
      ],
      widths: [...[...before.widths].reverse(), ...chain.widths, ...after.widths],
      approaches: [length(before.coords), length(after.coords)],
    };
  });
}

/**
 * Ground stretches that join two bridges of the same kind, shorter than both ramps between them
 * would need: raised with the bridges (at the higher of their levels), so a road between two close
 * overpasses stays up instead of dipping between two ramps.
 */
export function raiseLinks(
  bridges: Span[],
  ground: Span[],
  rampOf: (level: number) => number,
): { bridges: Span[]; ground: Span[] } {
  if (!bridges.length || !ground.length) return { bridges, ground };
  const o = bridges[0]!.coords[0]!;
  const m = metres(o);
  const ends = new Ends(bridges, m, o);
  const raised: Span[] = [];
  const kept: Span[] = [];
  for (const g of ground) {
    const levelAt = (p: LngLat) =>
      ends
        .at(p)
        .map((e) => bridges[e.line]!)
        .filter((b) => b.kind === g.kind)
        .reduce((l, b) => Math.max(l, b.level), 0);
    const [a, b] = [levelAt(g.coords[0]!), levelAt(g.coords.at(-1)!)];
    const length = g.coords.slice(1).reduce((s, p, i) => s + m.dist(g.coords[i]!, p), 0);
    if (g.level >= 0 && a > 0 && b > 0 && length < rampOf(a) + rampOf(b))
      raised.push({ ...g, level: Math.max(a, b) });
    else kept.push(g);
  }
  return { bridges: [...bridges, ...raised], ground: kept };
}
