import { BoxGeometry, BufferGeometry, CylinderGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

type Vec3 = [number, number, number];

/** Wires sag by this share of their span at the middle. */
const SAG = 0.03;

const box = (w: number, h: number, d: number, y: number) =>
  new BoxGeometry(w, h, d).translate(0, y, 0).toNonIndexed();

/**
 * A support of unit height, arms along x (laid across the line when placed): a tapering
 * steel pylon with two cross-arms, or a pole with one.
 */
export function supportGeometry(kind: 'tower' | 'pole'): BufferGeometry {
  const parts =
    kind === 'tower'
      ? [
          // Square, tapering body (a lattice from afar).
          new CylinderGeometry(0.025, 0.11, 1, 4, 1, false, Math.PI / 4)
            .translate(0, 0.5, 0)
            .toNonIndexed(),
          box(0.5, 0.02, 0.03, 0.72),
          box(0.34, 0.02, 0.03, 0.86),
        ]
      : [
          new CylinderGeometry(0.012, 0.02, 1, 6).translate(0, 0.5, 0).toNonIndexed(),
          box(0.2, 0.012, 0.012, 0.95),
        ];
  const merged = mergeGeometries(parts.map((g) => g.deleteAttribute('uv')));
  if (!merged) throw new Error('power support geometry');
  merged.computeVertexNormals();
  return merged;
}

/** Where the wires hang on a support of unit height: (across the line, height). */
export function attachments(kind: 'tower' | 'pole'): [number, number][] {
  return kind === 'tower'
    ? [
        [-0.24, 0.71],
        [0.24, 0.71],
        [0, 0.99],
      ]
    : [
        [-0.09, 0.94],
        [0.09, 0.94],
        [0, 1],
      ];
}

/** A wire from `a` to `b` (x, y up, z) as `steps` segments, sagging in the middle. */
export function sagCurve(a: Vec3, b: Vec3, steps: number): Vec3[] {
  const sag = SAG * Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  return Array.from({ length: steps + 1 }, (_, k): Vec3 => {
    const t = k / steps;
    if (k === 0) return [...a];
    if (k === steps) return [...b];
    return [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t - 4 * sag * t * (1 - t),
      a[2] + (b[2] - a[2]) * t,
    ];
  });
}
