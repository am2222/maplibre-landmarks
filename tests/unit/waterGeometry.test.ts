import { describe, expect, it } from 'vitest';
import { mercatorUnitsPerMetre, mercatorX, mercatorY } from '../../src/core/mercator';
import { pointInRing } from '../../src/core/geometry';
import { buildPiece, latitudeOf, longitudeOf } from '../../src/water/geometry';

const LNG = 2.2945;
const LAT = 48.8584;
const DEG_PER_M = 360 / (2 * Math.PI * 6371008.8);
const M_LNG = DEG_PER_M / Math.cos((LAT * Math.PI) / 180);
/** Metres per mercator unit at LAT. */
const M = 1 / mercatorUnitsPerMetre(LAT);

/** Closed ring of a w × d metre rectangle, south-west corner (east, north) metres from LNG/LAT. */
function rect(east: number, north: number, w: number, d: number, clockwise = false) {
  const [x0, y0] = [LNG + east * M_LNG, LAT + north * DEG_PER_M];
  const [x1, y1] = [x0 + w * M_LNG, y0 + d * DEG_PER_M];
  const ring = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0],
  ];
  return clockwise ? ring.reverse() : ring;
}
const never = () => false;

/** Sum of triangle areas in m² (mercator x, y pairs). */
function areaOf(xy: number[], index: number[]) {
  let a = 0;
  for (let i = 0; i < index.length; i += 3) {
    const [p, q, r] = [index[i]! * 2, index[i + 1]! * 2, index[i + 2]! * 2];
    a += Math.abs(
      (xy[q]! - xy[p]!) * (xy[r + 1]! - xy[p + 1]!) - (xy[r]! - xy[p]!) * (xy[q + 1]! - xy[p + 1]!),
    );
  }
  return (a / 2) * M * M;
}
/** Ribbon inner vertices (shore 0) as lng/lat. */
function inner(piece: NonNullable<ReturnType<typeof buildPiece>>) {
  const out: number[][] = [];
  piece.shore.shore.forEach((s, i) => {
    if (s === 0)
      out.push([longitudeOf(piece.shore.xy[i * 2]!), latitudeOf(piece.shore.xy[i * 2 + 1]!)]);
  });
  return out;
}
/** Lng/lat to metres east and north of LNG/LAT. */
const local = ([lng, lat]: number[]) => [(lng! - LNG) / M_LNG, (lat! - LAT) / DEG_PER_M];
/** Every inner vertex sits `w` metres in from one side of an `size` metre square. */
const insetBy = (piece: NonNullable<ReturnType<typeof buildPiece>>, size: number, w: number) =>
  inner(piece).every((v) =>
    local(v).some((c) => Math.abs(c - w) < 1e-3 || Math.abs(c - (size - w)) < 1e-3),
  );

