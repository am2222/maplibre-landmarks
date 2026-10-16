import type { LngLat } from '../core/types';

/**
 * Roads and railways in Overture's transportation theme: each `segment` carries `road_flags` /
 * `rail_flags`
 * (`is_bridge` over all of it, or over a `between` range of its length), `level_rules` (OSM's
 * layer) and `width_rules`, each optionally per range.
 */

/** A value over a share `[from, to]` of a segment's length (all of it when unranged). */
export interface Rule<T> {
  value: T;
  between: [number, number];
}

/** One tile's piece of a segment (tiles cut lines at their edges, past them by a buffer). */
export interface SegmentPiece {
  id: string;
  kind: 'road' | 'rail';
  /** Overture class: motorway, residential, footway, standard_gauge… */
  cls: string;
  coords: LngLat[];
  /** Where the segment is a bridge: shares of its length. */
  bridges: [number, number][];
  /** Where it runs in a tunnel: shares of its length. */
  tunnels: [number, number][];
  levels: Rule<number>[];
  widths: Rule<number>[];
  /** Its connectors (junctions and ends) and where they are along it, as shares of its length. */
  connectors: { id: string; at: number }[];
  /** Bounds of the tile it came from, `[west, south, east, north]`. */
  tile: [number, number, number, number];
}

/** A stretch of one segment: a bridge, or a part on the ground between bridges. */
export interface Span {
  /** Segment id and range: the same in every tile. */
  key: string;
  kind: 'road' | 'rail';
  cls: string;
  coords: LngLat[];
  /** OSM layer (a bridge's is at least 1). */
  level: number;
  /** Deck width, metres (tagged, else by class). */
  width: number;
}

/** Deck widths by class where none is tagged, metres. */
const CLASS_WIDTH: Record<string, number> = {
  motorway: 12,
  trunk: 11,
  primary: 10,
  secondary: 9,
  tertiary: 8,
  residential: 7,
  unclassified: 7,
  living_street: 6,
  service: 5,
  pedestrian: 5,
  track: 4,
  footway: 3,
  sidewalk: 3,
  cycleway: 3,
  path: 3,
  steps: 3,
  bridleway: 3,
};
const DEFAULT_ROAD_WIDTH = 7;
const RAIL_WIDTH = 6;

/** Width of a road or railway where none is tagged, metres. */
export const defaultWidth = (kind: 'road' | 'rail', cls: string): number =>
  kind === 'rail' ? RAIL_WIDTH : (CLASS_WIDTH[cls] ?? DEFAULT_ROAD_WIDTH);

const parse = (v: unknown): unknown => {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
};

const rangeOf = (r: { between?: unknown }): [number, number] =>
  Array.isArray(r.between) && r.between.length === 2
    ? [Number(r.between[0]), Number(r.between[1])]
    : [0, 1];

/** Ranges whose flags include `flag` (`road_flags` / `rail_flags`). */
export function flagRanges(flags: unknown, flag: string): [number, number][] {
  const list = parse(flags);
  if (!Array.isArray(list)) return [];
  return list
    .filter((r: { values?: unknown }) => Array.isArray(r.values) && r.values.includes(flag))
    .map(rangeOf);
}

/** Numeric `*_rules` (`level_rules`, `width_rules`). */
export function numberRules(rules: unknown): Rule<number>[] {
  const list = parse(rules);
  if (!Array.isArray(list)) return [];
  return list
    .map((r: { value?: unknown; between?: unknown }) => ({
      value: Number(r.value),
      between: rangeOf(r),
    }))
    .filter((r) => Number.isFinite(r.value));
}

/** The rule covering share `t` of the segment (ranged rules win over unranged ones). */
export function ruleAt<T>(rules: Rule<T>[], t: number): T | undefined {
  const covering = rules.filter((r) => r.between[0] <= t && t <= r.between[1]);
  covering.sort((a, b) => a.between[1] - a.between[0] - (b.between[1] - b.between[0]));
  return covering[0]?.value;
}

/** A road or rail segment feature's piece (null for other subtypes). */
export function readPiece(
  properties: Record<string, unknown>,
  coords: LngLat[],
  tile: SegmentPiece['tile'],
  fallbackId: string,
): SegmentPiece | null {
  const subtype = String(properties.subtype ?? '');
  if (subtype !== 'road' && subtype !== 'rail') return null;
  const flags = subtype === 'rail' ? properties.rail_flags : properties.road_flags;
  const bridges = flagRanges(flags, 'is_bridge');
  // A covered bridge is a bridge; a tunnel inside a bridge's range stays a bridge.
  const tunnels = flagRanges(flags, 'is_tunnel');
  if (coords.length < 2) return null;
  return {
    id: String(properties.id ?? fallbackId),
    kind: subtype,
    cls: String(properties.class ?? ''),
    coords,
    bridges,
    tunnels,
    levels: numberRules(properties.level_rules),
    widths: numberRules(properties.width_rules),
    connectors: connectorsOf(properties.connectors),
    tile,
  };
}

