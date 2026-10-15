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
const DECK_M = 1.2;
const PARAPET_M = 1;
const PARAPET_T = 0.35;
/** Ramps start just above the flat road painted under them. */
const RAMP_FOOT_M = 0.1;
/** Spacing of the piers, metres; none where the deck is this close to the ground. */
const PIER_EVERY_M = 30;
const PIER_MIN_CLEARANCE_M = 2;
/** Profile samples at most this far apart, metres (smooth ramps). */
const STEP_M = 5;

const SURFACE: Record<Raised['kind'] | 'path', RGB> = {
  road: toRGB('#5d6066'),
  rail: toRGB('#6e665c'),
  path: toRGB('#9b958c'),
};
const CONCRETE = toRGB('#b8b2a7');
const PARAPET = toRGB('#cbc6bc');
const PIER = toRGB('#a39d92');
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
 * A raised road: its approaches as embankments (solid sides down to the ground) and its bridge as
 * a deck on piers, straight between the ground at its two ends; parapets along both, growing
 * with the height.
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
  const surface = PATHS.has(input.cls) ? SURFACE.path : SURFACE[input.kind];
  const grounds = samples.map(({ p }) => input.ground(p));
  // The bridge rests on its abutments: a straight line between the ground at its two ends.
  const abutment = (s: number) => {
    const i = samples.findIndex((x) => x.s >= s - 1e-6);
    return grounds[Math.max(0, i)]!;
  };
  const [g0, g1] = [abutment(deck[0]), abutment(deck[1])];
  const onDeck = samples.map(({ s }) => s > deck[0] + 1e-6 && s < deck[1] - 1e-6);
  const base = samples.map(({ s }, i) =>
    onDeck[i] ? g0 + ((g1 - g0) * (s - deck[0])) / (deck[1] - deck[0] || 1) : grounds[i]!,
  );
  const heights = samples.map(({ s }, i) => base[i]! + Math.max(RAMP_FOOT_M, liftAt(profile, s)));
  const parapet = heights.map((h, i) => PARAPET_M * Math.min(1, (h - base[i]!) / 2));
  const at = (i: number, side: 1 | -1, inset: number, y: number): Vec3 => {
    const { p, w } = samples[i]!;
    const off = (w / 2 - inset) * side;
    return [p[0] + left[i]![0] * off, y, p[1] + left[i]![1] * off];
  };
  const top = (i: number) => heights[i]!;
  const rail = (i: number) => heights[i]! + parapet[i]!;
  // Underside: the deck's on the bridge, the ground along the embankments.
  const under = (i: number) => (onDeck[i] || onDeck[i - 1] ? heights[i]! - DECK_M : grounds[i]!);
  for (let i = 0; i + 1 < samples.length; i++) {
    const j = i + 1;
    const bridge = onDeck[i] || onDeck[j];
    b.quad(
      at(i, 1, PARAPET_T, top(i)),
      at(i, -1, PARAPET_T, top(i)),
      at(j, -1, PARAPET_T, top(j)),
      at(j, 1, PARAPET_T, top(j)),
      surface,
    );
    if (bridge)
      b.quad(
        at(i, 1, 0, top(i) - DECK_M),
        at(j, 1, 0, top(j) - DECK_M),
        at(j, -1, 0, top(j) - DECK_M),
        at(i, -1, 0, top(i) - DECK_M),
        CONCRETE,
      );
    const low = (k: number) => (bridge ? top(k) - DECK_M : grounds[k]!);
    for (const side of [1, -1] as const) {
      // Outer face from the underside (or the ground) to the parapet top, its top, its inner face.
      b.quad(
        at(i, side, 0, low(i)),
        at(i, side, 0, rail(i)),
        at(j, side, 0, rail(j)),
        at(j, side, 0, low(j)),
        CONCRETE,
      );
      if (parapet[i]! + parapet[j]! < 0.05) continue;
      b.quad(
        at(i, side, 0, rail(i)),
        at(i, side, PARAPET_T, rail(i)),
        at(j, side, PARAPET_T, rail(j)),
        at(j, side, 0, rail(j)),
        PARAPET,
      );
      b.quad(
        at(i, side, PARAPET_T, rail(i)),
        at(i, side, PARAPET_T, top(i)),
        at(j, side, PARAPET_T, top(j)),
        at(j, side, PARAPET_T, rail(j)),
        PARAPET,
      );
    }
  }
  // Ends: where a ramp meets the ground, or a bridge without approaches meets its abutment.
  for (const i of [0, samples.length - 1])
    b.quad(
      at(i, 1, 0, under(i)),
      at(i, -1, 0, under(i)),
      at(i, -1, 0, rail(i)),
      at(i, 1, 0, rail(i)),
      CONCRETE,
    );
  // Piers: every PIER_EVERY_M along the bridge, centred, where it clears the ground.
  for (let s = deck[0] + PIER_EVERY_M; s < deck[1] - PIER_EVERY_M / 2; s += PIER_EVERY_M) {
    const i = samples.findIndex((x) => x.s >= s);
    if (i < 0) break;
    const { p, w } = samples[i]!;
    const underside = heights[i]! - DECK_M;
    if (underside - grounds[i]! < PIER_MIN_CLEARANCE_M) continue;
    pier(b, p, left[i]!, Math.min(w * 0.6, 8), grounds[i]!, underside);
  }
  return { mesh: b.build(), top: Math.max(...heights.map((h, i) => h - base[i]!)) };
}

/** A box pier `across` wide (along the left vector) and 1.6 m thick, from `base` to `top`. */
function pier(
  b: MeshBuilder,
  [x, z]: XZ,
  left: XZ,
  across: number,
  base: number,
  top: number,
): void {
  const l = Math.hypot(left[0], left[1]) || 1;
  const [lx, lz] = [left[0] / l, left[1] / l];
  const [fx, fz] = [-lz, lx];
  const corner = (a: number, f: number, y: number): Vec3 => [
    x + lx * a * (across / 2) + fx * f * 0.8,
    y,
    z + lz * a * (across / 2) + fz * f * 0.8,
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
      corner(a0, f0, base),
      corner(a1, f1, base),
      corner(a1, f1, top),
      corner(a0, f0, top),
      PIER,
    );
  }
}
