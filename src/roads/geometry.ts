import { toRGB } from '../roofs/colors';
import { MeshBuilder, type RGB, type RoofMesh, type Vec3 } from '../roofs/geometry/mesh';
import type { Raised } from './network';

/** Deck top above the ground per OSM layer, metres (clearance plus deck). */
export const LEVEL_M = 6;
/** Steepest a ramp climbs (15 %); a smoothstep's steepest slope is 1.5 × its average. */
const MAX_GRADE = 0.15;
const AVERAGE_GRADE = MAX_GRADE / 1.5;
/** A bridge without approaches ramps within at most this share of its own length at each end. */
const OWN_RAMP_SHARE = 1 / 3;
/** Depth of the deck: a slab with an edge band, over a girder narrower than the road. */
const DECK_M = 1;
const FASCIA_M = 0.35;
const GIRDER_SHARE = 0.65;
/**
 * Approaches lower than this are solid (nothing passes under them); higher, they are an open deck
 * on piers like the bridge, so the roads they cross stay clear.
 */
const SOLID_BELOW_M = 2.5;
/** Ramps start just above the flat road painted under them. */
const RAMP_FOOT_M = 0.1;
/** Spacing of the piers, metres; none where the deck is this close to the ground. */
const PIER_EVERY_M = 30;
/** How far a pier may move along the deck to stand clear of the roads below, metres. */
const PIER_SHIFT_M = 12.5;
const PIER_MIN_CLEARANCE_M = 2;
/** Columns: radius, and a second one under decks wider than this. */
const COLUMN_R = 0.7;
const TWIN_COLUMNS_FROM_M = 12;
/** Markings: line width, edge inset, centre dashes (on, period). */
const LINE_M = 0.15;
const EDGE_INSET_M = 0.45;
const DASH_M = [3, 9] as const;
const MARKED_FROM_M = 6;
/** Profile samples at most this far apart, metres (smooth ramps). */
const STEP_M = 5;

const SURFACE: Record<Raised['kind'] | 'path', RGB> = {
  road: toRGB('#5d6066'),
  rail: toRGB('#6e665c'),
  path: toRGB('#9b958c'),
};
const FASCIA = toRGB('#d2cdc3');
const GIRDER = toRGB('#aea89d');
const PIER = toRGB('#a7a196');
const PAINT = toRGB('#ecebe6');
const STEEL = toRGB('#4a4b4f');
const PATHS = new Set([
  'footway',
  'sidewalk',
  'cycleway',
  'path',
  'steps',
  'bridleway',
  'pedestrian',
]);

export type XZ = [number, number];

/** Ramp length to reach a level, metres. */
export const rampFor = (level: number) => (level * LEVEL_M) / AVERAGE_GRADE;

export interface RaisedInput {
  /** Vertices in local metres (x east, z south): approach, bridge, approach. */
  points: XZ[];
  widths: number[];
  level: number;
  kind: Raised['kind'];
  cls: string;
  /** Lengths of the approaches at the start and the end, metres. */
  approaches: [number, number];
  /** Ground height under a point. */
  ground(p: XZ): number;
  /**
   * Whether a column `radius` metres round at a point would stand on another road or railway
   * (default: never). Piers move along the deck to stand clear.
   */
  blocked?(p: XZ, radius: number): boolean;
}

export interface Profile {
  length: number;
  /** Where the bridge starts and ends along the line, metres. */
  deck: [number, number];
  /** Ramp lengths from each end of the line, metres. */
  ramps: [number, number];
  /** Height reached between the ramps, metres. */
  top: number;
}

/**
 * The height plan of a raised road `length` metres long whose bridge runs over `deck`: ramps over
 * the approaches, carried on into the bridge as far as needed (at most a third of it) where an
 * approach is too short, then level × LEVEL_M across the middle, or less where the ramps would
 * be steeper than MAX_GRADE.
 */
export function profileOf(length: number, deck: [number, number], level: number): Profile {
  const want = rampFor(level);
  const span = deck[1] - deck[0];
  const ramp = (approach: number) =>
    approach + Math.min(Math.max(0, want - approach), span * OWN_RAMP_SHARE);
  const ramps: [number, number] = [ramp(deck[0]), ramp(length - deck[1])];
  return {
    length,
    deck,
    ramps,
    top: Math.min(level * LEVEL_M, ramps[0] * AVERAGE_GRADE, ramps[1] * AVERAGE_GRADE),
  };
}

/** Height above the ground (or the line between the abutments) `s` metres along. */
export function liftAt(p: Profile, s: number): number {
  const smooth = (t: number) => {
    const c = Math.max(0, Math.min(1, t));
    return c * c * (3 - 2 * c);
  };
  const up = Math.min(smooth(s / p.ramps[0]), smooth((p.length - s) / p.ramps[1]));
  return p.top * (Number.isFinite(up) ? up : 0);
}

