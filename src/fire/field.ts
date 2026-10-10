/** A burning area: polygons in local metres (x east, z south), with its own spread settings. */
export interface FirePolygons {
  /** Polygons (outer ring first, then holes), each ring x, z pairs; open or closed. */
  polygons: number[][][][];
  /** Spread multiplier (0 holds the perimeter where it is). */
  rate: number;
  /** Flaming (true) or contained: burned ground and embers only. */
  active: boolean;
}

/** Region of the field in local metres: cell (i, j) is centred at minX + (i + 0.5)·cell. */
export interface FieldRect {
  minX: number;
  minZ: number;
  cell: number;
  nx: number;
  nz: number;
}

/**
 * Signed distance to the burned area over a grid, four floats per cell: distance in metres
 * (negative inside), the nearest fire's spread (rate × active), its active flag, unused.
 */
export interface FireField extends FieldRect {
  data: Float32Array;
}

/** A front: closed polyline around a burned area (or a hole in one), x, z pairs. */
export type Front = number[];

const INF = 1e20;

/** Even-odd fill of each fire's polygons at cell centres: the index of the fire per cell, or -1. */
export function rasterise(fires: FirePolygons[], rect: FieldRect): Int32Array {
  const { minX, minZ, cell, nx, nz } = rect;
  const out = new Int32Array(nx * nz).fill(-1);
  const xs: number[] = [];
  fires.forEach((fire, id) => {
    for (const polygon of fire.polygons) {
      let z0 = Infinity;
      let z1 = -Infinity;
      for (const ring of polygon)
        for (const p of ring) {
          z0 = Math.min(z0, p[1]!);
          z1 = Math.max(z1, p[1]!);
        }
      const r0 = Math.max(0, Math.floor((z0 - minZ) / cell - 0.5));
      const r1 = Math.min(nz - 1, Math.ceil((z1 - minZ) / cell - 0.5));
      for (let r = r0; r <= r1; r++) {
        const z = minZ + (r + 0.5) * cell;
        xs.length = 0;
        for (const ring of polygon)
          for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [xi, zi] = ring[i]!;
            const [xj, zj] = ring[j]!;
            if (zi! > z !== zj! > z) xs.push(xi! + ((z - zi!) * (xj! - xi!)) / (zj! - zi!));
          }
        if (xs.length < 2) continue;
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const from = Math.max(0, Math.ceil((xs[k]! - minX) / cell - 0.5));
          const to = Math.min(nx - 1, Math.floor((xs[k + 1]! - minX) / cell - 0.5));
          for (let c = from; c <= to; c++) out[r * nx + c] = id;
        }
      }
    }
  });
  return out;
}

/**
 * 1D squared distance transform (Felzenszwalb & Huttenlocher) of f[0..n) into d, with the
 * index of the nearest site in `arg`.
 */
function edt1d(
  f: Float64Array,
  n: number,
  d: Float64Array,
  arg: Int32Array,
  v: Int32Array,
  z: Float64Array,
): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    const s = (p: number) => (f[q]! + q * q - (f[p]! + p * p)) / (2 * q - 2 * p);
    let sq = s(v[k]!);
    // z[0] is -Infinity: the loop always stops at the first parabola.
    while (sq <= z[k]!) sq = s(v[--k]!);
    k++;
    v[k] = q;
    z[k] = sq;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const p = v[k]!;
    d[q] = (q - p) * (q - p) + f[p]!;
    arg[q] = p;
  }
}

/**
 * Squared distance (in cells) from each cell to the nearest cell where `site` is true, and the
 * index of that cell (-1 when there is none).
 */
export function distanceTransform(
  site: (i: number) => boolean,
  nx: number,
  nz: number,
): { d2: Float64Array; nearest: Int32Array } {
  const n = Math.max(nx, nz);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const arg = new Int32Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const col = new Float64Array(nx * nz);
  const row = new Int32Array(nx * nz);
  for (let x = 0; x < nx; x++) {
    for (let y = 0; y < nz; y++) f[y] = site(y * nx + x) ? 0 : INF;
    edt1d(f, nz, d, arg, v, z);
    for (let y = 0; y < nz; y++) {
      col[y * nx + x] = d[y]!;
      row[y * nx + x] = arg[y]!;
    }
  }
  const d2 = new Float64Array(nx * nz);
  const nearest = new Int32Array(nx * nz);
  for (let y = 0; y < nz; y++) {
    for (let x = 0; x < nx; x++) f[x] = col[y * nx + x]!;
    edt1d(f, nx, d, arg, v, z);
    for (let x = 0; x < nx; x++) {
      const i = y * nx + x;
      d2[i] = d[x]!;
      const sx = arg[x]!;
      nearest[i] = d[x]! >= INF ? -1 : row[y * nx + sx]! * nx + sx;
    }
  }
  return { d2, nearest };
}

