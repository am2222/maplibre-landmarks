import type { Material, Mesh, Object3D, WebGLRenderer } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { absoluteUrl, HttpError, type Fetch, type LodRef } from './catalogue';

export function isAbort(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === 'AbortError';
}

/** Gzip file (decompressed client-side) first, raw GLB as fallback. */
export async function fetchGlb(
  lod: LodRef,
  baseUrl: string,
  fetchFn: Fetch,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  if (lod.gzip && typeof DecompressionStream !== 'undefined') {
    try {
      const res = await fetchFn(absoluteUrl(baseUrl, lod.gzip.url), { signal });
      if (res.ok && res.body) {
        const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
        return await new Response(stream).arrayBuffer();
      }
    } catch (err) {
      if (isAbort(err) || signal?.aborted) throw err;
    }
  }
  const url = absoluteUrl(baseUrl, lod.url);
  const res = await fetchFn(url, { signal });
  if (!res.ok) throw new HttpError(res.status, url);
  return res.arrayBuffer();
}

export interface DecoderOptions {
  /** Folder with three's `draco_decoder` files; enables KHR_draco_mesh_compression. */
  dracoDecoderPath?: string;
  /** Folder with three's `basis_transcoder` files; enables KHR_texture_basisu (KTX2). */
  ktx2TranscoderPath?: string;
}

/**
 * glTF parser with compressed-content decoders. Meshopt is always on (pure JS); Draco and
 * KTX2 need hosted decoder files, so they load only when their path is given.
 */
export class GlbParser {
  private loader?: Promise<GLTFLoader>;
  private disposers: (() => void)[] = [];

  constructor(
    private readonly opts: DecoderOptions = {},
    /** Needed for KTX2 to pick a GPU texture format; KTX2 stays off without it. */
    private readonly renderer?: unknown,
  ) {}

  async parse(buffer: ArrayBuffer): Promise<Object3D> {
    const loader = await (this.loader ??= this.create());
    const gltf = await loader.parseAsync(buffer, '');
    return gltf.scene;
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    this.loader = undefined;
  }

  private async create(): Promise<GLTFLoader> {
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const { dracoDecoderPath, ktx2TranscoderPath } = this.opts;
    if (dracoDecoderPath) {
      const { DRACOLoader } = await import('three/addons/loaders/DRACOLoader.js');
      const draco = new DRACOLoader().setDecoderPath(dracoDecoderPath);
      loader.setDRACOLoader(draco);
      this.disposers.push(() => draco.dispose());
    }
    if (ktx2TranscoderPath && (this.renderer as Partial<WebGLRenderer> | undefined)?.extensions) {
      const { KTX2Loader } = await import('three/addons/loaders/KTX2Loader.js');
      const ktx2 = new KTX2Loader()
        .setTranscoderPath(ktx2TranscoderPath)
        .detectSupport(this.renderer as WebGLRenderer);
      loader.setKTX2Loader(ktx2);
      this.disposers.push(() => ktx2.dispose());
    }
    return loader;
  }
}

let defaultParser: GlbParser | undefined;

export function parseGlb(buffer: ArrayBuffer): Promise<Object3D> {
  defaultParser ??= new GlbParser();
  return defaultParser.parse(buffer);
}

export function disposeObject(root: Object3D): void {
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    for (const m of ([] as Material[]).concat(mesh.material)) m.dispose();
  });
}

export interface CachedModel {
  object: Object3D;
  bytes: number;
}

/** LRU of parsed models that are not currently resident. */
export class ModelCache {
  private readonly map = new Map<string, CachedModel>();
  private total = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number,
    readonly dispose: (object: Object3D) => void = disposeObject,
  ) {}

  get size(): number {
    return this.map.size;
  }

  get bytes(): number {
    return this.total;
  }

  take(key: string): CachedModel | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    this.map.delete(key);
    this.total -= hit.bytes;
    return hit;
  }

  put(key: string, object: Object3D, bytes: number): void {
    const old = this.map.get(key);
    if (old) {
      this.map.delete(key);
      this.total -= old.bytes;
      if (old.object !== object) this.dispose(old.object);
    }
    this.map.set(key, { object, bytes });
    this.total += bytes;
    while (this.map.size > this.maxEntries || (this.total > this.maxBytes && this.map.size > 0)) {
      const [oldestKey, oldest] = this.map.entries().next().value as [string, CachedModel];
      this.map.delete(oldestKey);
      this.total -= oldest.bytes;
      this.dispose(oldest.object);
    }
  }

  clear(): void {
    for (const { object } of this.map.values()) this.dispose(object);
    this.map.clear();
    this.total = 0;
  }
}