/** Vertices at most STEP_M apart, with their distance along the line and width. */
function resample(points: XZ[], widths: number[]) {
  const out: { p: XZ; s: number; w: number }[] = [{ p: points[0]!, s: 0, w: widths[0]! }];
  let s = 0;
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1]!, points[i]!];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-6) continue;
    const n = Math.ceil(len / STEP_M);
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      out.push({
        p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
        s: s + len * t,
        w: widths[i - 1]! + (widths[i]! - widths[i - 1]!) * t,
      });
    }
    s += len;
  }
  return { samples: out, length: s };
}

/** Unit vectors to the left of the line at each sample (mitred at the bends, capped). */
function lefts(samples: { p: XZ }[]): XZ[] {
  const dir = (a: XZ, b: XZ): XZ => {
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
  };
  return samples.map((_, i) => {
    const d0 = dir(samples[Math.max(0, i - 1)]!.p, samples[Math.max(1, i)]!.p);
    const d1 = dir(
      samples[Math.min(samples.length - 2, i)]!.p,
      samples[Math.min(samples.length - 1, i + 1)]!.p,
    );
    // Left of a heading (dx, dz) in x-east/z-south axes is (dz, -dx).
    const n: XZ = [d0[1] + d1[1], -(d0[0] + d1[0])];
    const l = Math.hypot(n[0], n[1]) || 1;
    const cos = Math.max(0.5, (n[0] / l) * d0[1] - (n[1] / l) * d0[0]);
    return [n[0] / l / cos, n[1] / l / cos];
  });
}

/**
 * A raised road: a deck with an edge band over a tapered girder, straight between the ground at
 * its bridge's two ends, rising over its approaches. Low parts of the approaches are solid (an
 * embankment nothing passes under); the rest stands open on round piers, placed clear of the roads
 * below. Roads get edge lines and a dashed centre line, railways their rails.
 */
export function buildRaised(input: RaisedInput): { mesh: RoofMesh; top: number } {
  const b = new MeshBuilder();
  const rough = lengthOf(input.points);
  const smooth = smoothed(input.points, input.widths);
  const { samples, length } = resample(smooth.points, smooth.widths);
  if (samples.length < 2 || length < 1) return { mesh: b.build(), top: 0 };
  // Rounding the corners shortens the line a little: the approaches keep their share of it.
  const scale = rough > 0 ? length / rough : 1;
  const approaches = input.approaches.map((a) => a * scale) as [number, number];
  const deck: [number, number] = [
    Math.min(approaches[0], length),
    Math.max(approaches[0], length - approaches[1]),
  ];
  const profile = profileOf(length, deck, input.level);
  const left = lefts(samples);
  const path = PATHS.has(input.cls);
  const surface = path ? SURFACE.path : SURFACE[input.kind];
  const grounds = samples.map(({ p }) => input.ground(p));
  // The bridge rests on its abutments: a straight line between the ground at its two ends.
  const abutment = (s: number): number => {
    const k = Math.max(
      1,
      samples.findIndex((x) => x.s >= s),
    );
    const [a, c] = [samples[k - 1]!, samples[k]!];
    const t = c.s > a.s ? Math.max(0, Math.min(1, (s - a.s) / (c.s - a.s))) : 0;
    return input.ground([a.p[0] + (c.p[0] - a.p[0]) * t, a.p[1] + (c.p[1] - a.p[1]) * t]);
  };
  const [g0, g1] = [abutment(deck[0]), abutment(deck[1])];
  const onDeck = samples.map(({ s }) => s > deck[0] + 1e-6 && s < deck[1] - 1e-6);
  const base = samples.map(({ s }, i) =>
    onDeck[i] ? g0 + ((g1 - g0) * (s - deck[0])) / (deck[1] - deck[0] || 1) : grounds[i]!,
  );
  const heights = samples.map(({ s }, i) => base[i]! + Math.max(RAMP_FOOT_M, liftAt(profile, s)));
  const open = samples.map((_, i) => onDeck[i] || heights[i]! - grounds[i]! > SOLID_BELOW_M);
  const at = (i: number, side: number, share: number, y: number): Vec3 => {
    const { p, w } = samples[i]!;
    const off = (w / 2) * share * side;
    return [p[0] + left[i]![0] * off, y, p[1] + left[i]![1] * off];
  };
  const top = (i: number) => heights[i]!;
  const band = (i: number) => Math.max(grounds[i]!, heights[i]! - FASCIA_M);
  const under = (i: number) => Math.max(grounds[i]!, heights[i]! - DECK_M);

  for (let i = 0; i + 1 < samples.length; i++) {
    const j = i + 1;
    b.quad(
      at(i, 1, 1, top(i)),
      at(i, -1, 1, top(i)),
      at(j, -1, 1, top(j)),
      at(j, 1, 1, top(j)),
      surface,
    );
    const solid = !open[i] || !open[j];
    for (const side of [1, -1]) {
      b.quad(
        at(i, side, 1, top(i)),
        at(i, side, 1, band(i)),
        at(j, side, 1, band(j)),
        at(j, side, 1, top(j)),
        FASCIA,
      );
      if (solid)
        // An embankment: its wall from the band down to the ground.
        b.quad(
          at(i, side, 1, band(i)),
          at(i, side, 1, grounds[i]!),
          at(j, side, 1, grounds[j]!),
          at(j, side, 1, band(j)),
          GIRDER,
        );
      else
        // The girder's sloping side, from under the band in to the underside.
        b.quad(
          at(i, side, 1, band(i)),
          at(i, side, GIRDER_SHARE, under(i)),
          at(j, side, GIRDER_SHARE, under(j)),
          at(j, side, 1, band(j)),
          GIRDER,
        );
    }
    if (!solid)
      b.quad(
        at(i, 1, GIRDER_SHARE, under(i)),
        at(j, 1, GIRDER_SHARE, under(j)),
        at(j, -1, GIRDER_SHARE, under(j)),
        at(i, -1, GIRDER_SHARE, under(i)),
        GIRDER,
      );
  }
  // Ends: where a ramp meets the ground, or a bridge without approaches meets its abutment.
  for (const i of [0, samples.length - 1]) {
    const low = open[i] ? under(i) : grounds[i]!;
    const share = open[i] ? GIRDER_SHARE : 1;
    b.quad(
      at(i, 1, 1, top(i)),
      at(i, -1, 1, top(i)),
      at(i, -1, 1, band(i)),
      at(i, 1, 1, band(i)),
      FASCIA,
    );
    b.quad(
      at(i, 1, 1, band(i)),
      at(i, -1, 1, band(i)),
      at(i, -1, share, low),
      at(i, 1, share, low),
      GIRDER,
    );
  }

  paint(b, { samples, left, heights, length }, input.kind, input.cls);

  // Piers under the open stretches, every PIER_EVERY_M, moved along to stand clear of the roads.
  const blocked = input.blocked ?? (() => false);
  const free = samples.map((_, i) => !!open[i] && under(i) - grounds[i]! >= PIER_MIN_CLEARANCE_M);
  let last = -Infinity;
  for (let s = PIER_EVERY_M / 2; s < length; s += STEP_M) {
    if (s - last < PIER_EVERY_M) continue;
    const i = samples.findIndex((x) => x.s >= s);
    if (i < 0 || !free[i]) continue;
    const spot = pierSpot(samples, left, free, i, blocked);
    if (!spot) continue;
    const { k, columns } = spot;
    const w = samples[k]!.w;
    pier(b, samples[k]!.p, left[k]!, columns, w * GIRDER_SHARE, grounds[k]!, under(k));
    last = samples[k]!.s;
  }
  return { mesh: b.build(), top: Math.max(...heights.map((h, i) => h - base[i]!)) };
}

