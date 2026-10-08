import { describe, expect, it } from 'vitest';
import { roofFrame, type Vec2 } from '../../src/roofs/geometry/frame';
import type { RoofMesh } from '../../src/roofs/geometry/mesh';
import { buildProfileRoof, creaseLines, profilePlanes } from '../../src/roofs/geometry/profiles';
import { PROFILE_SHAPES, type ProfileShape } from '../../src/roofs/schema';

const RED: [number, number, number] = [1, 0, 0];
const GREY: [number, number, number] = [0.5, 0.5, 0.5];

const rect = (w: number, d: number, cx = 0, cz = 0): Vec2[] => [
  [cx - w / 2, cz - d / 2],
  [cx + w / 2, cz - d / 2],
  [cx + w / 2, cz + d / 2],
  [cx - w / 2, cz + d / 2],
];

function roof(shape: ProfileShape, polygons: Vec2[][][], H = 5, direction?: number) {
  const frame = roofFrame(polygons[0]![0]!, direction);
  return buildProfileRoof(polygons, frame, profilePlanes(shape, H, frame.L, frame.W), RED, GREY);
}

/** Area covered by up-facing triangles, projected onto the ground. */
function roofArea(m: RoofMesh): number {
  let area = 0;
  for (let i = 0; i < m.positions.length; i += 9) {
    if (m.normals[i + 1]! <= 1e-6) continue;
    const [ax, , az, bx, , bz, cx, , cz] = m.positions.slice(i, i + 9) as number[];
    area += Math.abs((bx! - ax!) * (cz! - az!) - (cx! - ax!) * (bz! - az!)) / 2;
  }
  return area;
}

const ys = (m: RoofMesh) => m.positions.filter((_, i) => i % 3 === 1);
const verticalFaces = (m: RoofMesh) =>
  m.normals.filter((_, i) => i % 9 === 1).filter((ny) => Math.abs(ny) < 1e-6).length;