/** A segment's `connectors`: ids and shares along it. */
export function connectorsOf(value: unknown): { id: string; at: number }[] {
  const list = parse(value);
  if (!Array.isArray(list)) return [];
  return list
    .map((c: { connector_id?: unknown; at?: unknown }) => ({
      id: String(c.connector_id ?? ''),
      at: Number(c.at),
    }))
    .filter((c) => c.id && Number.isFinite(c.at));
}

// ---- Geometry ---------------------------------------------------------------------------------

const M_PER_DEG = 111_320;
/** Pieces of one line agree to within this (tile quantisation), metres. */
const JOIN_M = 1.5;

type XY = [number, number];

const metres = (o: LngLat) => {
  const kx = M_PER_DEG * Math.cos((o[1] * Math.PI) / 180);
  return ([lng, lat]: LngLat): XY => [(lng - o[0]) * kx, (lat - o[1]) * M_PER_DEG];
};

/** Nearest point of a polyline to `p`: its distance and where it is (segment index, share). */
function nearest(line: XY[], p: XY): { d: number; i: number; t: number } {
  let best = { d: Infinity, i: 0, t: 0 };
  for (let i = 0; i + 1 < line.length; i++) {
    const [a, b] = [line[i]!, line[i + 1]!];
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
    const d = Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1]);
    if (d < best.d) best = { d, i, t };
  }
  return best;
}

const lerp = (a: LngLat, b: LngLat, t: number): LngLat => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
];

/**
 * One line from its tile pieces (each in the line's own direction, overlapping where the tile
 * buffers do). Pieces that do not touch the line grown so far are left out.
 */
export function stitch(pieces: LngLat[][]): LngLat[] {
  const rest = pieces.filter((p) => p.length >= 2);
  if (!rest.length) return [];
  const toXY = metres(rest[0]![0]!);
  rest.sort((a, b) => b.length - a.length);
  let line = rest.shift()!;
  for (let grown = true; grown && rest.length;) {
    grown = false;
    for (let k = 0; k < rest.length; k++) {
      const piece = rest[k]!;
      const xy = piece.map(toXY);
      const end = nearest(xy, toXY(line.at(-1)!));
      const start = nearest(xy, toXY(line[0]!));
      if (end.d > JOIN_M && start.d > JOIN_M) continue;
      // Whatever lies past the line's ends (a piece inside it adds nothing).
      if (end.d <= JOIN_M) line = [...line, ...piece.slice(end.i + 1)];
      if (start.d <= JOIN_M && (start.i > 0 || start.t > 0))
        line = [...piece.slice(0, start.i + 1), ...line];
      rest.splice(k, 1);
      grown = true;
      break;
    }
  }
  return dedupe(line);
}

const dedupe = (line: LngLat[]) =>
  line.filter((p, i) => i === 0 || p[0] !== line[i - 1]![0] || p[1] !== line[i - 1]![1]);

/** Distance along a line at each vertex, metres. */
export function lengthsOf(line: LngLat[]): number[] {
  const xy = line.map(metres(line[0]!));
  const lengths = [0];
  for (let i = 1; i < xy.length; i++)
    lengths.push(
      lengths[i - 1]! + Math.hypot(xy[i]![0] - xy[i - 1]![0], xy[i]![1] - xy[i - 1]![1]),
    );
  return lengths;
}

/** The part of a line between `from` and `to` metres along it. */
export function cut(line: LngLat[], lengths: number[], from: number, to: number): LngLat[] {
  const at = (d: number): LngLat => {
    const i = Math.max(
      1,
      lengths.findIndex((l) => l >= d),
    );
    const seg = lengths[i]! - lengths[i - 1]!;
    return lerp(line[i - 1]!, line[i]!, seg ? (d - lengths[i - 1]!) / seg : 0);
  };
  const inner = line.filter((_, i) => lengths[i]! > from && lengths[i]! < to);
  return dedupe([at(from), ...inner, at(to)]);
}

/** The part of a line between shares `from` and `to` of its length. */
export function slice(line: LngLat[], from: number, to: number): LngLat[] {
  if (line.length < 2) return [];
  const lengths = lengthsOf(line);
  const total = lengths.at(-1)!;
  return cut(line, lengths, from * total, to * total);
}

/** A point of known share `at` of the segment, `s` metres along the stitched line. */
interface Anchor {
  s: number;
  at: number;
}

/**
 * Metres along the stitched line of share `t` of the segment, from the anchors around it (or the
 * nearest two, extrapolated): undefined with fewer than two anchors or off the held line.
 */
