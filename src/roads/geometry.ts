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
  const { samples, length } = resample(input.points, input.widths);
  if (samples.length < 2 || length < 1) return { mesh: b.build(), top: 0 };
  const deck: [number, number] = [
    Math.min(input.approaches[0], length),
    Math.max(input.approaches[0], length - input.approaches[1]),
  ];
  const profile = profileOf(length, deck, input.level);
  const left = lefts(samples);
  const path = PATHS.has(input.cls);
  const surface = path ? SURFACE.path : SURFACE[input.kind];
  const grounds = samples.map(({ p }) => input.ground(p));
  // The bridge rests on its abutments: a straight line between the ground at its two ends.
  const abutment = (s: number) =>
    grounds[
      Math.max(
        0,
        samples.findIndex((x) => x.s >= s - 1e-6),
      )
    ]!;
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

  // Along the deck: a point `offset` metres left of the centre line, `lift` above the surface.
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
  /** A strip `wide` metres across, `offset` left of centre, from s0 to s1, raised by `lift`. */
  const strip = (
    s0: number,
    s1: number,
    offset: number,
    wide: number,
    lift: number,
    color: RGB,
  ) => {
    const cuts = [s0, ...samples.map((x) => x.s).filter((s) => s > s0 && s < s1), s1];
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
  };
  if (input.kind === 'rail') {
    // One track: two rails a standard gauge apart, on the ballast.
    for (const side of [0.72, -0.72]) strip(0, length, side, 0.12, 0.12, STEEL);
  } else if (!path) {
    for (const side of [1, -1]) {
      const w = (s: number) => widthAt(s) / 2 - EDGE_INSET_M;
      strip(0, length, side * w(length / 2), LINE_M, 0.03, PAINT);
    }
    if (widthAt(length / 2) >= MARKED_FROM_M)
      for (let s = DASH_M[1] / 2; s + DASH_M[0] < length; s += DASH_M[1])
        strip(s, s + DASH_M[0], 0, LINE_M, 0.03, PAINT);
  }

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