describe('profile roofs', () => {
  it.each(PROFILE_SHAPES)('%s covers the footprint exactly, between 0 and H', (shape) => {
    const m = roof(shape, [[rect(40, 20)]]);
    expect(roofArea(m)).toBeCloseTo(800, 3);
    expect(Math.max(...ys(m))).toBeLessThanOrEqual(5 + 1e-9);
    expect(Math.min(...ys(m))).toBeGreaterThanOrEqual(-1e-9);
  });

  it('gabled: ridge along the long axis at full height, gable ends closed', () => {
    const m = roof('gabled', [[rect(40, 20)]]);
    const top: Vec2[] = [];
    for (let i = 0; i < m.positions.length; i += 3) {
      if (Math.abs(m.positions[i + 1]! - 5) < 1e-9)
        top.push([m.positions[i]!, m.positions[i + 2]!]);
    }
    expect(top.every(([, z]) => Math.abs(z) < 1e-9)).toBe(true);
    expect(Math.max(...top.map(([x]) => x))).toBeCloseTo(20, 9);
    expect(verticalFaces(m)).toBeGreaterThan(0);
  });

  it('hipped: ridge shortened by the hips, no vertical faces on a rectangle', () => {
    const m = roof('hipped', [[rect(40, 20)]]);
    const topX: number[] = [];
    for (let i = 0; i < m.positions.length; i += 3) {
      if (Math.abs(m.positions[i + 1]! - 5) < 1e-9) topX.push(Math.abs(m.positions[i]!));
    }
    expect(Math.max(...topX)).toBeCloseTo(10, 9);
    expect(verticalFaces(m)).toBe(0);
  });

  it('skillion: high on the back side, low toward the bearing it faces', () => {
    const m = roof('skillion', [[rect(40, 20)]], 5, 180); // faces south (+z)
    for (let i = 0; i < m.positions.length; i += 3) {
      const z = m.positions[i + 2]!;
      const y = m.positions[i + 1]!;
      if (Math.abs(z + 10) < 1e-9 && m.normals[i + 1]! > 0) expect(y).toBeCloseTo(5, 9);
      if (Math.abs(z - 10) < 1e-9) expect(y).toBeCloseTo(0, 9);
    }
  });

  it('never roofs over a courtyard', () => {
    const outer = rect(30, 30);
    const hole = rect(10, 10).reverse();
    const m = roof('hipped', [[outer, hole]]);
    expect(roofArea(m)).toBeCloseTo(800, 3);
    for (let i = 0; i < m.positions.length; i += 9) {
      if (m.normals[i + 1]! <= 1e-6) continue;
      const cx = (m.positions[i]! + m.positions[i + 3]! + m.positions[i + 6]!) / 3;
      const cz = (m.positions[i + 2]! + m.positions[i + 5]! + m.positions[i + 8]!) / 3;
      expect(Math.abs(cx) < 5 && Math.abs(cz) < 5).toBe(false);
    }
  });

  it('closes concave outlines with vertical faces and keeps their area', () => {
    const L: Vec2[] = [
      [0, 0],
      [30, 0],
      [30, 10],
      [10, 10],
      [10, 30],
      [0, 30],
    ];
    const m = roof('gabled', [[L]]);
    expect(roofArea(m)).toBeCloseTo(500, 3);
    expect(verticalFaces(m)).toBeGreaterThan(0);
  });

  it('roofs every polygon of a multipolygon', () => {
    const m = roof('gabled', [[rect(20, 10)], [rect(20, 10, 0, 40)]]);
    expect(roofArea(m)).toBeCloseTo(400, 3);
  });

  it('butterfly: eaves at H on both long sides, valley at 0 down the middle', () => {
    const m = roof('butterfly', [[rect(40, 20)]]);
    for (let i = 0; i < m.positions.length; i += 3) {
      if (m.normals[i + 1]! <= 1e-6) continue;
      const z = m.positions[i + 2]!;
      expect(m.positions[i + 1]!).toBeCloseTo((5 * Math.abs(z)) / 10, 9);
    }
    expect(verticalFaces(m)).toBeGreaterThan(0);
  });

  it('crosspitched: gable ends on all four sides, one apex at H', () => {
    const m = roof('crosspitched', [[rect(40, 20)]]);
    const apex: Vec2[] = [];
    for (let i = 0; i < m.positions.length; i += 3) {
      if (Math.abs(m.positions[i + 1]! - 5) < 1e-9)
        apex.push([m.positions[i]!, m.positions[i + 2]!]);
    }
    // The two ridges meet only at the centre; each reaches its own pair of walls.
    expect(apex.some(([x, z]) => Math.abs(x) > 19 && Math.abs(z) < 1e-9)).toBe(true);
    expect(apex.some(([x, z]) => Math.abs(z) > 9 && Math.abs(x) < 1e-9)).toBe(true);
    const sides = new Set<string>();
    for (let i = 0; i < m.normals.length; i += 9) {
      if (Math.abs(m.normals[i + 1]!) > 1e-6) continue;
      sides.add([Math.round(m.normals[i]!), Math.round(m.normals[i + 2]!)].join());
    }
    expect(sides.size).toBe(4);
  });

  it('sawtooth: whole teeth across the roof, glazing in the wall colour', () => {
    const m = roof('sawtooth', [[rect(40, 24)]], 3); // 24 m across → three 8 m teeth
    const peaks = new Set<number>();
    for (let i = 0; i < m.positions.length; i += 3) {
      if (Math.abs(m.positions[i + 1]! - 3) < 1e-9) peaks.add(Math.round(m.positions[i + 2]!));
    }
    expect([...peaks].sort((a, b) => a - b)).toEqual([-12, -4, 4]);
    let glazing = 0;
    for (let i = 0; i < m.positions.length; i += 9) {
      const ny = m.normals[i + 1]!;
      if (ny > 1e-6 && ny < 0.1) {
        glazing++;
        expect(Array.from(m.colors.slice(i, i + 3))).toEqual(GREY);
      }
    }
    expect(glazing).toBeGreaterThan(0);
  });

  it('dedupes crease lines and drops ones that miss the footprint', () => {
    expect(creaseLines(profilePlanes('gabled', 5, 20, 10), [-20, -10, 20, 10])).toHaveLength(1);
    expect(creaseLines(profilePlanes('skillion', 5, 20, 10), [-20, -10, 20, 10])).toHaveLength(0);
    expect(creaseLines(profilePlanes('gabled', 5, 20, 10), [-20, 1, 20, 10])).toHaveLength(0);
    // Sawtooth: only real creases (two per inner tooth), not every pair of planes.
    expect(creaseLines(profilePlanes('sawtooth', 3, 20, 24), [-20, -24, 20, 24])).toHaveLength(10);
  });
});
