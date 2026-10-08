const isZoom = (e: unknown) => Array.isArray(e) && e.length === 1 && e[0] === 'zoom';

/**
 * `value × factor` as a style expression. A zoom curve must stay the top-level expression, so
 * its outputs are scaled instead. Returns undefined for legacy function objects (not wrappable).
 */
export function scaleBy(value: unknown, factor: unknown): unknown {
  if (Array.isArray(value)) {
    const [op] = value as unknown[];
    if (
      (op === 'interpolate' || op === 'interpolate-hcl' || op === 'interpolate-lab') &&
      isZoom(value[2])
    ) {
      const [, interp, input, ...stops] = value as unknown[];
      return [op, interp, input, ...stops.map((v, i) => (i % 2 ? ['*', v, factor] : v))];
    }
    if (op === 'step' && isZoom(value[1])) {
      const [, input, first, ...stops] = value as unknown[];
      return [
        op,
        input,
        ['*', first, factor],
        ...stops.map((v, i) => (i % 2 ? ['*', v, factor] : v)),
      ];
    }
    return ['*', value, factor];
  }
  if (typeof value === 'number') return ['*', value, factor];
  return undefined;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const FAIL = Symbol('not wrapped');
const unwrap = (v: unknown, factor: unknown): unknown =>
  Array.isArray(v) && v.length === 3 && v[0] === '*' && same(v[2], factor) ? v[1] : FAIL;

/** Inverse of `scaleBy`: the original value, or undefined when `value` is not its output. */
export function unscaleBy(value: unknown, factor: unknown): unknown {
  if (!Array.isArray(value)) return undefined;
  const [op] = value as unknown[];
  let parts: unknown[] | undefined;
  if (
    (op === 'interpolate' || op === 'interpolate-hcl' || op === 'interpolate-lab') &&
    isZoom(value[2])
  ) {
    const [, interp, input, ...stops] = value as unknown[];
    parts = [op, interp, input, ...stops.map((v, i) => (i % 2 ? unwrap(v, factor) : v))];
  } else if (op === 'step' && isZoom(value[1])) {
    const [, input, first, ...stops] = value as unknown[];
    parts = [
      op,
      input,
      unwrap(first, factor),
      ...stops.map((v, i) => (i % 2 ? unwrap(v, factor) : v)),
    ];
  } else {
    const v = unwrap(value, factor);
    return v === FAIL ? undefined : v;
  }
  return parts.includes(FAIL) ? undefined : parts;
}
