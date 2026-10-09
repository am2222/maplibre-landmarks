import { describe, expect, it } from 'vitest';
import { HttpError } from '../../src/landmarks/catalogue';
import { treeModelFromGLB } from '../../src/trees/models/glb';
import { mergeParts } from '../../src/trees/models/procedural';
import type { TreeParts } from '../../src/trees/models/types';
import { makeGlb } from './glb-fixture';
import { fakeFetch } from './helpers';

const GLB_URL = 'https://assets.test/trees/palm.glb';
const GLB = makeGlb([
  { material: 'bark', positions: [0, 0, 0, 0.2, 0, 0, 0, 2, 0] },
  { material: 'leaves', positions: [-1, 2, 0, 1, 2, 0, 0, 4, 0] },
  { material: 'misc', positions: [-1, 3, 0, 1, 3, 0, 0, 3.5, 0] },
]);

describe('treeModelFromGLB', () => {
  it('splits meshes into trunk and foliage by material name', async () => {
    const model = treeModelFromGLB(GLB_URL, {
      trunk: ['bark'],
      foliage: ['leaves'],
      fetch: fakeFetch({ [GLB_URL]: GLB }),
    });
    expect(model.id).toBe('palm');
    expect(model.variants).toBe(1);
    const parts = (await model.build(1)) as TreeParts;
    expect(parts.trunk.getAttribute('position').count).toBe(3);
    // Leaves + unlisted misc, one clump per mesh.
    expect(mergeParts([parts.foliage].flat()).getAttribute('position').count).toBe(6);
  });

  it('loads the file once and passes tones through', async () => {
    const f = fakeFetch({ [GLB_URL]: GLB });
    const model = treeModelFromGLB(GLB_URL, {
      id: 'my-palm',
      trunk: ['bark'],
      foliage: ['leaves'],
      fetch: f,
      trunkTone: 1.5,
    });
    const a = (await model.build(1)) as TreeParts;
    await model.build(2);
    expect(f.calls).toEqual([GLB_URL]);
    expect(model.id).toBe('my-palm');
    expect(a.trunkTone).toBe(1.5);
  });

  it('rejects with HttpError when the file is missing', async () => {
    const model = treeModelFromGLB(GLB_URL, { trunk: [], foliage: [], fetch: fakeFetch({}) });
    await expect(model.build(1)).rejects.toBeInstanceOf(HttpError);
  });
});
