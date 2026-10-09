import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, InstancedMesh, Matrix4, MeshBasicMaterial, Vector3 } from 'three';
import { TreeBatches } from '../../src/trees/batches';
import { prepareVariant, type PreparedModel } from '../../src/trees/models/prepare';
import type { PlacedTree } from '../../src/trees/select';

const box = () =>
  prepareVariant({ trunk: new BoxGeometry(0.2, 1, 0.2), foliage: new BoxGeometry(1, 1, 1) }, 1);
const model = (id: string, variants: number): PreparedModel => ({
  id,
  variants: Array.from({ length: variants }, box),
  impostor: box(),
});
const C: [number, number] = [2.29, 48.85];
const kx = 111_195 * Math.cos((C[1] * Math.PI) / 180);
const tree = (over: Partial<PlacedTree>): PlacedTree => ({
  key: 'k',
  lngLat: C,
  distanceM: 0,
  far: false,
  model: 0,
  variant: 0,
  scale: 1,
  rotation: 0,
  tint: 0.5,
  ...over,
});

describe('TreeBatches', () => {
  it('creates one mesh per model variant plus one impostor per model', () => {
    const b = new TreeBatches(new MeshBasicMaterial(), 10);
    b.setModels([model('a', 2), model('b', 1)]);
    expect(b.group.children).toHaveLength(2 + 1 + 2);
    expect(b.group.children.every((c) => (c as InstancedMesh).count === 0)).toBe(true);
  });

  it('writes instances relative to the anchor, splits LODs and writes tints', () => {
    const b = new TreeBatches(new MeshBasicMaterial(), 10);
    b.setModels([model('a', 2)]);
    const counts = b.write(
      [
        tree({ key: 'near', lngLat: [C[0] + 100 / kx, C[1]], variant: 1, tint: 0.25, scale: 2 }),
        tree({ key: 'far', far: true }),
      ],
      C,
    );
    expect(counts).toEqual({ near: 1, far: 1, drawn: 2 });
    const [v0, v1, imp] = b.group.children as InstancedMesh[];
    expect(v0!.count).toBe(0);
    expect(v1!.count).toBe(1);
    expect(imp!.count).toBe(1);
    const m = new Matrix4();
    v1!.getMatrixAt(0, m);
    const p = new Vector3().setFromMatrixPosition(m);
    expect(p.x).toBeCloseTo(100, 0);
    expect(new Vector3().setFromMatrixScale(m).x).toBeCloseTo(2, 5);
    expect(v1!.geometry.getAttribute('aTint').getX(0)).toBe(0.25);
  });

  it('adds terrain elevation and clamps to capacity', () => {
    const b = new TreeBatches(new MeshBasicMaterial(), 2);
    b.setModels([model('a', 1)]);
    const counts = b.write(
      [tree({ key: '1' }), tree({ key: '2' }), tree({ key: '3' })],
      C,
      () => 12,
    );
    expect(counts.drawn).toBe(2);
    const m = new Matrix4();
    (b.group.children[0] as InstancedMesh).getMatrixAt(0, m);
    expect(new Vector3().setFromMatrixPosition(m).y).toBe(12);
  });

  it('disposes meshes and geometries', () => {
    const b = new TreeBatches(new MeshBasicMaterial(), 2);
    const m = model('a', 1);
    b.setModels([m]);
    const spy = vi.spyOn(m.variants[0]!.geometry, 'dispose');
    b.dispose();
    expect(spy).toHaveBeenCalled();
    expect(b.group.children).toHaveLength(0);
  });

  it('writes a sway phase that does not change when the anchor moves (review #3)', () => {
    const b = new TreeBatches(new MeshBasicMaterial(), 4);
    b.setModels([model('a', 1)]);
    const t = tree({ key: 'p', lngLat: [C[0] + 30 / kx, C[1]] });
    const mesh = b.group.children[0] as InstancedMesh;
    b.write([t], C);
    const first = mesh.geometry.getAttribute('aPhase').getX(0);
    b.write([t], [C[0] + 500 / kx, C[1] + 0.002]);
    expect(mesh.geometry.getAttribute('aPhase').getX(0)).toBeCloseTo(first, 6);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(2 * Math.PI);
  });

  it('records when each tree first appeared, kept while it stays drawn', () => {
    const b = new TreeBatches(new MeshBasicMaterial(), 4);
    b.setModels([model('a', 1)]);
    const mesh = b.group.children[0] as InstancedMesh;
    const born = (i: number) => mesh.geometry.getAttribute('aBorn').getX(i);
    b.write([tree({ key: 'a' })], C, undefined, 10);
    expect(born(0)).toBe(10);
    b.write([tree({ key: 'a' }), tree({ key: 'b' })], C, undefined, 12);
    expect([born(0), born(1)]).toEqual([10, 12]);
    b.write([tree({ key: 'b' })], C, undefined, 13); // 'a' left
    b.write([tree({ key: 'a' }), tree({ key: 'b' })], C, undefined, 14);
    expect([born(0), born(1)]).toEqual([14, 12]); // 'a' rises again
    expect(b.lastBorn).toBe(14);
  });
});
