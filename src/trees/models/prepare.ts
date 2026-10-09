import { Box3, BufferAttribute, Vector3, type BufferGeometry } from 'three';
import { hashString, seededRand } from '../hash';
import { defaultImpostor, mergeParts } from './procedural';
import type { TreeModel, TreeParts } from './types';

export interface PreparedVariant {
  geometry: BufferGeometry;
  height: number;
  radius: number;
  triangles: number;
}

export interface PreparedModel {
  id: string;
  variants: PreparedVariant[];
  impostor: PreparedVariant;
}

/** aLeaf for a model: -1 evergreen, else the share of trees that blossom in spring. */
export function leafValue(model: Pick<TreeModel, 'leafCycle' | 'blossom'>): number {
  if (model.leafCycle === 'evergreen') return -1;
  return Math.min(1, Math.max(0, model.blossom ?? 0));
}

/**
 * Merge trunk + foliage and add the tree material's attributes: aPart / aShade / aHeight, aClump
 * (each leaf clump's centre and the point in leaf fall it drops at) and aLeaf (see leafValue).
 */
export function prepareVariant(parts: TreeParts, seed: number, leaf = 0): PreparedVariant {
  const trunk = mergeParts([parts.trunk]);
  const clumps = (Array.isArray(parts.foliage) ? parts.foliage : [parts.foliage]).map((g) =>
    mergeParts([g]),
  );
  const trunkCount = trunk.getAttribute('position').count;
  const geometry = mergeParts([trunk, ...clumps]);
  geometry.computeVertexNormals();
  const pos = geometry.getAttribute('position');
  const n = pos.count;
  geometry.computeBoundingBox();
  const height = Math.max(geometry.boundingBox!.max.y, 1e-3);
  const part = new Float32Array(n);
  const shade = new Float32Array(n);
  const h = new Float32Array(n);
  const rand = seededRand(seed ^ 0x5bd1e995);
  const clump = new Float32Array(n * 4);
  const dropRand = seededRand(seed ^ 0x2c1b3c6d);
  const box = new Box3();
  const centre = new Vector3();
  let start = trunkCount;
  for (const g of clumps) {
    const count = g.getAttribute('position').count;
    if (!count) continue;
    box.setFromBufferAttribute(g.getAttribute('position') as BufferAttribute).getCenter(centre);
    const drop = dropRand();
    for (let i = start; i < start + count; i++)
      clump.set([centre.x, centre.y, centre.z, drop], i * 4);
    start += count;
  }
  let radius = 0;
  for (let tri = 0; tri < n / 3; tri++) {
    const s = 0.85 + 0.3 * rand();
    for (let k = 0; k < 3; k++) {
      const i = tri * 3 + k;
      const isFoliage = i >= trunkCount;
      part[i] = isFoliage ? 1 : 0;
      shade[i] = s * (isFoliage ? (parts.foliageTone ?? 1) : (parts.trunkTone ?? 1));
      h[i] = Math.min(1, Math.max(0, pos.getY(i) / height));
      radius = Math.max(radius, Math.hypot(pos.getX(i), pos.getZ(i)));
    }
  }
  geometry.setAttribute('aPart', new BufferAttribute(part, 1));
  geometry.setAttribute('aShade', new BufferAttribute(shade, 1));
  geometry.setAttribute('aHeight', new BufferAttribute(h, 1));
  geometry.setAttribute('aClump', new BufferAttribute(clump, 4));
  geometry.setAttribute('aLeaf', new BufferAttribute(new Float32Array(n).fill(leaf), 1));
  return { geometry, height, radius, triangles: n / 3 };
}

export async function prepareModel(model: TreeModel): Promise<PreparedModel> {
  const count = Math.max(1, Math.floor(model.variants ?? 4));
  const base = hashString(model.id);
  const leaf = leafValue(model);
  const variants: PreparedVariant[] = [];
  for (let i = 0; i < count; i++) {
    const seed = (base + i * 7919) | 0;
    variants.push(prepareVariant(await model.build(seed), seed, leaf));
  }
  const v0 = variants[0]!;
  const impostorParts = model.impostor
    ? await model.impostor()
    : defaultImpostor(
        v0.height,
        Math.max(v0.radius, 0.5),
        model.id.includes('conifer') || model.leafCycle === 'evergreen',
      );
  return {
    id: model.id,
    variants,
    impostor: prepareVariant(impostorParts, base ^ 0x1234, leaf),
  };
}

export function disposePrepared(m: PreparedModel): void {
  for (const v of [...m.variants, m.impostor]) v.geometry.dispose();
}
