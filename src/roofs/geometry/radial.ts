/*
 * Radial roofs derived from OSMBuildings (src/triangulate/split.js and roofs/index.js, commit
 * 55e22a6). Copyright (c) 2018, Jan Marsch, OSM Buildings. BSD-2-Clause; see LICENSE.
 */
import type { Vec2 } from './frame';
import type { MeshBuilder, RGB, Vec3 } from './mesh';

const DOME_STEPS = 12;
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
 * Rings of the outline scaled toward `center` (radius scale and height per ring in `profile`):
 * a surface of revolution on a round outline, and on any other the same profile stretched to
 * meet every wall (a half-round apse gets a half dome, not a circle that misses part of it).
 */
function lathe(
  b: MeshBuilder,
  outer: Vec2[],
  [cx, cz]: Vec2,
  profile: [number, number][],
  color: RGB,
) {
  const at = ([x, z]: Vec2, r: number, h: number): Vec3 => [
    cx + (x - cx) * r,
    h,
    cz + (z - cz) * r,
  ];
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

/** Every outer edge sloping up to an apex above `center`. */
export function pyramidRoof(b: MeshBuilder, outer: Vec2[], [cx, cz]: Vec2, H: number, color: RGB) {
  for (let i = 0; i < outer.length; i++) {
    const p = outer[i]!;
    const q = outer[(i + 1) % outer.length]!;
    b.triangle([p[0], 0, p[1]], [q[0], 0, q[1]], [cx, H, cz], color, true);
  }
}

export function domeRoof(b: MeshBuilder, outer: Vec2[], center: Vec2, H: number, color: RGB) {
  const profile: [number, number][] = [];
  for (let i = 0; i <= DOME_STEPS; i++) {
    const t = (i / DOME_STEPS) * (Math.PI / 2);
    profile.push([Math.cos(t), H * Math.sin(t)]);
  }
  lathe(b, outer, center, profile, color);
}

export function onionRoof(b: MeshBuilder, outer: Vec2[], center: Vec2, H: number, color: RGB) {
  lathe(
    b,
    outer,
    center,
    ONION.map(([r, h]) => [r, h * H]),
    color,
  );
}
