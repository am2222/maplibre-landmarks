const isZoom = (e: unknown) => Array.isArray(e) && e.length === 1 && e[0] === 'zoom';
const isInterpolate = (op: unknown) =>
  op === 'interpolate' || op === 'interpolate-hcl' || op === 'interpolate-lab';

/** Structural equality for style values (JSON-shaped). */
export const sameValue = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * Apply `fn` to each output of a zoom curve, keeping the curve top-level (MapLibre rejects a
 * `["zoom"]` curve nested in another expression), or to the value itself.
 */
export function mapOutputs(value: unknown, fn: (output: unknown) => unknown): unknown {
  if (Array.isArray(value)) {
    const [op] = value as unknown[];
    if (isInterpolate(op) && isZoom(value[2])) {
      const [, interp, input, ...stops] = value as unknown[];
      return [op, interp, input, ...stops.map((v, i) => (i % 2 ? fn(v) : v))];
    }
    if (op === 'step' && isZoom(value[1])) {
      const [, input, first, ...stops] = value as unknown[];
      return [op, input, fn(first), ...stops.map((v, i) => (i % 2 ? fn(v) : v))];
    }
  }
  return fn(value);
}

/** Inverse of `mapOutputs`: undefined unless `unwrap` recognises every output. */
export function unmapOutputs(value: unknown, unwrap: (output: unknown) => unknown): unknown {
  let ok = true;
  const result = mapOutputs(value, (o) => {
    const u = unwrap(o);
    if (u === undefined) ok = false;
    return u;
  });
  return ok ? result : undefined;
}

/**
 * `value × factor` as a style expression. Returns undefined for legacy function objects and
 * other values that cannot be wrapped.
 */
export function scaleBy(value: unknown, factor: unknown): unknown {
  if (!Array.isArray(value) && typeof value !== 'number') return undefined;
  return mapOutputs(value, (v) => ['*', v, factor]);
}

/** Inverse of `scaleBy`: the original value, or undefined when `value` is not its output. */
export function unscaleBy(value: unknown, factor: unknown): unknown {
  return unmapOutputs(value, (v) =>
    Array.isArray(v) && v.length === 3 && v[0] === '*' && sameValue(v[2], factor)
      ? v[1]
      : undefined,
  );
}

/**
 * `value` with every wrapper `match` recognises removed, at any depth: other wrappers may sit
 * on top of ours (two plugins wrapping one paint property), and ours may survive a re-add.
 */
export function stripWrappers(value: unknown, match: (v: unknown) => unknown): unknown {
  const inner = match(value);
  if (inner !== undefined) return stripWrappers(inner, match);
  return Array.isArray(value) ? value.map((v) => stripWrappers(v, match)) : value;
}
