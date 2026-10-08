import { BufferAttribute, type BufferGeometry } from 'three';
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

/** Merge trunk + foliage and add aPart / aShade / aHeight for the tree material. */
export function prepareVariant(parts: TreeParts, seed: number): PreparedVariant {
  const trunk = mergeParts([parts.trunk]);
  const foliage = mergeParts([parts.foliage]);
  const trunkCount = trunk.getAttribute('position').count;
  const geometry = mergeParts([trunk, foliage]);
  geometry.computeVertexNormals();
  const pos = geometry.getAttribute('position');
  const n = pos.count;
  geometry.computeBoundingBox();
  const height = Math.max(geometry.boundingBox!.max.y, 1e-3);
  const part = new Float32Array(n);
  const shade = new Float32Array(n);
  const h = new Float32Array(n);
  const rand = seededRand(seed ^ 0x5bd1e995);
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
  return { geometry, height, radius, triangles: n / 3 };
}

export async function prepareModel(model: TreeModel): Promise<PreparedModel> {
  const count = Math.max(1, Math.floor(model.variants ?? 4));
  const base = hashString(model.id);
  const variants: PreparedVariant[] = [];
  for (let i = 0; i < count; i++) {
    const seed = (base + i * 7919) | 0;
    variants.push(prepareVariant(await model.build(seed), seed));
  }
  const v0 = variants[0]!;
  const impostorParts = model.impostor
    ? await model.impostor()
    : defaultImpostor(v0.height, Math.max(v0.radius, 0.5), model.id.includes('conifer'));
  return { id: model.id, variants, impostor: prepareVariant(impostorParts, base ^ 0x1234) };
}

export function disposePrepared(m: PreparedModel): void {
  for (const v of [...m.variants, m.impostor]) v.geometry.dispose();
}
