import { mapOutputs, sameValue, stripWrappers } from '../core/expressions';
import type { PaintRule } from '../core/ownedPaint';
import { materialPairs, normalizeFacade, normalizeFacadeExpression } from './colors';
import type { Fields } from './schema';

/** Feature-state key: height of the roof drawn on that building (metres). */
export const ROOF_STATE = 'landmarks:roof';
const ROOF = ['coalesce', ['feature-state', ROOF_STATE], 0];

const wrappable = (v: unknown) =>
  Array.isArray(v) || typeof v === 'number' || typeof v === 'string';

/** Unwrap for OwnedPaint: the stripped value, or undefined when none of ours was found. */
const peel = (match: (v: unknown) => unknown) => (value: unknown) => {
  const stripped = stripWrappers(value, match);
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

/** Style-expression variable holding the tagged facade colour as rgba (alpha 0: untagged). */
const FACADE_VAR = 'landmarks_facade';

/**
 * Height wrapper: `max(0, original − drawn roof)`; colour wrapper: facade colour, then material,
 * both toned down by `normalizeFacade`, then the original colour (left as it is).
 */
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
    const tagged = ['to-rgba', ['to-color', ['get', fields.facade_color], 'rgba(0,0,0,0)']];
    const material = ['get', fields.facade_material];
    const pairs = materialPairs(normalizeFacade);
    const facade = ['var', FACADE_VAR];
    rules.push({
      property: 'fill-extrusion-color',
      fallback: '#000000',
      wrap: (o) =>
        wrappable(o)
          ? mapOutputs(o, (v) => [
              'let',
              FACADE_VAR,
              tagged,
              [
                'case',
                ['>', ['at', 3, facade], 0],
                normalizeFacadeExpression(facade),
                ['match', material, ...pairs, v],
              ],
            ])
          : undefined,
      unwrap: peel((v: unknown) => {
        if (!Array.isArray(v) || v[0] !== 'let' || v[1] !== FACADE_VAR) return undefined;
        if (!sameValue(v[2], tagged)) return undefined;
        const match = Array.isArray(v[3]) && v[3][0] === 'case' ? v[3][3] : undefined;
        return Array.isArray(match) && match[0] === 'match' && sameValue(match[1], material)
          ? match.at(-1)
          : undefined;
      }),
    });
  }
  return rules;
}