/** Column offsets across the deck (metres left of centre) for a deck `w` wide. */
const columnsFor = (w: number) => (w > TWIN_COLUMNS_FROM_M ? [w / 4, -w / 4] : [0]);

/**
 * The sample nearest `i`, within PIER_SHIFT_M along the deck, where every column of a pier stands
 * clear of the roads below; undefined where there is none (the span grows longer).
 */
function pierSpot(
  samples: { p: XZ; s: number; w: number }[],
  left: XZ[],
  free: boolean[],
  i: number,
  blocked: (p: XZ, radius: number) => boolean,
): { k: number; columns: number[] } | undefined {
  const s = samples[i]!.s;
  const tries = samples
    .map((x, k) => ({ k, d: Math.abs(x.s - s) }))
    .filter(({ k, d }) => d <= PIER_SHIFT_M && free[k])
    .sort((a, b) => a.d - b.d);
  for (const { k } of tries) {
    const { p, w } = samples[k]!;
    const columns = columnsFor(w);
    const l = left[k]!;
    const clear = columns.every(
      (o) => !blocked([p[0] + l[0] * o, p[1] + l[1] * o], COLUMN_R + 0.5),
    );
    if (clear) return { k, columns };
  }
  return undefined;
}

/**
 * A pier: round columns (octagons) from `base` up to a cap under the deck, the cap `across` wide,
 * tapering in towards its foot.
 */
