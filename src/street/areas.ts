import { ShapeUtils, Vector2 } from 'three';
import type { MeshBuilder, RGB, Vec3 } from '../roofs/geometry/mesh';

/** Local metres: x east, z south (glTF axes, y up). */
export type Vec2 = [number, number];

const open = (ring: Vec2[]): Vec2[] => {
  const [f, l] = [ring[0], ring.at(-1)];
  return ring.length > 1 && f && l && f[0] === l[0] && f[1] === l[1] ? ring.slice(0, -1) : ring;
};

/** A flat face over rings (outer first, then holes) at height `y`, facing up. */
function face(b: MeshBuilder, rings: Vec2[][], y: number, colour: RGB): void {
  const [outer, ...holes] = rings.map((ring) => open(ring).map(([x, z]) => new Vector2(x, z)));
  if (!outer || outer.length < 3) return;
  // three drops repeated end points from these arrays in place: index into them afterwards.
  const triangles = ShapeUtils.triangulateShape(outer, holes);
  const vertices = [outer, ...holes].flat();
  const at = (i: number): Vec3 => [vertices[i]!.x, y, vertices[i]!.y];
  for (const [i, j, k] of triangles) b.triangle(at(i!), at(j!), at(k!), colour, true);
}

/** Upright walls along every ring from `bottom` to `top` (drawn double-sided). */
function walls(b: MeshBuilder, rings: Vec2[][], bottom: number, top: number, colour: RGB): void {
  for (const ring of rings.map(open))
    ring.forEach(([x0, z0], i) => {
      const [x1, z1] = ring[(i + 1) % ring.length]!;
      b.quad([x0, bottom, z0], [x1, bottom, z1], [x1, top, z1], [x0, top, z0], colour);
    });
}

/** A block over a polygon, from the ground to `top` (platforms, pier decks, quays). */
export function slab(b: MeshBuilder, rings: Vec2[][], top: number, colour: RGB): void {
  walls(b, rings, 0, top, colour);
  face(b, rings, top, colour);
}

/** A fountain basin: a rim of height `rim` around the outline, holding water at `water`. */
export function basin(
  b: MeshBuilder,
  rings: Vec2[][],
  rim: number,
  water: number,
  stone: RGB,
  waterColour: RGB,
): void {
  walls(b, rings, 0, rim, stone);
  face(b, rings, water, waterColour);
}

/** A line widened to `width` (a pier mapped as a line): a deck block per segment. */
export function strip(b: MeshBuilder, line: Vec2[], width: number, top: number, colour: RGB): void {
  for (let i = 0; i + 1 < line.length; i++) {
    const [x0, z0] = line[i]!;
    const [x1, z1] = line[i + 1]!;
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 1e-6) continue;
    // Half the width across the segment.
    const [nx, nz] = [(-(z1 - z0) / len) * (width / 2), ((x1 - x0) / len) * (width / 2)];
    slab(
      b,
      [
        [
          [x0 + nx, z0 + nz],
          [x1 + nx, z1 + nz],
          [x1 - nx, z1 - nz],
          [x0 - nx, z0 - nz],
        ],
      ],
      top,
      colour,
    );
  }
}