describe('water piece geometry', () => {
  it('converts mercator back to degrees', () => {
    expect(longitudeOf(mercatorX(LNG))).toBeCloseTo(LNG, 10);
    expect(latitudeOf(mercatorY(LAT))).toBeCloseTo(LAT, 10);
  });

  it('triangulates the body to the polygon area, holes excluded', () => {
    const p = buildPiece([rect(0, 0, 100, 100)], never)!;
    expect(areaOf(p.body.xy, p.body.index)).toBeCloseTo(10_000, -1);
    const holed = buildPiece([rect(0, 0, 100, 100), rect(40, 40, 20, 20, true)], never)!;
    expect(areaOf(holed.body.xy, holed.body.index)).toBeCloseTo(9_600, -1);
  });

  it('adds a 6 m ribbon inside every shoreline edge, either winding', () => {
    for (const cw of [false, true]) {
      const p = buildPiece([rect(0, 0, 100, 100, cw)], never)!;
      expect(p.shore.xy.length / 2).toBe(16); // 4 edges × 4 vertices
      expect(p.shore.shore.filter((s) => s === 1)).toHaveLength(8);
      for (const v of inner(p)) for (const c of local(v)) expect(c).toBeGreaterThan(-1e-3);
      for (const v of inner(p)) for (const c of local(v)) expect(c).toBeLessThan(100 + 1e-3);
      expect(insetBy(p, 100, 6)).toBe(true);
    }
  });

  it('puts island ribbons on the water side (outside the hole)', () => {
    const hole = rect(40, 40, 20, 20, true);
    const p = buildPiece([rect(0, 0, 100, 100), hole], never)!;
    const islandInner = inner(p).filter((v) => {
      const e = (v[0]! - LNG) / M_LNG;
      const n = (v[1]! - LAT) / DEG_PER_M;
      return e > 30 && e < 70 && n > 30 && n < 70;
    });
    expect(islandInner).toHaveLength(8);
    for (const v of islandInner) expect(pointInRing(v, hole)).toBe(false);
  });

  it('skips straight tile cuts: edges with water just outside them', () => {
    const eastLng = LNG + 100 * M_LNG;
    const p = buildPiece([rect(0, 0, 100, 100)], ([lng]) => lng > eastLng)!;
    expect(p.shore.xy.length / 2).toBe(12); // west, south, north only
  });

  it('treats tile cuts skewed by one tile unit (overzoomed tiles) as cuts', () => {
    // MapLibre rounds clipped points of an overzoomed z18 tile to its 4096 grid: one end of the
    // cut lands one unit (about 2.5 cm) off.
    const unit = 360 / (2 ** 18 * 4096);
    const ring = rect(0, 0, 100, 100);
    ring[2] = [ring[2]![0]! + unit, ring[2]![1]!]; // north-east corner, east edge skewed
    const eastLng = LNG + 100 * M_LNG;
    const p = buildPiece([ring], ([lng]) => lng > eastLng + 2 * unit)!;
    expect(p.shore.xy.length / 2).toBe(12); // west, south, north only
  });

  it('narrows the ribbon on small polygons and skips tiny or degenerate ones', () => {
    const small = buildPiece([rect(0, 0, 10, 10)], never)!;
    expect(insetBy(small, 10, 2)).toBe(true); // 0.2 × √100
    expect(buildPiece([rect(0, 0, 1.5, 1.5)], never)).toBeNull(); // 2.25 m²
    const [a, b] = rect(0, 0, 50, 50);
    expect(buildPiece([[a!, b!, a!, a!]], never)).toBeNull(); // < 3 distinct points
    expect(buildPiece([[a!, b!, b!, a!]], never)).toBeNull();
    expect(buildPiece([], never)).toBeNull();
  });

  it('keeps ribbons on narrow ditches inside the water (no spill over the far bank)', () => {
    const p = buildPiece([rect(0, 0, 3, 500)], never)!; // 1,500 m²: area alone allows 6 m
    for (const v of inner(p)) {
      const [e] = local(v);
      expect(e).toBeGreaterThan(-1e-3);
      expect(e).toBeLessThan(3 + 1e-3);
    }
    // From the west bank inward: less than half the ditch.
    const fromWest = inner(p)
      .map((v) => local(v)[0]!)
      .filter((e) => e > 1e-3 && e < 3 - 1e-3);
    for (const e of fromWest) expect(Math.min(e, 3 - e)).toBeLessThan(1.5);
  });

  it('samples triangle centres inside the water and reports bounds and triangle count', () => {
    const p = buildPiece([rect(0, 0, 100, 100)], never)!;
    expect(p.samples).toHaveLength(4); // 2 triangles
    for (let i = 0; i < p.samples.length; i += 2) {
      const v = [longitudeOf(p.samples[i]!), latitudeOf(p.samples[i + 1]!)];
      expect(pointInRing(v, rect(0, 0, 100, 100))).toBe(true);
    }
    expect(p.bbox[0]).toBeCloseTo(mercatorX(LNG), 12);
    expect(p.bbox[3]).toBeCloseTo(mercatorY(LAT), 12); // mercator y grows south
    expect(p.triangles).toBe(2 + 8);
  });
});
