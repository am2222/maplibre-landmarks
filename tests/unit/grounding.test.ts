import { describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, type BufferAttribute } from 'three';
import { localPosition, originAt } from '../../src/core/mercator';
import type { LngLat } from '../../src/core/types';
import { Grounding } from '../../src/landmarks/grounding';

const ANCHOR: LngLat = [2.2945, 48.8584];
const origin = originAt(ANCHOR);
/** Terrain rising 0.1 m per metre eastward, 100 m at the anchor. */
const slope = (ll: LngLat) => 100 + 0.1 * localPosition(origin, ll)[0];

/** A 10 m cube standing on the ground plane (y 0..10), centred on the anchor. */
function cube() {
  const geometry = new BoxGeometry(10, 10, 10).translate(0, 5, 0);
  const mesh = new Mesh(geometry, new MeshStandardMaterial());
  return { root: new Group().add(mesh), mesh };
}

const ys = (mesh: Mesh, where: (x: number, y: number) => boolean) => {
  const p = mesh.geometry.attributes.position as BufferAttribute;
  const out: number[] = [];
  for (let i = 0; i < p.count; i++) if (where(p.getX(i), p.getY(i))) out.push(p.getY(i));
  return out;
};

describe('Grounding', () => {
  it('lowers downhill footing onto the terrain and leaves uphill footing alone', () => {
    const { root, mesh } = cube();
    const g = new Grounding(root, ANCHOR);
    expect(g.sampleCount).toBe(4); // the cube's four bottom corners
    g.update(slope, 100);
    // West edge (x = -5): terrain at 99.5 → 0.75 m below the anchor plane, minus the 0.25 m sink.
    for (const y of ys(mesh, (x, y) => x < 0 && y < 5)) expect(y).toBeCloseTo(-0.75, 2);
    // East edge: terrain is higher than the footing, so it stays at 0 (hidden inside the hill).
    for (const y of ys(mesh, (x, y) => x > 0 && y < 5)) expect(y).toBe(0);
    // The roof never moves.
    for (const y of ys(mesh, (_x, y) => y > 5)) expect(y).toBe(10);
    expect(mesh.geometry.boundingBox!.min.y).toBeCloseTo(-0.75, 2);
  });

  it('refits from the authored footing and restores it without terrain', () => {
    const { root, mesh } = cube();
    const g = new Grounding(root, ANCHOR);
    g.update(slope, 100);
    g.update(() => 90, 100); // terrain dropped 10 m everywhere
    for (const y of ys(mesh, (_x, y) => y < 5)) expect(y).toBeCloseTo(-10.25, 2);
    g.update(null, 100);
    for (const y of ys(mesh, (_x, y) => y < 5)) expect(y).toBe(0);
  });

  it('skips unknown samples', () => {
    const { root, mesh } = cube();
    new Grounding(root, ANCHOR).update(() => null, 100);
    for (const y of ys(mesh, (_x, y) => y < 5)) expect(y).toBe(0);
  });

  it('works in each mesh frame and unshares shared geometry', () => {
    const geometry = new BoxGeometry(2, 2, 2); // centred: bottom at y = -1 in mesh space
    const lifted = new Mesh(geometry, new MeshStandardMaterial());
    lifted.position.set(-4, 1, 0); // bottom on the ground, west of the anchor
    const roof = new Mesh(geometry, new MeshStandardMaterial());
    roof.position.set(4, 9, 0); // shares the geometry, far above the ground
    const root = new Group().add(lifted, roof);
    new Grounding(root, ANCHOR).update(slope, 100);
    expect(roof.geometry).not.toBe(lifted.geometry);
    // x = -5..-3 → terrain 99.5..99.7 → footing at about -0.75..-0.55 (mesh space: -1.75..-1.55).
    const bottom = ys(lifted, (_x, y) => y < 0);
    expect(Math.min(...bottom)).toBeCloseTo(-1.75, 2);
    expect(Math.max(...bottom)).toBeCloseTo(-1.55, 2);
    for (const y of ys(roof, () => true)) expect(Math.abs(y)).toBe(1); // untouched
  });
});
