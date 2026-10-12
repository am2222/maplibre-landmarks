import {
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3,
  type Material,
} from 'three';
import { EARTH_RADIUS_M, localPosition, mercatorX, mercatorY, originAt } from '../core/mercator';
import type { PreparedModel } from './models/prepare';
import type { PlacedTree } from './select';

const EARTH_CIRCUMFERENCE_M = 2 * Math.PI * EARTH_RADIUS_M;
/** Per-instance attributes the tree material reads, one float each. */
const INSTANCE_ATTRIBUTES = ['aTint', 'aPhase', 'aBorn'] as const;

/** Mark the first `instances` of an instanced attribute for upload, and nothing past them. */
function upload(attribute: InstancedBufferAttribute, instances: number): void {
  attribute.clearUpdateRanges();
  attribute.addUpdateRange(0, instances * attribute.itemSize);
  attribute.needsUpdate = true;
}

/**
 * Sway phase from the tree's absolute position (float64 on the CPU), so it never changes when the
 * batch anchor moves and neighbouring trees stay coherent.
 */
function swayPhase([lng, lat]: [number, number]): number {
  const x = mercatorX(lng) * EARTH_CIRCUMFERENCE_M;
  const y = mercatorY(lat) * EARTH_CIRCUMFERENCE_M;
  const p = (x * 0.13 + y * 0.07) % (2 * Math.PI);
  return p < 0 ? p + 2 * Math.PI : p;
}

/** Instanced meshes for every (model × variant) plus one impostor mesh per model. */
export class TreeBatches {
  readonly group = new Group();
  private near: InstancedMesh[][] = [];
  private far: InstancedMesh[] = [];
  private total = 0;
  /** When each drawn tree first appeared (seconds, the shader's clock): it rises from then. */
  private born = new Map<string, number>();
  /** Latest appearance time written (trees still rise until this plus the rise time). */
  lastBorn = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly material: Material,
    private readonly capacity: number,
  ) {}

  get drawn(): number {
    return this.total;
  }

  setModels(models: PreparedModel[]): void {
    this.clearMeshes();
    this.near = models.map((m) => m.variants.map((v) => this.mesh(v.geometry)));
    this.far = models.map((m) => this.mesh(m.impostor.geometry));
  }

  write(
    trees: PlacedTree[],
    anchor: [number, number],
    elevation: (p: [number, number]) => number = () => 0,
    now = performance.now() / 1000,
  ): { near: number; far: number; drawn: number } {
    const born = new Map<string, number>();
    const all = this.meshes();
    for (const mesh of all) mesh.count = 0;
    const origin = originAt(anchor);
    const m = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    const pos = new Vector3();
    const scale = new Vector3();
    let near = 0;
    let far = 0;
    for (const t of trees) {
      const variants = this.near[t.model];
      if (!variants?.length) continue;
      const mesh = t.far ? this.far[t.model]! : variants[t.variant % variants.length]!;
      const i = mesh.count;
      if (i >= this.capacity || near + far >= this.capacity) continue;
      const [x, y, z] = localPosition(origin, t.lngLat, elevation(t.lngLat));
      m.compose(pos.set(x, y, z), q.setFromAxisAngle(up, t.rotation), scale.setScalar(t.scale));
      mesh.setMatrixAt(i, m);
      (mesh.geometry.getAttribute('aTint') as InstancedBufferAttribute).setX(i, t.tint);
      (mesh.geometry.getAttribute('aPhase') as InstancedBufferAttribute).setX(
        i,
        swayPhase(t.lngLat),
      );
      // A tree already drawn keeps its time (a LOD switch does not make it rise again).
      const at = this.born.get(t.key) ?? now;
      born.set(t.key, at);
      if (at === now) this.lastBorn = now;
      (mesh.geometry.getAttribute('aBorn') as InstancedBufferAttribute).setX(i, at);
      mesh.count = i + 1;
      if (t.far) far++;
      else near++;
    }
    // Send only the instances written (buffers hold `capacity`); an empty mesh is not drawn.
    for (const mesh of all) {
      if (!mesh.count) continue;
      upload(mesh.instanceMatrix, mesh.count);
      for (const name of INSTANCE_ATTRIBUTES)
        upload(mesh.geometry.getAttribute(name) as InstancedBufferAttribute, mesh.count);
    }
    this.born = born;
    this.total = near + far;
    return { near, far, drawn: this.total };
  }

  dispose(): void {
    this.clearMeshes();
  }

  private mesh(geometry: InstancedMesh['geometry']): InstancedMesh {
    for (const name of INSTANCE_ATTRIBUTES)
      geometry.setAttribute(
        name,
        new InstancedBufferAttribute(new Float32Array(this.capacity), 1).setUsage(DynamicDrawUsage),
      );
    const mesh = new InstancedMesh(geometry, this.material, this.capacity);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage); // rewritten on every update
    mesh.count = 0;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    return mesh;
  }

  private meshes(): InstancedMesh[] {
    return [...this.near.flat(), ...this.far];
  }

  private clearMeshes(): void {
    for (const mesh of this.meshes()) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
      mesh.dispose();
    }
    this.near = [];
    this.far = [];
    this.total = 0;
  }
}
