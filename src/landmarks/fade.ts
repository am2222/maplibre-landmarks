import type { Material, Mesh, Object3D } from 'three';

interface Tween {
  from: number;
  to: number;
  /** Set on the first step after the tween (re)starts, so time spent off-screen does not count. */
  start?: number;
  value: number;
  done?: () => void;
}

const smoothstep = (t: number) => t * t * (3 - 2 * t);

/** Eased 0..1 values keyed by anything, advanced by frame timestamps. */
export class Tweens<K> {
  private readonly items = new Map<K, Tween>();

  constructor(private readonly durationMs: number) {}

  has(key: K): boolean {
    return this.items.has(key);
  }

  value(key: K): number {
    return this.items.get(key)?.value ?? 0;
  }

  target(key: K): number | undefined {
    return this.items.get(key)?.to;
  }

  /** True while any tween has not reached its target. */
  active(): boolean {
    for (const t of this.items.values()) if (t.value !== t.to) return true;
    return false;
  }

  set(key: K, value: number): void {
    this.items.set(key, { from: value, to: value, value });
  }

  /** Animate `key` from its current value to `to`; `done` runs once it gets there. */
  to(key: K, to: number, done?: () => void): void {
    const current = this.items.get(key);
    if (current?.to === to) {
      if (done) current.done = done;
      if (current.value === to) this.finish(key, current);
      return;
    }
    const value = current?.value ?? 0;
    const tween: Tween = { from: value, to, value, done };
    this.items.set(key, tween);
    if (this.durationMs <= 0 || value === to) {
      tween.value = to;
      this.finish(key, tween);
    }
  }

  delete(key: K): void {
    this.items.delete(key);
  }

  clear(): void {
    this.items.clear();
  }

  /** Advance every tween to `now`; true while any is still moving. */
  step(now: number): boolean {
    let moving = false;
    for (const [key, t] of [...this.items]) {
      if (t.value === t.to) continue;
      t.start ??= now;
      const k = Math.min(1, (now - t.start) / this.durationMs);
      t.value = k >= 1 ? t.to : t.from + (t.to - t.from) * smoothstep(k);
      if (t.value === t.to) this.finish(key, t);
      else moving = true;
    }
    return moving;
  }

  private finish(_key: K, t: Tween): void {
    const done = t.done;
    t.done = undefined;
    done?.();
  }
}

const BASE_OPACITY = 'landmarks:opacity';

function materialsOf(root: Object3D): Material[] {
  const out = new Set<Material>();
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (mesh.isMesh) for (const m of ([] as Material[]).concat(mesh.material)) out.add(m);
  });
  return [...out];
}

/**
 * Make a model fadeable. Opaque materials switch to alpha hashing (a stable dither that keeps
 * depth writes and needs no sorting), permanently, so fading never swaps shader variants and the
 * warmed-up programs stay valid. Already transparent materials fade their own opacity.
 */
export function prepareFade(root: Object3D): void {
  for (const m of materialsOf(root)) {
    if (m.userData[BASE_OPACITY] !== undefined) continue;
    m.userData[BASE_OPACITY] = m.opacity;
    if (!m.transparent) {
      m.alphaHash = true;
      m.needsUpdate = true;
    }
  }
}

export function setModelOpacity(root: Object3D, opacity: number): void {
  root.visible = opacity > 0;
  for (const m of materialsOf(root)) {
    m.opacity = ((m.userData[BASE_OPACITY] as number | undefined) ?? 1) * opacity;
  }
}

/** Draw order among coincident models: an incoming LOD draws over the one it replaces. */
export function setRenderOrder(root: Object3D, order: number): void {
  root.traverse((o) => (o.renderOrder = order));
}
