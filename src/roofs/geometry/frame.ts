/** Local metres in the ground plane: x east, z south. */
export type Vec2 = [number, number];

/** Roof coordinates: `u` along the ridge, `v` across it, centred on the footprint's box. */
export interface RoofFrame {
  origin: Vec2;
  u: Vec2;
  v: Vec2;
  /** Half-extent along `u`. */
  L: number;
  /** Half-extent along `v`. */
  W: number;
}

const perp = ([x, z]: Vec2): Vec2 => [-z, x];
const cross = (o: Vec2, a: Vec2, b: Vec2) =>
  (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Andrew's monotone chain. */
export function convexHull(points: Vec2[]): Vec2[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const lower: Vec2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (const p of pts.reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Unit vector of a compass bearing (degrees clockwise from north) in x-east / z-south axes. */
export function bearingVector(deg: number): Vec2 {
  const r = (deg * Math.PI) / 180;
  return [Math.sin(r), -Math.cos(r)];
}

/** The frame with ridge axis `u` (unit) that tightly encloses `ring`. */
export function frameAlong(ring: Vec2[], u: Vec2): RoofFrame {
  const v = perp(u);
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const [x, z] of ring) {
    const a = x * u[0] + z * u[1];
    const b = x * v[0] + z * v[1];
    minU = Math.min(minU, a);
    maxU = Math.max(maxU, a);
    minV = Math.min(minV, b);
    maxV = Math.max(maxV, b);
  }
  const cu = (minU + maxU) / 2;
  const cv = (minV + maxV) / 2;
  return {
    origin: [u[0] * cu + v[0] * cv, u[1] * cu + v[1] * cv],
    u,
    v,
    L: (maxU - minU) / 2,
    W: (maxV - minV) / 2,
  };
}

/** Long axis of the minimum-area oriented box (rotating calipers over the hull edges). */
function longAxis(ring: Vec2[]): Vec2 {
  const hull = convexHull(ring);
  let best: RoofFrame | undefined;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]!;
    const b = hull[(i + 1) % hull.length]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-9) continue;
    const f = frameAlong(hull, [(b[0] - a[0]) / len, (b[1] - a[1]) / len]);
    if (!best || f.L * f.W < best.L * best.W - 1e-9) best = f;
  }
  if (!best) return [1, 0];
  return best.L >= best.W ? best.u : best.v;
}

/**
 * Ridge frame of a footprint. With a direction, `v` points the way the roof faces; otherwise the
 * ridge follows the long side (or the short side for `across`).
 */
export function roofFrame(
  ring: Vec2[],
  direction?: number,
  orientation?: 'along' | 'across',
): RoofFrame {
  if (direction !== undefined) {
    const v = bearingVector(direction);
    return frameAlong(ring, [v[1], -v[0]]); // perp(u) === v
  }
  const long = longAxis(ring);
  return frameAlong(ring, orientation === 'across' ? perp(long) : long);
}

export function toFrame(f: RoofFrame, [x, z]: Vec2): Vec2 {
  const dx = x - f.origin[0];
  const dz = z - f.origin[1];
  return [dx * f.u[0] + dz * f.u[1], dx * f.v[0] + dz * f.v[1]];
}

export function fromFrame(f: RoofFrame, [a, b]: Vec2): Vec2 {
  return [f.origin[0] + a * f.u[0] + b * f.v[0], f.origin[1] + a * f.u[1] + b * f.v[1]];
}
