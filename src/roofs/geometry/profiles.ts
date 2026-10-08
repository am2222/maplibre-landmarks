import { ShapeUtils, Vector2 } from 'three';
import type { ProfileShape } from '../schema';
import { fromFrame, toFrame, type RoofFrame, type Vec2 } from './frame';
import { MeshBuilder, type RGB, type RoofMesh, type Vec3 } from './mesh';

/** A plane over the roof frame: h = a·u + b·v + c. */
export type Plane = [a: number, b: number, c: number];

/**
 * A roof surface: the highest of the groups, each group the lowest of its planes. Most roofs are
 * one group; butterfly, crosspitched and sawtooth combine several. `pairs` lists the planes that
 * can meet (default: every pair).
 */
export interface Profile {
  groups: Plane[][];
  pairs?: [Plane, Plane][];
}

const EPS = 1e-9;
/** Target sawtooth tooth width, metres. */
const TOOTH_M = 8;
/** Horizontal run of a sawtooth's (near-)vertical glazing face, metres. */
const GLAZING_M = 0.02;

/** Teeth across a sawtooth roof of half-width `W`, and each tooth's width. */
export function sawtoothTeeth(W: number): { n: number; width: number } {
  const n = Math.max(1, Math.round((2 * W) / TOOTH_M));
  return { n, width: (2 * W) / n };
}

function sawtooth(H: number, W: number): Profile {
  const { n, width } = sawtoothTeeth(W);
  const groups: Plane[][] = [];
  const pairs: [Plane, Plane][] = [];
  let prevSlope: Plane | null = null;
  for (let k = 0; k < n; k++) {
    const start = -W + k * width;
    // Glazing up from `start`; from its top (H) the slope runs down to 0 a tooth later, like a
    // skillion facing +v.
    const top = k === 0 ? start : start + GLAZING_M;
    const run = start + width - top;
    const slope: Plane = [0, -H / run, (H * (start + width)) / run];
    if (!prevSlope) {
      // The first tooth's high side is the building's own wall.
      groups.push([slope]);
    } else {
      const glazing: Plane = [0, H / GLAZING_M, (-H * start) / GLAZING_M];
      groups.push([slope, glazing]);
      pairs.push([slope, glazing], [prevSlope, glazing]);
    }
    prevSlope = slope;
  }
  return { groups, pairs };
}

/** The lowest of `terms`, each term the highest of its planes, as a profile's groups. */
function minOfMax(terms: Plane[][]): Plane[][] {
  return terms.reduce<Plane[][]>(
    (groups, term) => groups.flatMap((g) => term.map((p) => [...g, p])),
    [[]],
  );
}