function pier(
  b: MeshBuilder,
  [x, z]: XZ,
  left: XZ,
  columns: number[],
  across: number,
  base: number,
  top: number,
): void {
  const l = Math.hypot(left[0], left[1]) || 1;
  const [lx, lz] = [left[0] / l, left[1] / l];
  const [fx, fz] = [-lz, lx];
  const capFoot = top - Math.min(0.8, (top - base) / 3);
  for (const o of columns) {
    const [cx, cz] = [x + lx * o, z + lz * o];
    for (let k = 0; k < 8; k++) {
      const [a0, a1] = [(k * Math.PI) / 4, ((k + 1) * Math.PI) / 4];
      const ring = (a: number, y: number): Vec3 => [
        cx + Math.cos(a) * COLUMN_R,
        y,
        cz + Math.sin(a) * COLUMN_R,
      ];
      b.quad(ring(a0, base), ring(a1, base), ring(a1, capFoot), ring(a0, capFoot), PIER);
    }
  }
  // The cap: `across` wide and 1.6 m along at the top, two thirds of that at its foot.
  const corner = (a: number, f: number, y: number, k: number): Vec3 => [
    x + lx * a * (across / 2) * k + fx * f * 0.8 * k,
    y,
    z + lz * a * (across / 2) * k + fz * f * 0.8 * k,
  ];
  const ring: [number, number][] = [
    [1, 1],
    [-1, 1],
    [-1, -1],
    [1, -1],
  ];
  for (let k = 0; k < 4; k++) {
    const [a0, f0] = ring[k]!;
    const [a1, f1] = ring[(k + 1) % 4]!;
    b.quad(
      corner(a0, f0, capFoot, 0.67),
      corner(a1, f1, capFoot, 0.67),
      corner(a1, f1, top, 1),
      corner(a0, f0, top, 1),
      PIER,
    );
  }
  b.quad(
    corner(1, 1, capFoot, 0.67),
    corner(-1, 1, capFoot, 0.67),
    corner(-1, -1, capFoot, 0.67),
    corner(1, -1, capFoot, 0.67),
    PIER,
  );
}

const lengthOf = (points: XZ[]) =>
  points
    .slice(1)
    .reduce((sum, p, i) => sum + Math.hypot(p[0] - points[i]![0], p[1] - points[i]![1]), 0);

/**
 * Corners rounded (Chaikin, twice): a curve mapped as a few straight pieces drawn as a curve. The
 * ends stay where they are.
 */
export function smoothed(points: XZ[], widths: number[]): { points: XZ[]; widths: number[] } {
  let p = points;
  let w = widths;
  for (let round = 0; round < 2 && p.length > 2; round++) {
    const np: XZ[] = [p[0]!];
    const nw: number[] = [w[0]!];
    for (let i = 0; i + 1 < p.length; i++) {
      const [a, c] = [p[i]!, p[i + 1]!];
      const [wa, wc] = [w[i]!, w[i + 1]!];
      if (i > 0) {
        np.push([a[0] * 0.75 + c[0] * 0.25, a[1] * 0.75 + c[1] * 0.25]);
        nw.push(wa * 0.75 + wc * 0.25);
      }
      if (i + 2 < p.length) {
        np.push([a[0] * 0.25 + c[0] * 0.75, a[1] * 0.25 + c[1] * 0.75]);
        nw.push(wa * 0.25 + wc * 0.75);
      }
    }
    np.push(p.at(-1)!);
    nw.push(w.at(-1)!);
    p = np;
    w = nw;
  }
  return { points: p, widths: w };
}

/** A line laid out for drawing: samples, their left vectors and surface heights. */
interface Track {
  samples: { p: XZ; s: number; w: number }[];
  left: XZ[];
  heights: number[];
  length: number;
}

/**
 * Markings on a road (edge lines, and a dashed centre line on roads wide enough) or a railway's
 * rails, along a track; none over the `skip` stretches (junctions).
 */
function paint(
  b: MeshBuilder,
  { samples, left, heights, length }: Track,
  kind: Raised['kind'],
  cls: string,
  skip: [number, number][] = [],
): void {
  // A point `offset` metres left of the centre line, `lift` above the surface, `s` metres along.
  const along = (s: number, offset: number, lift: number): Vec3 => {
    const k = Math.max(
      1,
      samples.findIndex((x) => x.s >= s),
    );
    const [a, c] = [samples[k - 1]!, samples[k]!];
    const t = c.s > a.s ? Math.max(0, Math.min(1, (s - a.s) / (c.s - a.s))) : 0;
    const p: XZ = [a.p[0] + (c.p[0] - a.p[0]) * t, a.p[1] + (c.p[1] - a.p[1]) * t];
    const l: XZ = [
      left[k - 1]![0] + (left[k]![0] - left[k - 1]![0]) * t,
      left[k - 1]![1] + (left[k]![1] - left[k - 1]![1]) * t,
    ];
    const y = heights[k - 1]! + (heights[k]! - heights[k - 1]!) * t + lift;
    return [p[0] + l[0] * offset, y, p[1] + l[1] * offset];
  };
  const widthAt = (s: number) =>
    samples[
      Math.max(
        0,
        samples.findIndex((x) => x.s >= s),
      )
    ]!.w;
  /** The parts of [s0, s1] outside the skipped stretches. */
  const visible = (s0: number, s1: number): [number, number][] =>
    skip
      .slice()
      .sort((x, y) => x[0] - y[0])
      .reduce<[number, number][]>(
        (parts, [a, c]) =>
          parts.flatMap(([u, v]): [number, number][] =>
            c <= u || a >= v
              ? [[u, v]]
              : [
                  ...(a > u ? [[u, a] as [number, number]] : []),
                  ...(c < v ? [[c, v] as [number, number]] : []),
                ],
          ),
        [[s0, s1]],
      );
  /** A strip `wide` metres across, `offset` left of centre, from s0 to s1, raised by `lift`. */
  const strip = (
    s0: number,
    s1: number,
    offset: number,
    wide: number,
    lift: number,
    color: RGB,
  ) => {
    for (const [u, v] of visible(s0, s1)) {
      const cuts = [u, ...samples.map((x) => x.s).filter((s) => s > u && s < v), v];
      for (let k = 0; k + 1 < cuts.length; k++) {
        const [a, c] = [cuts[k]!, cuts[k + 1]!];
        b.quad(
          along(a, offset + wide / 2, lift),
          along(a, offset - wide / 2, lift),
          along(c, offset - wide / 2, lift),
          along(c, offset + wide / 2, lift),
          color,
        );
      }
    }
  };
  if (kind === 'rail') {
    // One track: two rails a standard gauge apart, on the ballast.
    for (const side of [0.72, -0.72]) strip(0, length, side, 0.12, 0.12, STEEL);
  } else if (!PATHS.has(cls)) {
    const half = widthAt(length / 2) / 2 - EDGE_INSET_M;
    for (const side of [1, -1]) strip(0, length, side * half, LINE_M, 0.03, PAINT);
    if (widthAt(length / 2) >= MARKED_FROM_M)
      for (let s = DASH_M[1] / 2; s + DASH_M[0] < length; s += DASH_M[1])
        strip(s, s + DASH_M[0], 0, LINE_M, 0.03, PAINT);
  }
}

