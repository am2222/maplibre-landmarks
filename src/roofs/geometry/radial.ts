/*
 * Radial roofs derived from OSMBuildings (src/triangulate/split.js and roofs/index.js, commit
 * 55e22a6). Copyright (c) 2018, Jan Marsch, OSM Buildings. BSD-2-Clause; see LICENSE.
 */
import type { Vec2 } from './frame';
import type { MeshBuilder, RGB, Vec3 } from './mesh';

const SEGMENTS = 32;
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

/** Surface of revolution around `center`: `profile` holds radius scales and heights. */
function lathe(b: MeshBuilder, [cx, cz]: Vec2, R: number, profile: [number, number][], color: RGB) {
  const at = (r: number, h: number, s: number): Vec3 => {
    const a = (s / SEGMENTS) * 2 * Math.PI;
    return [cx + R * r * Math.sin(a), h, cz + R * r * Math.cos(a)];
  };
  for (let i = 0; i + 1 < profile.length; i++) {
    const [r0, h0] = profile[i]!;
    const [r1, h1] = profile[i + 1]!;
    for (let s = 0; s < SEGMENTS; s++) {
      b.quad(at(r0, h0, s), at(r0, h0, s + 1), at(r1, h1, s + 1), at(r1, h1, s), color);
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

export function domeRoof(b: MeshBuilder, center: Vec2, R: number, H: number, color: RGB) {
  const profile: [number, number][] = [];
  for (let i = 0; i <= DOME_STEPS; i++) {
    const t = (i / DOME_STEPS) * (Math.PI / 2);
    profile.push([Math.cos(t), H * Math.sin(t)]);
  }
  lathe(b, center, R, profile, color);
}

export function onionRoof(b: MeshBuilder, center: Vec2, R: number, H: number, color: RGB) {
  lathe(
    b,
    center,
    R,
    ONION.map(([r, h]) => [r, h * H]),
    color,
  );
}