/** The surface of a profile roof (spec section 5.2). */
export function profilePlanes(shape: ProfileShape, H: number, L: number, W: number): Profile {
  const gable: Plane[] = [
    [0, -H / W, H],
    [0, H / W, H],
  ];
  // Gambrel/mansard sides: steep lower third (to 0.6 H), shallower upper part (to H).
  const sides = (s: number): Plane[] => [
    [0, (-s * 1.8 * H) / W, 1.8 * H],
    [0, (-s * 0.6 * H) / W, H],
  ];
  const one = (planes: Plane[]): Profile => ({ groups: [planes] });
  switch (shape) {
    case 'gabled':
      return one(gable);
    case 'saltbox': {
      const r = W / 3;
      return one([
        [0, -H / (W - r), (H * W) / (W - r)],
        [0, H / (W + r), (H * W) / (W + r)],
      ]);
    }
    case 'hipped':
      return one([...gable, [-H / W, 0, (H * L) / W], [H / W, 0, (H * L) / W]]);
    case 'half_hipped':
      return one([...gable, [-H / W, 0, H / 2 + (H * L) / W], [H / W, 0, H / 2 + (H * L) / W]]);
    case 'hipped_and_gabled': {
      // Hips up to half height, then a small vertical gable at each end up to the ridge.
      const h0 = H / 2;
      const u0 = L - W / 2;
      const K = H / GLAZING_M;
      return {
        groups: minOfMax([
          [gable[0]!],
          [gable[1]!],
          [
            [-H / W, 0, (H * L) / W],
            [-K, 0, h0 + K * u0],
          ],
          [
            [H / W, 0, (H * L) / W],
            [K, 0, h0 + K * u0],
          ],
        ]),
      };
    }
    case 'gambrel':
      return one([...sides(1), ...sides(-1)]);
    case 'mansard': {
      // End slopes with the side pitches, measured from the end eaves (u = ±L).
      const ends = (s: number): Plane[] => [
        [(-s * 1.8 * H) / W, 0, (1.8 * H * L) / W],
        [(-s * 0.6 * H) / W, 0, 0.4 * H + (0.6 * H * L) / W],
      ];
      return one([...sides(1), ...sides(-1), ...ends(1), ...ends(-1)]);
    }
    case 'skillion':
      return one([[0, -H / (2 * W), H / 2]]);
    case 'round': {
      const n = 8;
      const arc = (v: number) => H * Math.sqrt(Math.max(0, 1 - (v / W) ** 2));
      const planes: Plane[] = [];
      for (let k = 0; k < n; k++) {
        const v0 = -W + (2 * W * k) / n;
        const v1 = -W + (2 * W * (k + 1)) / n;
        const slope = (arc(v1) - arc(v0)) / (v1 - v0);
        planes.push([0, slope, arc(v0) - slope * v0]);
      }
      return one(planes);
    }
    case 'bellcast_gable': {
      // Each side: steep down to 0.2 H at 70 % of the run, then a shallower flare to the eaves.
      const side = (s: number): Plane[] => [
        [0, (-s * 0.8 * H) / (0.7 * W), H],
        [0, (-s * 0.2 * H) / (0.3 * W), (0.2 * H) / 0.3],
      ];
      return { groups: minOfMax([side(1), side(-1)]) };
    }
    case 'butterfly':
      // A V: eaves at H on both long sides, valley at 0 along the middle.
      return { groups: [[[0, -H / W, 0]], [[0, H / W, 0]]] };
    case 'crosspitched':
      // Two gables crossing: one ridge along u, one along v, gable ends on all four sides.
      return {
        groups: [
          gable,
          [
            [-H / L, 0, H],
            [H / L, 0, H],
          ],
        ],
      };
    case 'sawtooth':
      return sawtooth(H, W);
  }
}

const heightAt = ({ groups }: Profile, u: number, v: number) =>
  Math.max(0, ...groups.map((g) => Math.min(...g.map(([a, b, c]) => a * u + b * v + c))));

/**
 * Lines where two planes of `profile` are equal (normalised a·u + b·v + c = 0), deduplicated,
 * keeping only lines that cross `box` = [minU, minV, maxU, maxV].
 */
export function creaseLines(profile: Profile, box: [number, number, number, number]): Plane[] {
  let pairs = profile.pairs;
  if (!pairs) {
    const planes = profile.groups.flat();
    pairs = planes.flatMap((p, i) => planes.slice(i + 1).map((q): [Plane, Plane] => [p, q]));
  }
  const out: Plane[] = [];
  const seen = new Set<string>();
  for (const [p, q] of pairs) {
    let a = p[0] - q[0];
    let b = p[1] - q[1];
    let c = p[2] - q[2];
    const n = Math.hypot(a, b);
    if (n < EPS) continue;
    a /= n;
    b /= n;
    c /= n;
    if (a < -EPS || (Math.abs(a) <= EPS && b < 0)) {
      a = -a;
      b = -b;
      c = -c;
    }
    const key = [a, b, c].map((x) => x.toFixed(6)).join();
    if (seen.has(key)) continue;
    seen.add(key);
    const s = [
      [box[0], box[1]],
      [box[2], box[1]],
      [box[2], box[3]],
      [box[0], box[3]],
    ].map(([u, v]) => a * u! + b * v! + c);
    if (s.every((x) => x > EPS) || s.every((x) => x < -EPS)) continue;
    out.push([a, b, c]);
  }
  return out;
}