/** Ground roads lie this far above the ground, plus GROUND_RANK_M per rank (bigger roads on top). */
const GROUND_LIFT_M = 0.05;
const GROUND_RANK_M = 0.03;
/** Height of a ground road of `rank` above the ground. */
export const groundLift = (rank: number) => GROUND_LIFT_M + rank * GROUND_RANK_M;

export interface GroundInput {
  points: XZ[];
  width: number;
  kind: Raised['kind'];
  cls: string;
  /** Drawing order: bigger roads lie over smaller ones (see `groundLift`). */
  rank: number;
  ground(p: XZ): number;
  /** Junctions along it, local metres: no markings across them. */
  junctions?: { at: XZ; radius: number }[];
}

/** A road or railway on the ground: a ribbon following the terrain, with its markings or rails. */
export function buildGround(input: GroundInput): RoofMesh {
  const b = new MeshBuilder();
  const smooth = smoothed(
    input.points,
    input.points.map(() => input.width),
  );
  const { samples, length } = resample(smooth.points, smooth.widths);
  if (samples.length < 2 || length < 0.5) return b.build();
  const left = lefts(samples);
  const lift = groundLift(input.rank);
  const heights = samples.map(({ p }) => input.ground(p) + lift);
  const surface = PATHS.has(input.cls) ? SURFACE.path : SURFACE[input.kind];
  const edge = (i: number, side: number): Vec3 => {
    const { p, w } = samples[i]!;
    return [p[0] + left[i]![0] * (w / 2) * side, heights[i]!, p[1] + left[i]![1] * (w / 2) * side];
  };
  // Facing up, so it is lit like the ground it lies on.
  for (let i = 0; i + 1 < samples.length; i++) {
    b.triangle(edge(i, 1), edge(i, -1), edge(i + 1, -1), surface, true);
    b.triangle(edge(i, 1), edge(i + 1, -1), edge(i + 1, 1), surface, true);
  }
  // No markings across a junction: from where the line comes within its radius until it leaves.
  const skip: [number, number][] = [];
  for (const j of input.junctions ?? []) {
    let best = { d: Infinity, s: 0 };
    for (const x of samples) {
      const d = Math.hypot(x.p[0] - j.at[0], x.p[1] - j.at[1]);
      if (d < best.d) best = { d, s: x.s };
    }
    if (best.d <= j.radius + input.width / 2) {
      const r = j.radius + 1;
      skip.push([best.s - r, best.s + r]);
    }
  }
  paint(b, { samples, left, heights, length }, input.kind, input.cls, skip);
  return b.build();
}

/** A junction's patch: a disc over the roads meeting there, at the highest one's height. */
export function buildJunction(at: XZ, radius: number, rank: number, ground: number): RoofMesh {
  const b = new MeshBuilder();
  const y = ground + groundLift(rank) + 0.012;
  const n = 20;
  for (let k = 0; k < n; k++) {
    const [a0, a1] = [(k * 2 * Math.PI) / n, ((k + 1) * 2 * Math.PI) / n];
    b.triangle(
      [at[0], y, at[1]],
      [at[0] + Math.cos(a0) * radius, y, at[1] + Math.sin(a0) * radius],
      [at[0] + Math.cos(a1) * radius, y, at[1] + Math.sin(a1) * radius],
      SURFACE.road,
      true,
    );
  }
  return b.build();
}