/** The burned area's signed distance field over `rect`, carrying each fire's spread settings. */
export function buildField(fires: FirePolygons[], rect: FieldRect): FireField {
  const { nx, nz, cell } = rect;
  const owner = rasterise(fires, rect);
  const outside = distanceTransform((i) => owner[i]! >= 0, nx, nz);
  const inside = distanceTransform((i) => owner[i]! < 0, nx, nz);
  const data = new Float32Array(nx * nz * 4);
  for (let i = 0; i < nx * nz; i++) {
    const own = owner[i]!;
    const burned = own >= 0;
    // Half a cell: the perimeter lies between a burned cell and its unburned neighbour.
    const dist = burned
      ? -(Math.sqrt(Math.min(inside.d2[i]!, INF)) - 0.5) * cell
      : (Math.sqrt(Math.min(outside.d2[i]!, INF)) - 0.5) * cell;
    const near = burned ? own : outside.nearest[i]! >= 0 ? owner[outside.nearest[i]!]! : -1;
    const fire = near >= 0 ? fires[near] : undefined;
    data[i * 4] = Math.min(dist, 1e6);
    data[i * 4 + 1] = fire && fire.active ? fire.rate : 0;
    data[i * 4 + 2] = fire?.active ? 1 : 0;
  }
  return { ...rect, data };
}

/** Bilinear field value at local x, z (clamped to the grid): distance, spread, active. */
export function sampleField(field: FireField, x: number, z: number): [number, number, number] {
  const { minX, minZ, cell, nx, nz, data } = field;
  const fx = Math.min(nx - 1, Math.max(0, (x - minX) / cell - 0.5));
  const fz = Math.min(nz - 1, Math.max(0, (z - minZ) / cell - 0.5));
  const i0 = Math.min(nx - 2, Math.floor(fx));
  const j0 = Math.min(nz - 2, Math.floor(fz));
  const u = Math.max(0, Math.min(1, fx - i0));
  const w = Math.max(0, Math.min(1, fz - j0));
  const out: [number, number, number] = [0, 0, 0];
  if (nx < 2 || nz < 2) return [data[0]!, data[1]!, data[2]!];
  for (let c = 0; c < 3; c++) {
    const at = (i: number, j: number) => data[(j * nx + i) * 4 + c]!;
    const a = at(i0, j0) + (at(i0 + 1, j0) - at(i0, j0)) * u;
    const b = at(i0, j0 + 1) + (at(i0 + 1, j0 + 1) - at(i0, j0 + 1)) * u;
    out[c] = a + (b - a) * w;
  }
  return out;
}

/** Unit direction of increasing distance (away from the burned area) at x, z. */
export function outwardAt(field: FireField, x: number, z: number): [number, number] {
  const e = field.cell;
  const gx = sampleField(field, x + e, z)[0] - sampleField(field, x - e, z)[0];
  const gz = sampleField(field, x, z + e)[0] - sampleField(field, x, z - e)[0];
  const l = Math.hypot(gx, gz);
  return l > 0 ? [gx / l, gz / l] : [1, 0];
}

/**
 * The perimeters (distance 0) as closed polylines, by marching squares over the cell centres.
 * Outside the grid counts as unburned, so every front closes.
 */
