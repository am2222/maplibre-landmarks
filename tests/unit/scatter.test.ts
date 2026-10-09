import { describe, expect, it } from 'vitest';
import { hashString, hashValues, seededRand } from '../../src/trees/hash';
import {
  pointInPolygon,
  polygonAreaM2,
  scatterPiece,
  scatterPolygon,
  shouldScatter,
} from '../../src/trees/scatter';

const M = 111_195; // metres per degree of latitude (R = 6371008.8)

function square(lng: number, lat: number, sizeM: number): number[][] {
  const dLat = sizeM / M;
  const dLng = sizeM / (M * Math.cos((lat * Math.PI) / 180));
  return [
    [lng, lat],
    [lng + dLng, lat],
    [lng + dLng, lat + dLat],
    [lng, lat + dLat],
    [lng, lat],
  ];
}

const SQ = square(2.29, 48.85, 200);

describe('hash', () => {
  it('is deterministic and spreads values in [0, 1)', () => {
    expect(hashString('a')).toBe(hashString('a'));
    expect(hashString('a')).not.toBe(hashString('b'));
    const v = hashValues('tree:1', 5);
    expect(v).toHaveLength(5);
    expect(v.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(hashValues('tree:1', 5)).toEqual(v);
    expect(hashValues('tree:2', 5)).not.toEqual(v);
  });

  it('seededRand is mulberry32', () => {
    expect(seededRand(1)()).toBeCloseTo(0.6270739405881613, 12);
  });
});

describe('polygon geometry', () => {
  const hole = square(2.2905, 48.8505, 100);

  it('measures area in square metres', () => {
    expect(Math.abs(polygonAreaM2([SQ]) - 40_000) / 40_000).toBeLessThan(0.01);
    expect(Math.abs(polygonAreaM2([SQ, hole]) - 30_000) / 30_000).toBeLessThan(0.01);
  });

  it('respects holes', () => {
    const inHole = [hole[0]![0]! + 0.0001, hole[0]![1]! + 0.0001];
    const inRing = [SQ[0]![0]! + 0.0001, SQ[0]![1]! + 0.0001];
    expect(pointInPolygon(inHole, [SQ, hole])).toBe(false);
    expect(pointInPolygon(inRing, [SQ, hole])).toBe(true);
  });
});

describe('scatterPolygon', () => {
  it('is deterministic', () => {
    expect(scatterPolygon('park', [[SQ]], 1 / 400)).toEqual(
      scatterPolygon('park', [[SQ]], 1 / 400),
    );
  });

  it('does not depend on how tiles split the polygon', () => {
    const [w, s] = SQ[0] as [number, number];
    const [e, n] = SQ[2] as [number, number];
    const mid = (w + e) / 2;
    const left = [
      [w, s],
      [mid, s],
      [mid, n],
      [w, n],
      [w, s],
    ];
    const right = [
      [mid, s],
      [e, s],
      [e, n],
      [mid, n],
      [mid, s],
    ];
    const whole = scatterPolygon('park', [[SQ]], 1 / 100)
      .map((p) => p.key)
      .sort();
    const split = scatterPolygon('park', [[left], [right]], 1 / 100)
      .map((p) => p.key)
      .sort();
    expect(split).toEqual(whole);
  });

  it('matches the requested density', () => {
    const n = scatterPolygon('forest', [[SQ]], 1 / 60).length;
    const expected = 40_000 / 60;
    expect(n / expected).toBeGreaterThan(0.85);
    expect(n / expected).toBeLessThan(1.15);
  });

  it('keeps holes empty', () => {
    const hole = square(2.2905, 48.8505, 100);
    const pts = scatterPolygon('forest', [[SQ, hole]], 1 / 60);
    expect(pts.length).toBeGreaterThan(0);
    expect(pts.some((p) => pointInPolygon(p.lngLat, [hole]))).toBe(false);
  });

  it('jitters differently per kind', () => {
    const a = scatterPolygon('park', [[SQ]], 1 / 400)[0]!.lngLat;
    const b = scatterPolygon('wood', [[SQ]], 1 / 400)[0]!.lngLat;
    expect(a).not.toEqual(b);
  });

  it('refuses absurdly large polygons', () => {
    expect(scatterPolygon('forest', [[square(2, 48, 100_000)]], 1 / 60)).toEqual([]);
  });
});

describe('shouldScatter', () => {
  it('skips at and above the ratio and fills below it', () => {
    // park target = 40000 / 400 = 100 trees → 25% = 25 mapped trees
    expect(shouldScatter([[SQ]], 1 / 400, 24, 0.25)).toBe(true);
    expect(shouldScatter([[SQ]], 1 / 400, 25, 0.25)).toBe(false);
    expect(shouldScatter([[SQ]], 1 / 400, 30, 0.25)).toBe(false);
  });
});

/** A rectangle ring with ~400 vertices (densified edges), like a clipped tile piece of a forest. */
function denseRect(w: number, s: number, e: number, n: number, perEdge = 100): number[][] {
  const pts: number[][] = [];
  for (let i = 0; i < perEdge; i++) pts.push([w + ((e - w) * i) / perEdge, s]);
  for (let i = 0; i < perEdge; i++) pts.push([e, s + ((n - s) * i) / perEdge]);
  for (let i = 0; i < perEdge; i++) pts.push([e - ((e - w) * i) / perEdge, n]);
  for (let i = 0; i < perEdge; i++) pts.push([w, n - ((n - s) * i) / perEdge]);
  pts.push([w, s]);
  return pts;
}

describe('scatter performance (review #1)', () => {
  it('scatters a 3.3 x 2.6 km forest split into 12 dense tile pieces quickly', () => {
    const lat = 48.85;
    const dLng = 3300 / (M * Math.cos((lat * Math.PI) / 180)) / 4;
    const dLat = 2600 / M / 3;
    const pieces = [];
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 3; j++) {
        const w = 2.2 + i * dLng;
        const s = lat + j * dLat;
        pieces.push([denseRect(w, s, w + dLng, s + dLat)]);
      }
    }
    const t0 = performance.now();
    const pts = scatterPolygon('forest', pieces, 1 / 60);
    const ms = performance.now() - t0;
    expect(pts.length / ((3300 * 2600) / 60)).toBeGreaterThan(0.85);
    // Shared CI runners are several times slower than a laptop; the regression this guards
    // against took ~3.2 s.
    // Locally the whole suite runs in parallel too: 400 ms alone, up to ~600 ms alongside it.
    expect(ms).toBeLessThan(process.env.CI ? 1500 : 1000); // was ~3.2 s before the row-edge filter
  });

  it('scatterPiece matches scatterPolygon for a single piece', () => {
    expect(scatterPiece('park', [SQ], 1 / 100)).toEqual(scatterPolygon('park', [[SQ]], 1 / 100));
  });
});
