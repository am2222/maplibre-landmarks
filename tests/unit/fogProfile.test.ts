import { describe, expect, it } from 'vitest';
import { fogFill, noiseCell, valleyFloor, type FloorMap } from '../../src/fog/profile';

/** Mean of clamp(t, 0, 1) for t linear from ta to tb, by brute force. */
function numeric(ta: number, tb: number): number {
  const n = 20000;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const t = ta + ((tb - ta) * (i + 0.5)) / n;
    sum += Math.min(1, Math.max(0, t));
  }
  return sum / n;
}

describe('fog profile', () => {
  it('fills a segment exactly like the numeric mean of the soft top', () => {
    const cases: [number, number][] = [
      [-2, -1],
      [-1, 0.5],
      [0.2, 0.7],
      [0.5, 3],
      [-1, 4],
      [4, -1],
      [2, 5],
      [0.3, 0.3],
    ];
    for (const [ta, tb] of cases) expect(fogFill(ta, tb)).toBeCloseTo(numeric(ta, tb), 4);
  });

  it('scales noise cells with zoom, always dividing the 4096 m period', () => {
    expect(noiseCell(16)).toBe(128);
    expect(noiseCell(18)).toBe(128);
    expect(noiseCell(14.4)).toBe(512);
    expect(noiseCell(13)).toBe(1024);
    expect(noiseCell(9)).toBe(1024);
    for (const z of [9, 13, 14, 15, 16, 19]) expect(4096 % noiseCell(z)).toBe(0);
  });

  it('finds the valley floor near the centre, ignoring lowlands at the horizon', () => {
    const lowland = 370;
    const map = {
      getCenter: () => ({ lng: 6.87, lat: 45.92 }),
      // Valley along lng 6.87 at 1035 m, rising 1 m per 10 m sideways; lowlands 30 km away.
      queryTerrainElevation: ([lng, lat]: [number, number]) =>
        Math.abs(lat - 45.92) > 0.2 ? lowland : 1035 + 7800 * Math.abs(lng - 6.87),
    } as unknown as FloorMap;
    expect(valleyFloor(map, 6000)).toBeCloseTo(1035, 0);
    const none = { ...map, queryTerrainElevation: () => null } as unknown as FloorMap;
    expect(valleyFloor(none, 6000)).toBeNull();
  });
});