/** The part of convex polygon `piece` on the `side` (±1) of line a·u + b·v + c = 0. */
function cutConvex(piece: Vec2[], [a, b, c]: Plane, side: number): Vec2[] {
  const out: Vec2[] = [];
  const sd = (p: Vec2) => side * (a * p[0] + b * p[1] + c);
  for (let i = 0; i < piece.length; i++) {
    const p = piece[i]!;
    const q = piece[(i + 1) % piece.length]!;
    const sp = sd(p);
    const sq = sd(q);
    if (sp >= 0) out.push(p);
    if ((sp > 0 && sq < 0) || (sp < 0 && sq > 0)) {
      const t = sp / (sp - sq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

/** Whether a planar polygon rises more than 80° from the ground. */
function steep(poly: Vec3[]): boolean {
  let [nx, ny, nz] = [0, 0, 0];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    nx += (p[1] - q[1]) * (p[2] + q[2]);
    ny += (p[2] - q[2]) * (p[0] + q[0]);
    nz += (p[0] - q[0]) * (p[1] + q[1]);
  }
  const len = Math.hypot(nx, ny, nz);
  return len > EPS && Math.abs(ny) / len < Math.cos((80 * Math.PI) / 180);
}

const close = (ring: Vec2[]): Vec2[] => {
  const [f, l] = [ring[0]!, ring.at(-1)!];
  return f[0] === l[0] && f[1] === l[1] ? ring : [...ring, f];
};
const open = (ring: Vec2[]): Vec2[] => {
  const [f, l] = [ring[0]!, ring.at(-1)!];
  return ring.length > 1 && f[0] === l[0] && f[1] === l[1] ? ring.slice(0, -1) : ring;
};

/**
 * Roof over `polygons` (local metres, rings in any orientation, holes allowed): the footprint is
 * split along every crease line so each piece lies under a single plane, each piece is
 * triangulated and lifted, and vertical faces close it down to y = 0.
 */
export function buildProfileRoof(
  polygons: Vec2[][][],
  frame: RoofFrame,
  profile: Profile,
  roof: RGB,
  wall: RGB,
): RoofMesh {
  const framed: Vec2[][][] = polygons.map((rings) =>
    rings.map((ring) => close(ring.map((p) => toFrame(frame, p)))),
  );
  const all = framed.flat(2);
  const box: [number, number, number, number] = [
    Math.min(...all.map((p) => p[0])),
    Math.min(...all.map((p) => p[1])),
    Math.max(...all.map((p) => p[0])),
    Math.max(...all.map((p) => p[1])),
  ];
  const lines = creaseLines(profile, box);
  const b = new MeshBuilder();
  const lift = ([u, v]: Vec2): Vec3 => {
    const [x, z] = fromFrame(frame, [u, v]);
    return [x, heightAt(profile, u, v), z];
  };
  const ground = ([u, v]: Vec2): Vec3 => {
    const [x, z] = fromFrame(frame, [u, v]);
    return [x, 0, z];
  };

  // Triangulate the footprint once (holes and concave outlines included), then cut every
  // triangle along every crease line. Cutting convex polygons by a line is exact and robust,
  // unlike general polygon clipping, which breaks where many creases meet at one point.
  let pieces: Vec2[][] = [];
  for (const rings of framed) {
    const [outer, ...holes] = rings.map(open);
    if (!outer || outer.length < 3) continue;
    const vertices = [outer, ...holes].flat();
    const faces = ShapeUtils.triangulateShape(
      outer.map(([u, v]) => new Vector2(u, v)),
      holes.map((h) => h.map(([u, v]) => new Vector2(u, v))),
    );
    for (const [i, j, k] of faces) pieces.push([vertices[i!]!, vertices[j!]!, vertices[k!]!]);
  }
  for (const line of lines) {
    pieces = pieces.flatMap((piece) => [cutConvex(piece, line, 1), cutConvex(piece, line, -1)]);
    pieces = pieces.filter((piece) => piece.length >= 3);
  }
  for (const piece of pieces) {
    const lifted = piece.map(lift);
    // Near-vertical pieces (sawtooth glazing) read as wall, not roof.
    const color = steep(lifted) ? wall : roof;
    for (let i = 1; i + 1 < lifted.length; i++) {
      b.triangle(lifted[0]!, lifted[i]!, lifted[i + 1]!, color, true);
    }
  }

  for (const ring of framed.flat()) {
    for (let i = 0; i + 1 < ring.length; i++) {
      const p = ring[i]!;
      const q = ring[i + 1]!;
      const ts = [0, 1];
      for (const [a, bb, c] of lines) {
        const sp = a * p[0] + bb * p[1] + c;
        const sq = a * q[0] + bb * q[1] + c;
        if (sp * sq < 0) ts.push(sp / (sp - sq));
      }
      ts.sort((x, y) => x - y);
      for (let k = 0; k + 1 < ts.length; k++) {
        const at = (t: number): Vec2 => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
        const pa = at(ts[k]!);
        const pb = at(ts[k + 1]!);
        if (heightAt(profile, ...pa) < 1e-6 && heightAt(profile, ...pb) < 1e-6) continue;
        b.quad(ground(pa), ground(pb), lift(pb), lift(pa), wall);
      }
    }
  }
  return b.build();
}
