import type { Map as MlMap } from 'maplibre-gl';
import { sameValue } from './expressions';

export type PaintTarget = Pick<MlMap, 'getLayer' | 'getPaintProperty' | 'setPaintProperty'>;
type PaintProperty = Parameters<MlMap['getPaintProperty']>[1];

export interface PaintRule {
  property: PaintProperty;
  /** Our wrapper around an original value, or undefined when it cannot be wrapped. */
  wrap(original: unknown): unknown;
  /** The original inside one of our wrappers, or undefined if `value` is not ours. */
  unwrap(value: unknown): unknown;
  /** Wrapped in place of an unset property. */
  fallback: unknown;
}

/**
 * Wraps paint properties of one layer and gives them back cleanly: a wrapper of ours already in
 * the style is peeled rather than doubled, a value the app replaced is re-wrapped, and restore
 * puts the original back only while our wrapper is still there.
 */
export class OwnedPaint {
  private readonly applied = new Map<PaintProperty, { original: unknown; wrapped: unknown }>();
  private readonly warned = new Set<PaintProperty>();

  constructor(
    private readonly map: PaintTarget,
    private readonly layerId: string,
    private readonly rules: PaintRule[],
    private readonly warn: (message: string) => void,
  ) {}

  /** Wrap (or re-check) every rule; false when the layer does not exist. Cheap to repeat. */
  wrap(): boolean {
    if (!this.map.getLayer(this.layerId)) {
      this.applied.clear();
      return false;
    }
    for (const rule of this.rules) {
      const current = this.map.getPaintProperty(this.layerId, rule.property);
      const known = this.applied.get(rule.property);
      if (known && sameValue(current, known.wrapped)) continue;
      const peeled = current === undefined ? undefined : rule.unwrap(current);
      const original = peeled === undefined ? current : peeled;
      const wrapped = rule.wrap(original ?? rule.fallback);
      if (wrapped === undefined) {
        if (!this.warned.has(rule.property)) {
          this.warned.add(rule.property);
          this.warn(`cannot wrap legacy function ${this.layerId}/${rule.property}`);
        }
        this.applied.delete(rule.property);
        continue;
      }
      this.map.setPaintProperty(this.layerId, rule.property, wrapped as never);
      this.applied.set(rule.property, { original, wrapped });
    }
    return true;
  }

  /** Whether `property` currently carries our wrapper (false for legacy functions). */
  isApplied(property: PaintProperty): boolean {
    return this.applied.has(property);
  }

  restore(): void {
    for (const [property, { original, wrapped }] of this.applied) {
      try {
        if (
          this.map.getLayer(this.layerId) &&
          sameValue(this.map.getPaintProperty(this.layerId, property), wrapped)
        ) {
          this.map.setPaintProperty(this.layerId, property, original as never);
        }
      } catch {
        // The style was torn down.
      }
    }
    this.applied.clear();
  }

  /** Forget after a style swap without touching the (new) style. */
  reset(): void {
    this.applied.clear();
  }
}