const PORTAL = toRGB('#bdb7ac');
const MOUTH = toRGB('#1d1e21');
/** Clearance of a tunnel mouth, metres (roads, railways). */
const PORTAL_CLEARANCE = { road: 5, rail: 6.5 } as const;
const PORTAL_LINTEL_M = 1.4;
/** How deep the portal's frame is, along the road. */
const PORTAL_DEPTH_M = 1.5;

/**
 * A tunnel portal: a concrete frame across the road, its opening dark, facing out of the tunnel.
 * `heading` points into the tunnel (local x east, z south).
 */
export function buildPortal(
  at: XZ,
  heading: XZ,
  width: number,
  kind: Raised['kind'],
  ground: number,
): RoofMesh {
  const b = new MeshBuilder();
  const l = Math.hypot(heading[0], heading[1]) || 1;
  const [fx, fz] = [heading[0] / l, heading[1] / l];
  const [lx, lz] = [fz, -fx];
  const clear = PORTAL_CLEARANCE[kind];
  const half = width / 2 + 0.5;
  const wall = 1.2;
  const lintel = PORTAL_LINTEL_M;
  const depth = PORTAL_DEPTH_M;
  /** A point `a` metres to the left, `f` metres into the tunnel, `y` up. */
  const pt = (a: number, f: number, y: number): Vec3 => [
    at[0] + lx * a + fx * f,
    ground + y,
    at[1] + lz * a + fz * f,
  ];
  const box = (a0: number, a1: number, y0: number, y1: number) => {
    const c = [
      [a0, 0],
      [a1, 0],
      [a1, depth],
      [a0, depth],
    ] as const;
    for (let k = 0; k < 4; k++) {
      const [p, q] = [c[k]!, c[(k + 1) % 4]!];
      b.quad(
        pt(p[0], p[1], y0),
        pt(q[0], q[1], y0),
        pt(q[0], q[1], y1),
        pt(p[0], p[1], y1),
        PORTAL,
      );
    }
    b.quad(pt(a0, 0, y1), pt(a1, 0, y1), pt(a1, depth, y1), pt(a0, depth, y1), PORTAL);
  };
  box(half, half + wall, 0, clear + lintel);
  box(-half - wall, -half, 0, clear + lintel);
  box(-half, half, clear, clear + lintel);
  // The dark opening, just inside the frame.
  b.quad(
    pt(half, depth, 0),
    pt(-half, depth, 0),
    pt(-half, depth, clear),
    pt(half, depth, clear),
    MOUTH,
  );
  // Behind it, the tunnel: closed in concrete, so the portal is solid seen from behind.
  b.quad(
    pt(half, depth + 0.05, 0),
    pt(-half, depth + 0.05, 0),
    pt(-half, depth + 0.05, clear),
    pt(half, depth + 0.05, clear),
    PORTAL,
  );
  return b.build();
}

/** Depth of a cutting at the portal: the tunnel's clearance and the portal's lintel. */
export const cuttingDepth = (kind: Raised['kind']) => PORTAL_CLEARANCE[kind] + PORTAL_LINTEL_M;
/** Length of the road dropping into a cutting, metres (the bridges' average grade). */
export const cuttingLength = (kind: Raised['kind']) => cuttingDepth(kind) / AVERAGE_GRADE;
/** Retaining walls: their gap from the road edge, coping height above the ground and width. */
const WALL_GAP_M = 0.3;
const COPING_M = 0.6;
const COPING_T = 0.4;
/** The invisible ground hiding what lies below it: this far out beside a cutting and over a tunnel. */
const MASK_BAND_M = 25;
const MASK_COVER_M = 40;

export interface CuttingInput {
  /** From the top of the cutting to the portal, local metres (one point: a portal on the level). */
  points: XZ[];
  widths: number[];
  /** Width of the tunnel. */
  width: number;
  kind: Raised['kind'];
  cls: string;
  /** Into the tunnel at the portal, local (x east, z south). */
  heading: XZ;
  /** How far below the ground the road reaches at the portal, metres. */
  depth: number;
  ground(p: XZ): number;
  /**
   * How far from `p` along unit `dir` the ground is free of other cuttings, metres (default: as
   * far as needed). The ground mask stops there, so it never covers another cutting's trench.
   */
  room?(p: XZ, dir: XZ, max: number): number;
}

/**
 * A road dropping into a cutting to a tunnel portal: the road descending between retaining walls,
 * whose coping stands a little above the ground, to a portal whose top meets the ground. The
 * `mask` is the ground around it, to draw into the depth buffer only: the flat map writes no
 * depth, so without it what lies below the ground (the walls' backs, the tunnel) would show
 * through. The `hole` is the trench's opening, to draw as far depth before it: terrain writes
 * depth, and would hide the trench.
 */