export function fronts(field: FireField): Front[] {
  const { minX, minZ, cell, nx, nz, data } = field;
  // Corner (i, j) for i in -1..nx, j in -1..nz; outside the grid: unburned.
  const value = (i: number, j: number) =>
    i < 0 || j < 0 || i >= nx || j >= nz ? cell : data[(j * nx + i) * 4]!;
  const W = nx + 2;
  // Edge ids: horizontal edge from corner (i, j) to (i + 1, j), vertical from (i, j) to (i, j + 1).
  const hEdge = (i: number, j: number) => ((j + 1) * W + (i + 1)) * 2;
  const vEdge = (i: number, j: number) => ((j + 1) * W + (i + 1)) * 2 + 1;
  const point = new Map<number, [number, number]>();
  const cross = (id: number, i0: number, j0: number, i1: number, j1: number) => {
    if (!point.has(id)) {
      const a = value(i0, j0);
      const b = value(i1, j1);
      const t = a === b ? 0.5 : a / (a - b);
      point.set(id, [
        minX + (i0 + 0.5 + (i1 - i0) * t) * cell,
        minZ + (j0 + 0.5 + (j1 - j0) * t) * cell,
      ]);
    }
    return id;
  };
  // Segments, each joining two edge ids; at most two segments meet at an edge.
  const links = new Map<number, number[]>();
  const link = (a: number, b: number) => {
    for (const [p, q] of [
      [a, b],
      [b, a],
    ] as const) {
      const l = links.get(p);
      if (l) l.push(q);
      else links.set(p, [q]);
    }
  };
  for (let j = -1; j < nz; j++)
    for (let i = -1; i < nx; i++) {
      const a = value(i, j) < 0; // burned corners
      const b = value(i + 1, j) < 0;
      const c = value(i + 1, j + 1) < 0;
      const d = value(i, j + 1) < 0;
      const code = (a ? 1 : 0) | (b ? 2 : 0) | (c ? 4 : 0) | (d ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const top = () => cross(hEdge(i, j), i, j, i + 1, j);
      const right = () => cross(vEdge(i + 1, j), i + 1, j, i + 1, j + 1);
      const bottom = () => cross(hEdge(i, j + 1), i, j + 1, i + 1, j + 1);
      const left = () => cross(vEdge(i, j), i, j, i, j + 1);
      // Saddles: decided by the centre, so diagonal burned corners join when it is burned.
      const centre =
        (value(i, j) + value(i + 1, j) + value(i + 1, j + 1) + value(i, j + 1)) / 4 < 0;
      switch (code) {
        case 1:
        case 14:
          link(left(), top());
          break;
        case 2:
        case 13:
          link(top(), right());
          break;
        case 3:
        case 12:
          link(left(), right());
          break;
        case 4:
        case 11:
          link(right(), bottom());
          break;
        case 6:
        case 9:
          link(top(), bottom());
          break;
        case 7:
        case 8:
          link(left(), bottom());
          break;
        case 5:
          if (centre) {
            link(left(), bottom());
            link(top(), right());
          } else {
            link(left(), top());
            link(right(), bottom());
          }
          break;
        case 10:
          if (centre) {
            link(left(), top());
            link(right(), bottom());
          } else {
            link(top(), right());
            link(left(), bottom());
          }
          break;
      }
    }
  const out: Front[] = [];
  const used = new Set<number>();
  for (const start of links.keys()) {
    if (used.has(start)) continue;
    const line: number[] = [];
    let prev = -1;
    let at = start;
    while (!used.has(at)) {
      used.add(at);
      const p = point.get(at)!;
      line.push(p[0], p[1]);
      const next = links.get(at)!.find((e) => e !== prev && !used.has(e));
      if (next === undefined) break;
      prev = at;
      at = next;
    }
    if (line.length >= 6) out.push(line);
  }
  return out;
}

/** Evenly spaced points along a closed polyline: x, z and arc length (metres) of each. */
export function resample(front: Front, step: number): { x: number; z: number; arc: number }[] {
  const n = front.length / 2;
  let length = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    length += Math.hypot(front[j * 2]! - front[i * 2]!, front[j * 2 + 1]! - front[i * 2 + 1]!);
  }
  const count = Math.max(3, Math.round(length / step));
  const out: { x: number; z: number; arc: number }[] = [];
  let seg = 0;
  let segStart = 0;
  const segLen = (i: number) => {
    const j = (i + 1) % n;
    return Math.hypot(front[j * 2]! - front[i * 2]!, front[j * 2 + 1]! - front[i * 2 + 1]!);
  };
  for (let k = 0; k < count; k++) {
    const s = (k / count) * length;
    while (seg < n - 1 && s > segStart + segLen(seg)) segStart += segLen(seg++);
    const j = (seg + 1) % n;
    const u = Math.min(1, (s - segStart) / (segLen(seg) || 1));
    out.push({
      x: front[seg * 2]! + (front[j * 2]! - front[seg * 2]!) * u,
      z: front[seg * 2 + 1]! + (front[j * 2 + 1]! - front[seg * 2 + 1]!) * u,
      arc: s,
    });
  }
  return out;
}
