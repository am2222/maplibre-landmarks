import { describe, expect, it, vi } from 'vitest';
import { Group, type Object3D } from 'three';
import type { LandmarkEntry, Lod } from '../../src/landmarks/catalogue';
import { entryKey, type Wanted } from '../../src/landmarks/discovery';
import { ModelCache } from '../../src/landmarks/loader';
import { Residency } from '../../src/landmarks/residency';
import { entry } from './fixtures';
import { deferred, flush } from './helpers';

type Loaded = { object: Object3D; bytes: number };

function setup() {
  const loads: {
    entry: LandmarkEntry;
    lod: Lod;
    signal: AbortSignal;
    d: ReturnType<typeof deferred<Loaded>>;
  }[] = [];
  const dispose = vi.fn();
  const cache = new ModelCache(10, 1e9, dispose);
  const onChange = vi.fn();
  const onError = vi.fn();
  const residency = new Residency({
    cache,
    onChange,
    onError,
    load: (e, lod, signal) => {
      const d = deferred<Loaded>();
      loads.push({ entry: e, lod, signal, d });
      return d.promise;
    },
  });
  return { residency, loads, cache, dispose, onChange, onError };
}

const w = (e: LandmarkEntry, lod: Lod = 'low'): Wanted => ({ key: entryKey(e), entry: e, lod });
const a = entry('a');
const b = entry('b');

describe('Residency', () => {
  it('loads wanted models and reports a change when they arrive', async () => {
    const { residency, loads, onChange } = setup();
    residency.setWanted([w(a)]);
    expect(loads).toHaveLength(1);
    expect(residency.models()).toEqual([]);
    const object = new Group();
    loads[0]!.d.resolve({ object, bytes: 10 });
    await flush();
    expect(residency.models().map((m) => m.object)).toEqual([object]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('does not reload a model that is already resident or pending', async () => {
    const { residency, loads } = setup();
    residency.setWanted([w(a)]);
    residency.setWanted([w(a)]);
    expect(loads).toHaveLength(1);
    loads[0]!.d.resolve({ object: new Group(), bytes: 1 });
    await flush();
    residency.setWanted([w(a)]);
    expect(loads).toHaveLength(1);
  });

  it('keeps the old LOD visible until the new one is ready', async () => {
    const { residency, loads, cache } = setup();
    residency.setWanted([w(a, 'low')]);
    const low = new Group();
    loads[0]!.d.resolve({ object: low, bytes: 1 });
    await flush();
    residency.setWanted([w(a, 'detail')]);
    expect(residency.models()[0]!.object).toBe(low);
    const detail = new Group();
    loads[1]!.d.resolve({ object: detail, bytes: 2 });
    await flush();
    expect(residency.models()[0]!.object).toBe(detail);
    expect(residency.models()[0]!.lod).toBe('detail');
    expect(cache.take(`${entryKey(a)}#low`)?.object).toBe(low);
  });

  it('moves unwanted models to the cache and reuses them without loading', async () => {
    const { residency, loads, onChange } = setup();
    residency.setWanted([w(a)]);
    const object = new Group();
    loads[0]!.d.resolve({ object, bytes: 1 });
    await flush();
    residency.setWanted([]);
    expect(residency.models()).toEqual([]);
    residency.setWanted([w(a)]);
    expect(loads).toHaveLength(1);
    expect(residency.models()[0]!.object).toBe(object);
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('aborts loads that are no longer wanted and disposes their late result', async () => {
    const { residency, loads, dispose } = setup();
    residency.setWanted([w(a), w(b)]);
    residency.setWanted([w(b)]);
    expect(loads[0]!.signal.aborted).toBe(true);
    const late = new Group();
    loads[0]!.d.resolve({ object: late, bytes: 1 });
    await flush();
    expect(residency.models()).toEqual([]);
    expect(dispose).toHaveBeenCalledWith(late);
  });

  it('reports errors and retries on the next setWanted', async () => {
    const { residency, loads, onError } = setup();
    residency.setWanted([w(a)]);
    loads[0]!.d.reject(new Error('boom'));
    await flush();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), a);
    residency.setWanted([w(a)]);
    expect(loads).toHaveLength(2);
  });

  it('swallows abort errors', async () => {
    const { residency, loads, onError } = setup();
    residency.setWanted([w(a)]);
    residency.setWanted([]);
    loads[0]!.d.reject(new DOMException('Aborted', 'AbortError'));
    await flush();
    expect(onError).not.toHaveBeenCalled();
  });

  it('clear aborts pending loads and hands residents to the cache', async () => {
    const { residency, loads, cache } = setup();
    residency.setWanted([w(a), w(b)]);
    loads[0]!.d.resolve({ object: new Group(), bytes: 1 });
    await flush();
    residency.clear();
    expect(loads[1]!.signal.aborted).toBe(true);
    expect(residency.models()).toEqual([]);
    expect(cache.size).toBe(1);
  });
});