export function buildCutting(input: CuttingInput): {
  mesh: RoofMesh;
  mask: RoofMesh;
  hole: RoofMesh;
} {
  const b = new MeshBuilder();
  const mask = new MeshBuilder();
  const hole = new MeshBuilder();
  const room = input.room ?? ((_p: XZ, _d: XZ, max: number) => max);
  const portalAt = input.points.at(-1)!;
  const portalGround = input.ground(portalAt);
  let length = 0;
  if (input.points.length > 1 && input.depth > 0.05) {
    // A width per step along the road (one fewer than its points): each point gets the step's.
    const steps = input.widths.length ? input.widths : [input.width];
    const perPoint = input.points.map((_, i) => steps[Math.min(i, steps.length - 1)]!);
    const smooth = smoothed(
      input.points,
      perPoint.map((w) => w + 2 * WALL_GAP_M),
    );
    const track = resample(smooth.points, smooth.widths);
    const { samples } = track;
    length = track.length;
    const left = lefts(samples);
    const grounds = samples.map(({ p }) => input.ground(p));
    const dip = (s: number) => {
      const t = Math.max(0, Math.min(1, s / (length || 1)));
      return input.depth * t * t * (3 - 2 * t);
    };
    const heights = samples.map(({ s }, i) => grounds[i]! + GROUND_LIFT_M - dip(s));
    const at = (i: number, off: number, y: number): Vec3 => {
      const { p } = samples[i]!;
      return [p[0] + left[i]![0] * off, y, p[1] + left[i]![1] * off];
    };
    const surface = PATHS.has(input.cls) ? SURFACE.path : SURFACE[input.kind];
    for (let i = 0; i + 1 < samples.length; i++) {
      const j = i + 1;
      const [wi, wj] = [samples[i]!.w / 2, samples[j]!.w / 2];
      b.triangle(
        at(i, wi, heights[i]!),
        at(i, -wi, heights[i]!),
        at(j, -wj, heights[j]!),
        surface,
        true,
      );
      b.triangle(
        at(i, wi, heights[i]!),
        at(j, -wj, heights[j]!),
        at(j, wj, heights[j]!),
        surface,
        true,
      );
      for (const side of [1, -1]) {
        const [oi, oj] = [wi * side, wj * side];
        const [ci, cj] = [(wi + COPING_T) * side, (wj + COPING_T) * side];
        const [ti, tj] = [grounds[i]! + COPING_M, grounds[j]! + COPING_M];
        // The wall's face from the road up to its coping, the coping's top and outer face.
        b.quad(
          at(i, oi, heights[i]!),
          at(i, oi, ti),
          at(j, oj, tj),
          at(j, oj, heights[j]!),
          FASCIA,
        );
        b.quad(at(i, oi, ti), at(i, ci, ti), at(j, cj, tj), at(j, oj, tj), PIER);
        b.quad(at(i, ci, ti), at(i, ci, grounds[i]!), at(j, cj, grounds[j]!), at(j, cj, tj), PIER);
        // The opening between the copings, at the ground: where the trench shows through terrain.
        if (side === 1)
          hole.quad(
            at(i, ci, grounds[i]!),
            at(i, -ci, grounds[i]!),
            at(j, -cj, grounds[j]!),
            at(j, cj, grounds[j]!),
            PIER,
          );
        // The ground beside it, out to the band's edge or the next cutting.
        const out = (k: number, w: number) => {
          const from = at(k, (w + COPING_T) * side, 0);
          const dir: XZ = [left[k]![0] * side, left[k]![1] * side];
          const l = Math.hypot(dir[0], dir[1]) || 1;
          const free = room([from[0], from[2]], [dir[0] / l, dir[1] / l], MASK_BAND_M);
          return (w + COPING_T + free * l) * side;
        };
        const [bi, bj] = [out(i, wi), out(j, wj)];
        mask.quad(
          at(i, ci, grounds[i]! - 0.02),
          at(i, bi, grounds[i]! - 0.02),
          at(j, bj, grounds[j]! - 0.02),
          at(j, cj, grounds[j]! - 0.02),
          PIER,
        );
      }
    }
    paint(
      b,
      { samples: samples.map((x) => ({ ...x, w: x.w - 2 * WALL_GAP_M })), left, heights, length },
      input.kind,
      input.cls,
    );
  }
  const base = portalGround - (length > 0 ? input.depth : 0);
  const portal = buildPortal(portalAt, input.heading, input.width, input.kind, base);
  appendMesh(b, portal);
  if (length > 0) {
    // The ground over the tunnel, from the portal's back on: hides the tunnel below it.
    const l = Math.hypot(input.heading[0], input.heading[1]) || 1;
    const [fx, fz] = [input.heading[0] / l, input.heading[1] / l];
    const [lx, lz] = [fz, -fx];
    const pt = (a: number, f: number): Vec3 => {
      const p: XZ = [portalAt[0] + lx * a + fx * f, portalAt[1] + lz * a + fz * f];
      return [p[0], input.ground(p) - 0.02, p[1]];
    };
    // As wide and as long as the ground stays clear of other cuttings.
    const frame = input.width / 2 + 0.5 + 1.2;
    const sideways = (sign: number) =>
      frame +
      room(
        [portalAt[0] + lx * frame * sign, portalAt[1] + lz * frame * sign],
        [lx * sign, lz * sign],
        MASK_BAND_M,
      );
    const [half0, half1] = [sideways(1), sideways(-1)];
    const ahead =
      PORTAL_DEPTH_M +
      room(
        [portalAt[0] + fx * PORTAL_DEPTH_M, portalAt[1] + fz * PORTAL_DEPTH_M],
        [fx, fz],
        MASK_COVER_M,
      );
    if (ahead > PORTAL_DEPTH_M + 0.5)
      mask.quad(
        pt(half0, PORTAL_DEPTH_M),
        pt(-half1, PORTAL_DEPTH_M),
        pt(-half1, ahead),
        pt(half0, ahead),
        PIER,
      );
  }
  return { mesh: b.build(), mask: mask.build(), hole: hole.build() };
}

