import {
  Matrix4,
  Vector3,
  type BufferAttribute,
  type BufferGeometry,
  type Mesh,
  type Object3D,
} from 'three';
import { lngLatAt, originAt } from '../core/mercator';
import type { LngLat } from '../core/types';

/** Vertices this close to the model's ground plane (metres) are its footing. */
const CONTACT_M = 0.05;
/** Footing is pushed this far below the terrain so no sliver of sky shows under it. */
const SINK_M = 0.25;

/** Terrain elevation in metres (as drawn, exaggeration included), or null where unknown. */
export type ElevationSampler = (lngLat: LngLat) => number | null | undefined;

interface Contact {
  index: number;
  /** Position in the model's root space, as authored. */
  original: Vector3;
  sample: { lngLat: LngLat; elevation: number | null };
}

interface Part {
  geometry: BufferGeometry;
  /** Root space → this mesh's geometry space. */
  toLocal: Matrix4;
  contacts: Contact[];
}

/**
 * Stretches a model's footing down onto sloping terrain: each ground-level vertex is lowered to
 * the terrain under it (never raised), so the downhill side stops floating. Positions are always
 * recomputed from the authored ones, so the fit can be redone or undone at any time.
 */
export class Grounding {
  private readonly parts: Part[] = [];
  private readonly samples = new Map<string, { lngLat: LngLat; elevation: number | null }>();
  private readonly scratch = new Vector3();

  constructor(root: Object3D, anchor: LngLat) {
    root.updateMatrixWorld(true);
    const rootInverse = new Matrix4().copy(root.matrixWorld).invert();
    const meshes: Mesh[] = [];
    root.traverse((o) => {
      const m = o as Mesh & { isInstancedMesh?: boolean };
      if (m.isMesh && !m.isInstancedMesh && m.geometry?.attributes.position) meshes.push(m);
    });
    const origin = originAt(anchor);
    const seen = new Set<BufferGeometry>();
    for (const mesh of meshes) {
      // A geometry shared by several meshes would be bent once per mesh: give each its own.
      if (seen.has(mesh.geometry)) mesh.geometry = mesh.geometry.clone();
      seen.add(mesh.geometry);
      const toRoot = new Matrix4().multiplyMatrices(rootInverse, mesh.matrixWorld);
      const position = mesh.geometry.attributes.position as BufferAttribute;
      const contacts: Contact[] = [];
      for (let i = 0; i < position.count; i++) {
        const p = new Vector3().fromBufferAttribute(position, i).applyMatrix4(toRoot);
        if (p.y > CONTACT_M) continue;
        const key = `${p.x.toFixed(3)},${p.z.toFixed(3)}`;
        let sample = this.samples.get(key);
        if (!sample) {
          sample = { lngLat: lngLatAt(origin, p.x, p.z), elevation: null };
          this.samples.set(key, sample);
        }
        contacts.push({ index: i, original: p, sample });
      }
      if (contacts.length) {
        this.parts.push({ geometry: mesh.geometry, toLocal: toRoot.clone().invert(), contacts });
      }
    }
  }

  /** Number of distinct terrain samples one fit costs. */
  get sampleCount(): number {
    return this.samples.size;
  }

  /**
   * Fit the footing to terrain around a model placed at `anchorElevation`. Without a sampler
   * (terrain off) the authored footing is restored.
   */
  update(sample: ElevationSampler | null, anchorElevation: number): void {
    for (const s of this.samples.values()) {
      const e = sample?.(s.lngLat);
      s.elevation = typeof e === 'number' && Number.isFinite(e) ? e : null;
    }
    for (const { geometry, toLocal, contacts } of this.parts) {
      const position = geometry.attributes.position as BufferAttribute;
      for (const { index, original, sample: s } of contacts) {
        const p = this.scratch.copy(original);
        if (s.elevation !== null) p.y = Math.min(p.y, s.elevation - anchorElevation - SINK_M);
        p.applyMatrix4(toLocal);
        position.setXYZ(index, p.x, p.y, p.z);
      }
      position.needsUpdate = true;
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
    }
  }
}
