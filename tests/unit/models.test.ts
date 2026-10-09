import { describe, expect, it } from 'vitest';
import { BoxGeometry, type BufferGeometry } from 'three';
import {
  birch,
  conifer,
  deciduous,
  defaultImpostor,
  mergeParts,
} from '../../src/trees/models/procedural';
import { leafValue, prepareModel, prepareVariant } from '../../src/trees/models/prepare';
import type { TreeModel, TreeParts } from '../../src/trees/models/types';

const positions = (g: BufferGeometry | BufferGeometry[]) =>
  Array.from(mergeParts([g].flat()).getAttribute('position').array as Float32Array);

describe('procedural models', () => {
  for (const model of [conifer, deciduous, birch]) {
    it(`${model.id} is deterministic per seed and differs across seeds`, () => {
      const a = model.build(42) as TreeParts;
      const b = model.build(42) as TreeParts;
      const c = model.build(43) as TreeParts;
      expect(positions(a.foliage)).toEqual(positions(b.foliage));
      expect(positions(a.foliage)).not.toEqual(positions(c.foliage));
    });

    it(`${model.id} produces valid parts standing on y = 0`, () => {
      const parts = model.build(7) as TreeParts;
      for (const g of [parts.trunk, parts.foliage]) {
        const p = positions(g);
        expect(p.length).toBeGreaterThan(0);
        expect(p.every(Number.isFinite)).toBe(true);
      }
      parts.trunk.computeBoundingBox();
      expect(parts.trunk.boundingBox!.min.y).toBeCloseTo(0, 2);
    });

    it(`${model.id} keeps its leaves as separate clumps`, () => {
      const parts = model.build(7) as TreeParts;
      expect(Array.isArray(parts.foliage) && parts.foliage.length).toBeGreaterThan(3);
    });

    it(`${model.id} variants stay within 400 triangles`, () => {
      for (let seed = 0; seed < 20; seed++) {
        expect(prepareVariant(model.build(seed) as TreeParts, seed).triangles).toBeLessThanOrEqual(
          400,
        );
      }
    });
  }

  it('impostors stay within 24 triangles', () => {
    expect(prepareVariant(defaultImpostor(12, 2, true), 1).triangles).toBeLessThanOrEqual(24);
    expect(prepareVariant(defaultImpostor(8, 3, false), 1).triangles).toBeLessThanOrEqual(24);
  });

  it('mergeParts handles an empty list', () => {
    expect(mergeParts([]).getAttribute('position').count).toBe(0);
  });
});

describe('prepareVariant', () => {
  const parts: TreeParts = {
    trunk: new BoxGeometry(0.2, 2, 0.2).translate(0, 1, 0),
    foliage: new BoxGeometry(2, 2, 2).translate(0, 3, 0),
    trunkTone: 2,
  };

  it('tags trunk then foliage vertices and normalises height', () => {
    const v = prepareVariant(parts, 1);
    const part = v.geometry.getAttribute('aPart').array as Float32Array;
    const h = v.geometry.getAttribute('aHeight').array as Float32Array;
    expect(part[0]).toBe(0);
    expect(part[part.length - 1]).toBe(1);
    expect(v.height).toBeCloseTo(4, 5);
    expect(v.radius).toBeCloseTo(Math.SQRT2, 5);
    expect(Math.min(...h)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...h)).toBeCloseTo(1, 5);
    expect(v.geometry.getAttribute('normal')).toBeDefined();
    expect(v.triangles).toBe(24);
  });

  it('applies part tones to the shade', () => {
    const v = prepareVariant(parts, 1);
    const shade = v.geometry.getAttribute('aShade').array as Float32Array;
    expect(shade[0]).toBeGreaterThan(1.6); // trunk: 0.85–1.15 × tone 2
    expect(shade[shade.length - 1]).toBeLessThan(1.2); // foliage: tone 1
  });
});

describe('prepareVariant leaf clumps', () => {
  const clumps: TreeParts = {
    trunk: new BoxGeometry(0.2, 2, 0.2).translate(0, 1, 0),
    foliage: [
      new BoxGeometry(1, 1, 1).translate(-2, 3, 0),
      new BoxGeometry(1, 1, 1).translate(2, 4, 0),
    ],
  };
  const clumpOf = (v: ReturnType<typeof prepareVariant>, vertex: number) =>
    Array.from(
      (v.geometry.getAttribute('aClump').array as Float32Array).slice(vertex * 4, vertex * 4 + 4),
    );

  it('gives each clump its centre and its own drop threshold', () => {
    const v = prepareVariant(clumps, 1);
    const trunkCount = 36;
    const a = clumpOf(v, trunkCount);
    const b = clumpOf(v, trunkCount + 36);
    expect(a.slice(0, 3)).toEqual([-2, 3, 0]);
    expect(b.slice(0, 3)).toEqual([2, 4, 0]);
    expect(clumpOf(v, trunkCount + 35)).toEqual(a);
    expect(a[3]).not.toBe(b[3]);
    expect(a[3]).toBeGreaterThanOrEqual(0);
    expect(a[3]).toBeLessThan(1);
  });

  it('writes the leaf cycle on every vertex: -1 evergreen, else the blossom share', () => {
    const leaf = (v: ReturnType<typeof prepareVariant>) =>
      new Set(v.geometry.getAttribute('aLeaf').array as Float32Array);
    expect(leaf(prepareVariant(clumps, 1))).toEqual(new Set([0]));
    expect(leaf(prepareVariant(clumps, 1, -1))).toEqual(new Set([-1]));
    expect(leafValue({ leafCycle: 'evergreen', blossom: 0.5 })).toBe(-1);
    expect(leafValue({ blossom: 0.25 })).toBe(0.25);
    expect(leafValue({ blossom: 3 })).toBe(1);
    expect(leafValue({})).toBe(0);
  });

  it('marks the built-in models: conifers evergreen, deciduous blossoming', async () => {
    const first = async (m: TreeModel) =>
      (await prepareModel(m)).variants[0]!.geometry.getAttribute('aLeaf').getX(0);
    expect(await first(conifer)).toBe(-1);
    expect(await first(deciduous)).toBe(0.25);
    expect(await first(birch)).toBe(0);
  });
});

describe('prepareModel', () => {
  it('builds 4 variants and a default impostor', async () => {
    const m = await prepareModel(conifer);
    expect(m.id).toBe('conifer');
    expect(m.variants).toHaveLength(4);
    expect(m.impostor.triangles).toBeLessThanOrEqual(24);
  });

  it('supports async builds and custom impostors', async () => {
    const custom: TreeModel = {
      id: 'box',
      variants: 2,
      build: async () => ({ trunk: new BoxGeometry(1, 1, 1), foliage: new BoxGeometry(1, 1, 1) }),
      impostor: () => ({ trunk: mergeParts([]), foliage: new BoxGeometry(1, 1, 1) }),
    };
    const m = await prepareModel(custom);
    expect(m.variants).toHaveLength(2);
    expect(m.impostor.triangles).toBe(12);
  });
});