/** Add a built mesh's triangles to a builder (as built: normals and colours kept). */
function appendMesh(b: MeshBuilder, mesh: RoofMesh): void {
  const p = mesh.positions;
  for (let i = 0; i + 8 < p.length; i += 9)
    b.triangle(
      [p[i]!, p[i + 1]!, p[i + 2]!],
      [p[i + 3]!, p[i + 4]!, p[i + 5]!],
      [p[i + 6]!, p[i + 7]!, p[i + 8]!],
      [mesh.colors[i]!, mesh.colors[i + 1]!, mesh.colors[i + 2]!],
    );
}

const CEILING = toRGB('#3a3b3e');

/**
 * A short tunnel on the level (a gallery, a covered stretch, a toll canopy): the road carrying on
 * under a concrete box, side walls up to a roof, dark beneath.
 */
export function buildCover(input: {
  points: XZ[];
  width: number;
  kind: Raised['kind'];
  cls: string;
  ground(p: XZ): number;
}): RoofMesh {
  const b = new MeshBuilder();
  const { samples, length } = resample(
    input.points,
    input.points.map(() => input.width),
  );
  if (samples.length < 2 || length < 0.5) return b.build();
  const left = lefts(samples);
  const grounds = samples.map(({ p }) => input.ground(p));
  const heights = grounds.map((g) => g + GROUND_LIFT_M);
  const clear = PORTAL_CLEARANCE[input.kind];
  const at = (i: number, off: number, y: number): Vec3 => {
    const { p } = samples[i]!;
    return [p[0] + left[i]![0] * off, y, p[1] + left[i]![1] * off];
  };
  const surface = PATHS.has(input.cls) ? SURFACE.path : SURFACE[input.kind];
  const inner = input.width / 2 + 0.5;
  const outer = inner + 0.6;
  for (let i = 0; i + 1 < samples.length; i++) {
    const j = i + 1;
    const [ri, rj] = [grounds[i]! + clear, grounds[j]! + clear];
    b.triangle(
      at(i, inner, heights[i]!),
      at(i, -inner, heights[i]!),
      at(j, -inner, heights[j]!),
      surface,
      true,
    );
    b.triangle(
      at(i, inner, heights[i]!),
      at(j, -inner, heights[j]!),
      at(j, inner, heights[j]!),
      surface,
      true,
    );
    for (const side of [1, -1]) {
      b.quad(
        at(i, inner * side, grounds[i]!),
        at(i, inner * side, ri),
        at(j, inner * side, rj),
        at(j, inner * side, grounds[j]!),
        FASCIA,
      );
      b.quad(
        at(i, outer * side, grounds[i]!),
        at(i, outer * side, ri + 0.8),
        at(j, outer * side, rj + 0.8),
        at(j, outer * side, grounds[j]!),
        PORTAL,
      );
    }
    b.quad(
      at(i, outer, ri + 0.8),
      at(i, -outer, ri + 0.8),
      at(j, -outer, rj + 0.8),
      at(j, outer, rj + 0.8),
      PORTAL,
    );
    b.quad(at(i, inner, ri), at(i, -inner, ri), at(j, -inner, rj), at(j, inner, rj), CEILING);
  }
  // Its two ends: the frame around the opening (wall ends and the roof's edge).
  for (const i of [0, samples.length - 1]) {
    const r = grounds[i]! + clear;
    for (const side of [1, -1])
      b.quad(
        at(i, inner * side, grounds[i]!),
        at(i, outer * side, grounds[i]!),
        at(i, outer * side, r + 0.8),
        at(i, inner * side, r + 0.8),
        PORTAL,
      );
    b.quad(
      at(i, inner, r),
      at(i, -inner, r),
      at(i, -inner, r + 0.8),
      at(i, inner, r + 0.8),
      PORTAL,
    );
  }
  paint(
    b,
    { samples: samples.map((x) => ({ ...x, w: input.width })), left, heights, length },
    input.kind,
    input.cls,
  );
  return b.build();
}
