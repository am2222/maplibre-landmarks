import type { Object3D } from 'three';
import type { LandmarkEntry, Lod } from './catalogue';
import type { Wanted } from './discovery';
import { isAbort, type ModelCache } from './loader';

/** Where models go when they stop being resident (a ModelCache, or something wrapping one). */
export type ModelStore = Pick<ModelCache, 'take' | 'put' | 'dispose'>;

export type LoadFn = (
  entry: LandmarkEntry,
  lod: Lod,
  signal: AbortSignal,
) => Promise<{ object: Object3D; bytes: number }>;

export interface ResidentModel {
  key: string;
  entry: LandmarkEntry;
  lod: Lod;
  object: Object3D;
  bytes: number;
}

export interface ResidencyOptions {
  load: LoadFn;
  cache: ModelStore;
  onChange: () => void;
  onError: (err: unknown, entry: LandmarkEntry) => void;
}

const cacheKey = (key: string, lod: Lod) => `${key}#${lod}`;

export class Residency {
  private readonly resident = new Map<string, ResidentModel>();
  private readonly pending = new Map<string, { lod: Lod; controller: AbortController }>();

  constructor(private readonly opts: ResidencyOptions) {}

  models(): ResidentModel[] {
    return [...this.resident.values()];
  }

  setWanted(wanted: Wanted[]): void {
    const byKey = new Map(wanted.map((w) => [w.key, w]));
    for (const [key, p] of this.pending) {
      if (byKey.get(key)?.lod !== p.lod) {
        p.controller.abort();
        this.pending.delete(key);
      }
    }
    let changed = false;
    for (const [key, m] of this.resident) {
      if (!byKey.has(key)) {
        this.resident.delete(key);
        this.opts.cache.put(cacheKey(key, m.lod), m.object, m.bytes);
        changed = true;
      }
    }
    for (const w of wanted) {
      if (this.resident.get(w.key)?.lod === w.lod || this.pending.has(w.key)) continue;
      const cached = this.opts.cache.take(cacheKey(w.key, w.lod));
      if (cached) {
        this.swapIn(w, cached.object, cached.bytes);
        changed = true;
      } else {
        this.startLoad(w);
      }
    }
    if (changed) this.opts.onChange();
  }

  clear(): void {
    for (const p of this.pending.values()) p.controller.abort();
    this.pending.clear();
    for (const m of this.resident.values())
      this.opts.cache.put(cacheKey(m.key, m.lod), m.object, m.bytes);
    this.resident.clear();
  }

  private startLoad(w: Wanted): void {
    const controller = new AbortController();
    this.pending.set(w.key, { lod: w.lod, controller });
    this.opts.load(w.entry, w.lod, controller.signal).then(
      ({ object, bytes }) => {
        if (controller.signal.aborted || this.pending.get(w.key)?.controller !== controller) {
          this.opts.cache.dispose(object);
          return;
        }
        this.pending.delete(w.key);
        this.swapIn(w, object, bytes);
        this.opts.onChange();
      },
      (err: unknown) => {
        if (this.pending.get(w.key)?.controller === controller) this.pending.delete(w.key);
        if (!isAbort(err) && !controller.signal.aborted) this.opts.onError(err, w.entry);
      },
    );
  }

  private swapIn(w: Wanted, object: Object3D, bytes: number): void {
    const old = this.resident.get(w.key);
    if (old) this.opts.cache.put(cacheKey(w.key, old.lod), old.object, old.bytes);
    this.resident.set(w.key, { key: w.key, entry: w.entry, lod: w.lod, object, bytes });
  }
}
