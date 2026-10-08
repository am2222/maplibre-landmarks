import type { BufferGeometry, Material, Mesh } from 'three';
import { globalFetch, HttpError, type Fetch } from '../../landmarks/catalogue';
import { disposeObject, parseGlb } from '../../landmarks/loader';
import { mergeParts } from './procedural';
import type { TreeModel, TreeParts } from './types';

export interface GlbTreeOptions {
  /** Defaults to the file name without extension. */
  id?: string;
  /** Material names that are leaves (unlisted materials also count as foliage). */
  foliage: string[];
  /** Material names that are bark/trunk. */
  trunk: string[];
  fetch?: Fetch;
  trunkTone?: number;
  foliageTone?: number;
}

/** Wrap a GLB asset (metres, Y up, base at 0) as a single-variant, theme-coloured TreeModel. */
export function treeModelFromGLB(url: string, opts: GlbTreeOptions): TreeModel {
  const fetchFn = opts.fetch ?? globalFetch;
  let parts: Promise<TreeParts> | undefined;
  const load = async (): Promise<TreeParts> => {
    const res = await fetchFn(url);
    if (!res.ok) throw new HttpError(res.status, url);
    const root = await parseGlb(await res.arrayBuffer());
    root.updateMatrixWorld(true);
    const trunk: BufferGeometry[] = [];
    const foliage: BufferGeometry[] = [];
    root.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      const material = ([] as Material[]).concat(mesh.material)[0];
      const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
      (opts.trunk.includes(material?.name ?? '') ? trunk : foliage).push(geometry);
    });
    disposeObject(root);
    return {
      trunk: mergeParts(trunk),
      foliage: mergeParts(foliage),
      trunkTone: opts.trunkTone,
      foliageTone: opts.foliageTone,
    };
  };
  const fileName = url.split('?')[0]!.split('/').pop() ?? 'tree';
  return {
    id: opts.id ?? fileName.replace(/\.[^.]*$/, ''),
    variants: 1,
    build: () => (parts ??= load()),
  };
}
