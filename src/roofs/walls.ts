import { mapOutputs, sameValue } from '../core/expressions';
import type { PaintRule } from '../core/ownedPaint';
import { materialPairs } from './colors';
import type { Fields } from './schema';

/** Feature-state key: height of the roof drawn on that building (metres). */
export const ROOF_STATE = 'landmarks:roof';
const ROOF = ['coalesce', ['feature-state', ROOF_STATE], 0];

const wrappable = (v: unknown) =>
  Array.isArray(v) || typeof v === 'number' || typeof v === 'string';

/** `value` with every wrapper `match` recognises removed, at any depth (others may wrap ours). */
function strip(value: unknown, match: (v: unknown) => unknown): unknown {
  const inner = match(value);
  if (inner !== undefined) return strip(inner, match);
  return Array.isArray(value) ? value.map((v) => strip(v, match)) : value;
}

/** Unwrap for OwnedPaint: the stripped value, or undefined when none of ours was found. */
const peel = (match: (v: unknown) => unknown) => (value: unknown) => {
  const stripped = strip(value, match);
  return sameValue(stripped, value) ? undefined : stripped;
};

const ourHeight = (v: unknown) =>
  Array.isArray(v) &&
  v.length === 3 &&
  v[0] === 'max' &&
  v[1] === 0 &&
  Array.isArray(v[2]) &&
  v[2][0] === '-' &&
  sameValue(v[2][2], ROOF)
    ? v[2][1]
    : undefined;

/** Height wrapper: `max(0, original − drawn roof)`; colour wrapper: facade colour, then material. */
export function wallRules(fields: Fields, wallColors: boolean): PaintRule[] {
  const rules: PaintRule[] = [
    {
      property: 'fill-extrusion-height',
      fallback: 0,
      wrap: (o) => (wrappable(o) ? mapOutputs(o, (v) => ['max', 0, ['-', v, ROOF]]) : undefined),
      unwrap: peel(ourHeight),
    },
  ];
  if (wallColors) {
    const facade = ['get', fields.facade_color];
    const material = ['get', fields.facade_material];
    const pairs = materialPairs();
    rules.push({
      property: 'fill-extrusion-color',
      fallback: '#000000',
      wrap: (o) =>
        wrappable(o)
          ? mapOutputs(o, (v) => ['to-color', facade, ['match', material, ...pairs, v]])
          : undefined,
      unwrap: peel((v: unknown) =>
        Array.isArray(v) &&
        v[0] === 'to-color' &&
        sameValue(v[1], facade) &&
        Array.isArray(v[2]) &&
        v[2][0] === 'match' &&
        sameValue(v[2][1], material)
          ? v[2].at(-1)
          : undefined,
      ),
    });
  }
  return rules;
}