function placeShare(t: number, anchors: Anchor[], total: number): number | undefined {
  if (anchors.length < 2) return undefined;
  let i = anchors.findIndex((a) => a.at >= t);
  i = i <= 0 ? 1 : i;
  const [a, b] = [anchors[i - 1]!, anchors[i]!];
  const s = a.s + ((t - a.at) * (b.s - a.s)) / (b.at - a.at);
  return s >= -JOIN_M && s <= total + JOIN_M ? Math.max(0, Math.min(total, s)) : undefined;
}

const inside = ([lng, lat]: LngLat, [w, s, e, n]: SegmentPiece['tile'], marginDeg: number) =>
  lng > w + marginDeg && lng < e - marginDeg && lat > s + marginDeg && lat < n - marginDeg;

/** The shares of a segment outside the given ranges. */
function between(ranges: [number, number][]): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  let at = 0;
  for (const [from, to] of sorted) {
    if (from > at) out.push([at, from]);
    at = Math.max(at, to);
  }
  if (at < 1) out.push([at, 1]);
  return out;
}

/** A segment's parts: on bridges, in tunnels, and on the ground between them. */
export interface Parts {
  bridges: Span[];
  tunnels: Span[];
  ground: Span[];
}

/**
 * One segment's bridges, tunnels and parts on the ground, from its pieces. Stretches over all of the
 * segment are taken from whatever pieces are held. A stretch over part of it is a share of the
 * full length, which the held pieces may not show (tiles cut segments, and MapLibre slices
 * zoomed-in tiles further): it is placed from anchors on the held line whose share is known, the
 * segment's connectors (`connectorAt` finds where each is) and its real ends (inside a tile
 * rather than cut at one's edge); it waits while fewer than two are held, or it lies off the line.
 */
export function partsOf(
  pieces: SegmentPiece[],
  connectorAt: (id: string) => LngLat | undefined = () => undefined,
): Parts {
  const first = pieces[0];
  const parts: Parts = { bridges: [], tunnels: [], ground: [] };
  if (!first) return parts;
  const line = stitch(pieces.map((p) => p.coords));
  if (line.length < 2) return parts;
  const lengths = lengthsOf(line);
  const total = lengths.at(-1)!;
  const margin = 0.5 / M_PER_DEG;
  const realEnd = (p: LngLat) => pieces.some((piece) => inside(p, piece.tile, margin));
  const toXY = metres(line[0]!);
  const xy = line.map(toXY);
  const anchors: Anchor[] = [];
  if (realEnd(line[0]!)) anchors.push({ s: 0, at: 0 });
  if (realEnd(line.at(-1)!)) anchors.push({ s: total, at: 1 });
  for (const c of first.connectors) {
    const p = connectorAt(c.id);
    if (!p) continue;
    const n = nearest(xy, toXY(p));
    if (n.d > JOIN_M) continue;
    anchors.push({ s: lengths[n.i]! + n.t * (lengths[n.i + 1]! - lengths[n.i]!), at: c.at });
  }
  anchors.sort((a, b) => a.at - b.at);
  const known = anchors.filter((a, i) => i === 0 || a.at - anchors[i - 1]!.at > 1e-6);
  const stretch = ([from, to]: [number, number], bridge: boolean): Span | undefined => {
    const all = from <= 0 && to >= 1;
    let coords = line;
    if (!all) {
      const s0 = placeShare(from, known, total);
      const s1 = placeShare(to, known, total);
      if (s0 === undefined || s1 === undefined || s1 - s0 < 0.5) return undefined;
      coords = cut(line, lengths, s0, s1);
    }
    if (coords.length < 2) return undefined;
    const mid = (from + to) / 2;
    const level = ruleAt(first.levels, mid) ?? 0;
    return {
      key: `${first.id}@${from}-${to}`,
      kind: first.kind,
      cls: first.cls,
      coords,
      level: bridge ? Math.max(1, level) : level,
      width: ruleAt(first.widths, mid) ?? defaultWidth(first.kind, first.cls),
    };
  };
  for (const range of first.bridges) {
    const span = stretch(range, true);
    if (span) parts.bridges.push(span);
  }
  // Tunnels outside the bridges (a bridge's range wins where they overlap).
  const tunnels = first.tunnels.flatMap(([from, to]) =>
    between(first.bridges)
      .map(([a, b]): [number, number] => [Math.max(a, from), Math.min(b, to)])
      .filter(([a, b]) => b - a > 1e-6),
  );
  for (const range of tunnels) {
    const span = stretch(range, false);
    if (span) parts.tunnels.push(span);
  }
  for (const range of between([...first.bridges, ...tunnels])) {
    const span = stretch(range, false);
    if (span) parts.ground.push(span);
  }
  return parts;
}
