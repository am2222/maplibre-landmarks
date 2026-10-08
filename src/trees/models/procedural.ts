import {
  BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  Euler,
  Float32BufferAttribute,
  IcosahedronGeometry,
  Matrix4,
  OctahedronGeometry,
  Quaternion,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { seededRand } from '../hash';
import type { TreeModel, TreeParts } from './types';

type Vec3 = [number, number, number];

function placed(g: BufferGeometry, pos: Vec3, rot: Vec3 = [0, 0, 0]): BufferGeometry {
  const m = new Matrix4().compose(
    new Vector3(...pos),
    new Quaternion().setFromEuler(new Euler(...rot)),
    new Vector3(1, 1, 1),
  );
  return g.applyMatrix4(m);
}

/** Merge into one non-indexed, position-only geometry (normals are recomputed later). */
export function mergeParts(geoms: BufferGeometry[]): BufferGeometry {
  const clean = geoms.map((g) => {
    const flat = g.index ? g.toNonIndexed() : g;
    const out = new BufferGeometry();
    out.setAttribute('position', flat.getAttribute('position'));
    return out;
  });
  if (!clean.length) {
    const empty = new BufferGeometry();
    empty.setAttribute('position', new Float32BufferAttribute([], 3));
    return empty;
  }
  const merged = mergeGeometries(clean);
  if (!merged) throw new Error('mergeGeometries failed');
  return merged;
}

/** Conifer: tapered, slightly irregular trunk + 4 layered, offset cones (from the CodePen). */
export const conifer: TreeModel = {
  id: 'conifer',
  build(seed): TreeParts {
    const rand = seededRand(seed);
    const trunkH = 3.0 + rand() * 1.5;
    const trunk = new CylinderGeometry(0.25, 0.55, trunkH, 6);
    const tpos = trunk.getAttribute('position');
    for (let i = 0; i < tpos.count; i++) {
      const r = 0.92 + rand() * 0.16;
      tpos.setX(i, tpos.getX(i) * r);
      tpos.setZ(i, tpos.getZ(i) * r);
    }
    trunk.translate(0, trunkH / 2, 0);
    const cones: BufferGeometry[] = [];
    for (let i = 0; i < 4; i++) {
      const t = i / 3;
      const radius = (2.2 - t * 1.5) * (0.85 + rand() * 0.3);
      const height = (3.5 - t * 1.5) * (0.85 + rand() * 0.3);
      const sides = 6 + Math.floor(rand() * 3);
      const pos: Vec3 = [
        (rand() - 0.5) * 0.4,
        trunkH + 1 + i * (height * 0.55),
        (rand() - 0.5) * 0.4,
      ];
      cones.push(
        placed(new ConeGeometry(radius, height, sides), pos, [0, rand() * Math.PI * 2, 0]),
      );
    }
    return { trunk: mergeParts([trunk]), foliage: mergeParts(cones), foliageTone: 0.8 };
  },
};

/** Deciduous: bent trunk + lumpy crown of icosphere lobes (from the CodePen). */
export const deciduous: TreeModel = {
  id: 'deciduous',
  build(seed): TreeParts {
    const rand = seededRand(seed);
    const trunkH = 2.5 + rand() * 1.2;
    const trunk = new CylinderGeometry(0.3, 0.6, trunkH, 6);
    let bx = rand() - 0.5;
    let bz = rand() - 0.5;
    const blen = Math.hypot(bx, bz);
    if (blen < 1e-6) {
      bx = 1;
      bz = 0;
    } else {
      bx /= blen;
      bz /= blen;
    }
    const tpos = trunk.getAttribute('position');
    for (let i = 0; i < tpos.count; i++) {
      // Clamp: float rounding can give -2e-16 at the base, and pow(negative, 1.5) is NaN.
      const yNorm = Math.min(1, Math.max(0, (tpos.getY(i) + trunkH / 2) / trunkH));
      const bend = Math.pow(yNorm, 1.5) * 0.4;
      tpos.setX(i, tpos.getX(i) + bx * bend);
      tpos.setZ(i, tpos.getZ(i) + bz * bend);
    }
    trunk.translate(0, trunkH / 2, 0);
    const centre: Vec3 = [bx * 0.4, trunkH + 1.6, bz * 0.4];
    const lobes: BufferGeometry[] = [];
    const lobeCount = 5 + Math.floor(rand() * 3);
    for (let i = 0; i < lobeCount; i++) {
      const angle = (i / lobeCount) * Math.PI * 2 + rand() * 0.5;
      const dist = 0.6 + rand() * 0.9;
      const lobeR = 1.2 + rand() * 1.0;
      const pos: Vec3 = [
        centre[0] + Math.cos(angle) * dist,
        centre[1] + (rand() - 0.3) * 0.8,
        centre[2] + Math.sin(angle) * dist,
      ];
      lobes.push(
        placed(new IcosahedronGeometry(lobeR, 0), pos, [
          rand() * Math.PI,
          rand() * Math.PI,
          rand() * Math.PI,
        ]),
      );
    }
    lobes.push(
      placed(new IcosahedronGeometry(1.5 + rand() * 0.5, 0), centre, [
        rand() * Math.PI,
        rand() * Math.PI,
        rand() * Math.PI,
      ]),
    );
    return { trunk: mergeParts([trunk]), foliage: mergeParts(lobes) };
  },
};

/** Birch: slim pale trunk + small round crown (from the CodePen). */
export const birch: TreeModel = {
  id: 'birch',
  build(seed): TreeParts {
    const rand = seededRand(seed);
    const trunkH = 4 + rand() * 1.5;
    const trunk = new CylinderGeometry(0.18, 0.28, trunkH, 6).translate(0, trunkH / 2, 0);
    const baseY = trunkH + 1;
    const lobes: BufferGeometry[] = [];
    const count = 4 + Math.floor(rand() * 2);
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      const pos: Vec3 = [
        Math.cos(angle) * 0.7,
        baseY + (rand() - 0.5) * 0.5,
        Math.sin(angle) * 0.7,
      ];
      lobes.push(placed(new IcosahedronGeometry(0.9 + rand() * 0.4, 0), pos));
    }
    lobes.push(placed(new IcosahedronGeometry(1.0, 0), [0, baseY, 0]));
    return {
      trunk: mergeParts([trunk]),
      foliage: mergeParts(lobes),
      trunkTone: 2.4,
      foliageTone: 1.25,
    };
  },
};

/** Cheap far-LOD stand-in: 6-sided cone (12 tris) or octahedron on an open 3-sided trunk (14 tris). */
export function defaultImpostor(height: number, radius: number, conical: boolean): TreeParts {
  if (conical) {
    return {
      trunk: mergeParts([]),
      foliage: mergeParts([new ConeGeometry(radius, height, 6).translate(0, height / 2, 0)]),
    };
  }
  const trunkH = height * 0.45;
  return {
    trunk: mergeParts([
      new CylinderGeometry(radius * 0.1, radius * 0.12, trunkH, 3, 1, true).translate(
        0,
        trunkH / 2,
        0,
      ),
    ]),
    foliage: mergeParts([new OctahedronGeometry(radius * 0.9, 0).translate(0, height * 0.65, 0)]),
  };
}
