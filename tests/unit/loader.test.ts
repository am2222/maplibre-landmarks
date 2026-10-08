import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Group, type Mesh, type Material } from 'three';
import type { LodRef } from '../../src/landmarks/catalogue';
import { HttpError } from '../../src/landmarks/catalogue';
import { disposeObject, fetchGlb, ModelCache, parseGlb } from '../../src/landmarks/loader';
import { BASE } from './fixtures';
import { fakeFetch } from './helpers';

const RAW = new Uint8Array([1, 2, 3, 4, 5]);
const lod: LodRef = { url: '/m/low.glb', bytes: 5, gzip: { url: '/m/low.glb.gz', bytes: 20 } };
const rawUrl = `${BASE}/m/low.glb`;
const gzUrl = `${BASE}/m/low.glb.gz`;

afterEach(() => vi.unstubAllGlobals());

describe('fetchGlb', () => {
  it('downloads and decompresses the gzip file', async () => {
    const f = fakeFetch({ [gzUrl]: new Uint8Array(gzipSync(RAW)) });
    const buf = await fetchGlb(lod, BASE, f);
    expect(new Uint8Array(buf)).toEqual(RAW);
    expect(f.calls).toEqual([gzUrl]);
  });

  it('falls back to the raw GLB when gzip fails', async () => {
    const f = fakeFetch({ [gzUrl]: 500, [rawUrl]: RAW });
    expect(new Uint8Array(await fetchGlb(lod, BASE, f))).toEqual(RAW);
  });

  it('falls back to the raw GLB when gzip data is corrupt', async () => {
    const f = fakeFetch({ [gzUrl]: new Uint8Array([9, 9, 9]), [rawUrl]: RAW });
    expect(new Uint8Array(await fetchGlb(lod, BASE, f))).toEqual(RAW);
  });

  it('uses the raw GLB without DecompressionStream', async () => {
    vi.stubGlobal('DecompressionStream', undefined);
    const f = fakeFetch({ [rawUrl]: RAW });
    expect(new Uint8Array(await fetchGlb(lod, BASE, f))).toEqual(RAW);
    expect(f.calls).toEqual([rawUrl]);
  });

  it('propagates aborts without falling back', async () => {
    const f = fakeFetch({ [gzUrl]: new Uint8Array(gzipSync(RAW)), [rawUrl]: RAW });
    const c = new AbortController();
    c.abort();
    await expect(fetchGlb(lod, BASE, f, c.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.calls).toEqual([gzUrl]);
  });

  it('throws HttpError when the raw GLB is missing', async () => {
    const f = fakeFetch({});
    await expect(fetchGlb({ url: '/m/low.glb', bytes: 5 }, BASE, f)).rejects.toBeInstanceOf(
      HttpError,
    );
  });
});

describe('parseGlb', () => {
  it('parses a real Open Landmarks model with its own colours', async () => {
    const bytes = readFileSync(new URL('../fixtures/cnit-low.glb', import.meta.url));
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const scene = await parseGlb(buffer);
    const meshes: Mesh[] = [];
    scene.traverse((o) => {
      if ((o as Mesh).isMesh) meshes.push(o as Mesh);
    });
    expect(meshes.length).toBeGreaterThan(0);
    const names = meshes.flatMap((m) => ([] as Material[]).concat(m.material).map((x) => x.name));
    expect(names).toContain('stone');
  });
});

describe('ModelCache', () => {
  const obj = () => new Group();

  it('evicts least recently used entries over the count limit', () => {
    const dispose = vi.fn();
    const cache = new ModelCache(2, 1e9, dispose);
    const a = obj();
    cache.put('a', a, 1);
    cache.put('b', obj(), 1);
    cache.put('c', obj(), 1);
    expect(cache.size).toBe(2);
    expect(dispose).toHaveBeenCalledWith(a);
  });

  it('evicts over the byte budget', () => {
    const dispose = vi.fn();
    const cache = new ModelCache(10, 100, dispose);
    cache.put('a', obj(), 60);
    cache.put('b', obj(), 60);
    expect(cache.size).toBe(1);
    expect(cache.bytes).toBe(60);
  });

  it('take removes without disposing', () => {
    const dispose = vi.fn();
    const cache = new ModelCache(10, 100, dispose);
    const a = obj();
    cache.put('a', a, 10);
    expect(cache.take('a')).toEqual({ object: a, bytes: 10 });
    expect(cache.take('a')).toBeUndefined();
    expect(cache.bytes).toBe(0);
    expect(dispose).not.toHaveBeenCalled();
  });

  it('replacing a key disposes the old object; clear disposes all', () => {
    const dispose = vi.fn();
    const cache = new ModelCache(10, 1000, dispose);
    const a1 = obj();
    const a2 = obj();
    cache.put('a', a1, 10);
    cache.put('a', a2, 10);
    expect(dispose).toHaveBeenCalledWith(a1);
    cache.clear();
    expect(dispose).toHaveBeenCalledWith(a2);
    expect(cache.size).toBe(0);
  });

  it('disposeObject disposes geometries and materials', async () => {
    const bytes = readFileSync(new URL('../fixtures/cnit-low.glb', import.meta.url));
    const scene = await parseGlb(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
    let mesh: Mesh | undefined;
    scene.traverse((o) => {
      if ((o as Mesh).isMesh && !mesh) mesh = o as Mesh;
    });
    const spy = vi.spyOn(mesh!.geometry, 'dispose');
    disposeObject(scene);
    expect(spy).toHaveBeenCalled();
  });
});
