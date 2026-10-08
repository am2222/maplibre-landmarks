import { BufferGeometry, Float32BufferAttribute, Vector3, type Matrix4 } from 'three';
import { EARTH_RADIUS_M } from '../core/mercator';
import type { Origin } from '../core/types';

export const MAX_SLICES = 64;
/** Horizontal period of the fog noise, metres (the noise tiles at exactly this period). */
export const NOISE_PERIOD_M = 4096;

/** Centres of `count` equal altitude bands from `floor` to `ceiling` (lowest first), and the band height. */
export function layerAltitudes(
  floor: number,
  ceiling: number,
  count: number,
): { altitudes: number[]; step: number } {
  const step = Math.max(1e-3, ceiling - floor) / count;
  return { altitudes: Array.from({ length: count }, (_, i) => floor + step * (i + 0.5)), step };
}

/** Layer draw order for blending: farthest from the camera's altitude first (back to front). */
export function layerOrder(altitudes: number[], cameraAltitude: number): number[] {
  return altitudes
    .map((a, i) => ({ i, d: Math.abs(a - cameraAltitude) }))
    .sort((x, y) => y.d - x.d || x.i - y.i)
    .map(({ i }) => i);
}

/** Quad indices drawing the layers in `order`. */
export function indexFor(order: number[]): number[] {
  return order.flatMap((s) => {
    const b = s * 4;
    return [b, b + 1, b + 2, b, b + 2, b + 3];
  });
}

/** `count` unit quads (corners ±1) tagged with their layer; the module sets the draw order. */
export function buildSliceGeometry(count: number): BufferGeometry {
  const corners: number[] = [];
  const slices: number[] = [];
  for (let s = 0; s < count; s++) {
    corners.push(-1, -1, 1, -1, 1, 1, -1, 1);
    slices.push(s, s, s, s);
  }
  const index: number[] = [];
  for (let s = count - 1; s >= 0; s--) {
    const b = s * 4;
    index.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const g = new BufferGeometry();
  g.setAttribute('aCorner', new Float32BufferAttribute(corners, 2));
  g.setAttribute('aSlice', new Float32BufferAttribute(slices, 1));
  // three sizes draws from `position`; the shader ignores it.
  g.setAttribute('position', new Float32BufferAttribute(new Array(count * 12).fill(0), 3));
  g.setIndex(index);
  return g;
}

export const MAX_RINGS = 32;

/** `count` ring radii from `inner` to `outer`, each `ratio` times the previous (dense near the camera). */
export function ringRadii(
  inner: number,
  outer: number,
  count: number,
): { radii: number[]; ratio: number } {
  const ratio = Math.max(1 + 1e-6, outer / inner) ** (1 / Math.max(1, count - 1));
  return { radii: Array.from({ length: count }, (_, i) => inner * ratio ** i), ratio };
}

/**
 * `count` upright rings of `segments` wall quads: `aCorner` is (turn 0..1, bottom 0 / top 1) and
 * `aSlice` the ring. The vertex shader centres them on the camera; the largest is drawn first.
 */
export function buildRingGeometry(count: number, segments: number): BufferGeometry {
  const corners: number[] = [];
  const rings: number[] = [];
  const columns = segments + 1;
  for (let r = 0; r < count; r++)
    for (let c = 0; c < columns; c++) {
      corners.push(c / segments, 0, c / segments, 1);
      rings.push(r, r);
    }
  const index: number[] = [];
  for (let r = count - 1; r >= 0; r--)
    for (let c = 0; c < segments; c++) {
      const b = (r * columns + c) * 2;
      index.push(b, b + 2, b + 3, b, b + 3, b + 1);
    }
  const g = new BufferGeometry();
  g.setAttribute('aCorner', new Float32BufferAttribute(corners, 2));
  g.setAttribute('aSlice', new Float32BufferAttribute(rings, 1));
  g.setAttribute('position', new Float32BufferAttribute(new Array(rings.length * 3).fill(0), 3));
  g.setIndex(index);
  return g;
}

export interface CameraBasis {
  position: Vector3;
  right: Vector3;
  up: Vector3;
  forward: Vector3;
  /** Tangents of the half field of view. */
  tanX: number;
  tanY: number;
  /** Off-centre shift of the view (map padding), as view-space tangents. */
  offX: number;
  offY: number;
}

/** Camera position and unit axes (its world matrix may carry a uniform scale). */
export function cameraBasis(matrixWorld: Matrix4, projection: Matrix4): CameraBasis {
  const e = matrixWorld.elements;
  const p = projection.elements;
  return {
    position: new Vector3(e[12], e[13], e[14]),
    right: new Vector3(e[0], e[1], e[2]).normalize(),
    up: new Vector3(e[4], e[5], e[6]).normalize(),
    forward: new Vector3(-e[8], -e[9], -e[10]).normalize(),
    tanX: 1 / p[0]!,
    tanY: 1 / p[5]!,
    offX: p[8]! / p[0]!,
    offY: p[9]! / p[5]!,
  };
}

/** Mercator units per noise metre: equator metres, the same everywhere on the map. */
const NOISE_UNIT = 1 / (2 * Math.PI * EARTH_RADIUS_M);

/**
 * Noise frame of the map origin: its position in equator metres (wrapped to the noise period in
 * float64, before reaching the GPU) and the factor turning local ground metres into noise metres.
 * Ground metres per mercator unit change with the latitude of the map centre; equator metres do
 * not, so a point keeps its noise when the centre moves north or south.
 */
export function noiseOrigin(origin: Origin): [x: number, z: number, scale: number] {
  const wrap = (m: number) => ((m % NOISE_PERIOD_M) + NOISE_PERIOD_M) % NOISE_PERIOD_M;
  return [wrap(origin.x / NOISE_UNIT), wrap(origin.y / NOISE_UNIT), origin.scale / NOISE_UNIT];
}
