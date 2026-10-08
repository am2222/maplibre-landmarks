import type { Map as MlMap } from 'maplibre-gl';
import { scaleBy, unscaleBy } from '../core/expressions';

/** Feature-state key on label features: 1 shown, 0 hidden; unset means shown. */
export const LABEL_STATE = 'landmarks:label';
const VISIBILITY = ['coalesce', ['feature-state', LABEL_STATE], 1];
const PROPERTIES: PaintProperty[] = ['text-opacity', 'icon-opacity'];

export type OpacityTarget = Pick<MlMap, 'getLayer' | 'getPaintProperty' | 'setPaintProperty'>;
type PaintProperty = Parameters<MlMap['getPaintProperty']>[1];

interface Wrapped {
  original: unknown;
  wrapped: unknown;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Multiplies label layers' opacity by their per-feature visibility; restores on demand. */
export class LabelOpacity {
  private readonly layers = new Map<string, Map<PaintProperty, Wrapped>>();
  private readonly warned = new Set<string>();

  constructor(
    private readonly map: OpacityTarget,
    private readonly warn: (message: string) => void,
  ) {}

  /**
   * Wrap `layerIds` (and release any other layer wrapped before). Cheap to call on every scan:
   * values still holding our wrapper are skipped, and a value the app replaced is re-wrapped.
   */
  wrap(layerIds: string[]): void {
    const wanted = new Set(layerIds);
    for (const id of [...this.layers.keys()]) if (!wanted.has(id)) this.release(id);
    for (const id of layerIds) {
      if (!this.map.getLayer(id)) {
        this.layers.delete(id);
        continue;
      }
      let props = this.layers.get(id);
      if (!props) this.layers.set(id, (props = new Map()));
      for (const prop of PROPERTIES) {
        const current = this.map.getPaintProperty(id, prop);
        const known = props.get(prop);
        if (known && same(current, known.wrapped)) continue;
        // First wrap, or the app replaced the value. A wrapper of ours left in the style (it
        // survives a context restore) is peeled off so it is never applied twice.
        const peeled = unscaleBy(current, VISIBILITY);
        const original = peeled === undefined ? current : peeled;
        const wrapped = scaleBy(original ?? 1, VISIBILITY);
        if (wrapped === undefined) {
          if (!this.warned.has(`${id}/${prop}`)) {
            this.warned.add(`${id}/${prop}`);
            this.warn(`cannot wrap legacy function ${id}/${prop}`);
          }
          props.delete(prop);
          continue;
        }
        this.map.setPaintProperty(id, prop, wrapped as never);
        props.set(prop, { original, wrapped });
      }
    }
  }

  restore(): void {
    for (const id of [...this.layers.keys()]) this.release(id);
  }

  /** Forget wrapped layers after a style swap without touching the (new) style. */
  reset(): void {
    this.layers.clear();
  }

  /** Put the original back, unless the app has replaced our wrapper since. */
  private release(id: string): void {
    const props = this.layers.get(id);
    this.layers.delete(id);
    if (!props) return;
    for (const [prop, { original, wrapped }] of props) {
      try {
        if (this.map.getLayer(id) && same(this.map.getPaintProperty(id, prop), wrapped)) {
          this.map.setPaintProperty(id, prop, original as never);
        }
      } catch {
        // The style was torn down.
      }
    }
  }
}
