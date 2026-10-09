/*
 * Radial roofs derived from OSMBuildings (src/triangulate/split.js and roofs/index.js, commit
 * 55e22a6). Copyright (c) 2018, Jan Marsch, OSM Buildings. BSD-2-Clause; see LICENSE.
 */
import type { Vec2 } from './frame';
import type { MeshBuilder, RGB, Vec3 } from './mesh';

const DOME_STEPS = 12;
/** Points around a dome or onion ring. */
const LATHE_POINTS = 48;
/** OSMBuildings' onion profile: radius scale and height scale per ring. */
const ONION: [r: number, h: number][] = [
  [0.8, 0],
  [0.9, 0.18],
  [0.9, 0.35],
  [0.8, 0.47],
  [0.6, 0.59],
  [0.5, 0.65],
  [0.2, 0.82],
  [0, 1],
];

/**
 * Rings shrinking toward `center` (radius scale and height per ring in `profile`). The lowest
 * ring is the outline itself, so the roof meets every wall; going up, the rings round off to a
 * circle of radius `R` (like a dome on a square drum). On a round outline: a surface of
 * revolution.
 */
function lathe(
  b: MeshBuilder,
  outer: Vec2[],
  [cx, cz]: Vec2,
  R: number,
  profile: [number, number][],
  color: RGB,
) {
  outer = subdivide(outer, LATHE_POINTS);
  const top = Math.max(...profile.map(([, h]) => h)) || 1;
  const at = ([x, z]: Vec2, r: number, h: number): Vec3 => {
    const [dx, dz] = [x - cx, z - cz];
    const d = Math.hypot(dx, dz) || 1;
    const round = Math.min(1, (1.5 * h) / top); // 0: the outline; round from 2/3 up
    const s = r * (1 - round + (round * R) / d);
    return [cx + dx * s, h, cz + dz * s];
  };
  for (let i = 0; i + 1 < profile.length; i++) {
    const [r0, h0] = profile[i]!;
    const [r1, h1] = profile[i + 1]!;
    for (let k = 0; k < outer.length; k++) {
      const p = outer[k]!;
      const q = outer[(k + 1) % outer.length]!;
      b.quad(at(p, r0, h0), at(q, r0, h0), at(q, r1, h1), at(p, r1, h1), color);
    }
  }
}

/** The outline with long edges split, about `n` points in all (a box has only four). */
function subdivide(ring: Vec2[], n: number): Vec2[] {
  const len = (i: number) => {
    const [p, q] = [ring[i]!, ring[(i + 1) % ring.length]!];
    return Math.hypot(q[0] - p[0], q[1] - p[1]);
  };
  const perimeter = ring.reduce((sum, _, i) => sum + len(i), 0);
  if (!(perimeter > 0)) return ring;
  const out: Vec2[] = [];
  ring.forEach((p, i) => {
    const q = ring[(i + 1) % ring.length]!;
    const k = Math.max(1, Math.round((len(i) / perimeter) * n));
    for (let j = 0; j < k; j++)
      out.push([p[0] + ((q[0] - p[0]) * j) / k, p[1] + ((q[1] - p[1]) * j) / k]);
  });
  return out;
}

/** Every outer edge sloping up to an apex above `center`. */
export function pyramidRoof(b: MeshBuilder, outer: Vec2[], [cx, cz]: Vec2, H: number, color: RGB) {
  for (let i = 0; i < outer.length; i++) {
    const p = outer[i]!;
    const q = outer[(i + 1) % outer.length]!;
    b.triangle([p[0], 0, p[1]], [q[0], 0, q[1]], [cx, H, cz], color, true);
  }
}

export function domeRoof(
  b: MeshBuilder,
  outer: Vec2[],
  center: Vec2,
  R: number,
  H: number,
  color: RGB,
) {
  const profile: [number, number][] = [];
  for (let i = 0; i <= DOME_STEPS; i++) {
    const t = (i / DOME_STEPS) * (Math.PI / 2);
    profile.push([Math.cos(t), H * Math.sin(t)]);
  }
  lathe(b, outer, center, R, profile, color);
}

export function onionRoof(
  b: MeshBuilder,
  outer: Vec2[],
  center: Vec2,
  R: number,
  H: number,
  color: RGB,
) {
  lathe(
    b,
    outer,
    center,
    R,
    ONION.map(([r, h]) => [r, h * H]),
    color,
  );
}
