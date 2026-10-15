import { describe, expect, it } from 'vitest';
import {
  buildRaised,
  LEVEL_M,
  liftAt,
  profileOf,
  rampFor,
  type RaisedInput,
} from '../../src/roads/geometry';
import { chainSpans, withApproaches } from '../../src/roads/network';
import type { Span } from '../../src/roads/segments';
import type { LngLat } from '../../src/core/types';

const C: LngLat = [-75.7135, 45.4205];
const KX = 111_320 * Math.cos((C[1] * Math.PI) / 180);
const at = (east: number, north = 0): LngLat => [C[0] + east / KX, C[1] + north / 111_320];
const eastOf = (p: LngLat) => Math.round((p[0] - C[0]) * KX);
const span = (key: string, coords: LngLat[], over: Partial<Span> = {}): Span => ({
  key,
  kind: 'road',
  cls: 'primary',
  coords,
  level: 1,
  width: 10,
  ...over,
});

describe('chainSpans', () => {
  it('joins a bridge mapped in pieces, whichever way each piece runs', () => {
    const chains = chainSpans([
      span('a', [at(0), at(100)]),
      span('c', [at(250), at(200)]), // drawn backwards
      span('b', [at(100), at(200)], { width: 14 }),
    ]);
    expect(chains).toHaveLength(1);
    expect(chains[0]!.coords.map(eastOf)).toEqual([0, 100, 200, 250]);
    expect(chains[0]!.widths).toEqual([10, 14, 14, 10]);
  });

  it('keeps apart other levels, and stops at a junction of three', () => {
    expect(
      chainSpans([span('a', [at(0), at(100)]), span('b', [at(100), at(200)], { level: 2 })]),
    ).toHaveLength(2);
    const fork = chainSpans([
      span('a', [at(0), at(100)]),
      span('b', [at(100), at(200)]),
      span('c', [at(100), at(100, 100)]),
    ]);
    expect(fork).toHaveLength(3);
  });
});

describe('withApproaches', () => {
  const bridge = () => chainSpans([span('bridge', [at(0), at(100)])]);
  const ground = (key: string, coords: LngLat[], over: Partial<Span> = {}) =>
    span(key, coords, { level: 0, ...over });

  it('takes the roads carrying on from each end, as far as the ramp needs', () => {
    const [raised] = withApproaches(
      bridge(),
      [
        ground('west', [at(-200), at(0)]), // drawn towards the bridge
        ground('east', [at(100), at(130)]),
        ground('east2', [at(130), at(400)]),
      ],
      () => 60,
    );
    expect(raised!.approaches[0]).toBeCloseTo(60, 3);
    expect(raised!.approaches[1]).toBeCloseTo(60, 3); // over two segments
    expect(eastOf(raised!.coords[0]!)).toBe(-60);
    expect(eastOf(raised!.coords.at(-1)!)).toBe(160);
    expect(raised!.widths).toHaveLength(raised!.coords.length);
  });

  it('picks the straight road at a T by the abutment, and stops at a junction further on', () => {
    const [raised] = withApproaches(
      bridge(),
      [
        ground('side', [at(100), at(100, 50)]),
        ground('ahead', [at(100), at(120)]),
        ground('fork1', [at(120), at(200)]),
        ground('fork2', [at(120), at(120, 80)]),
      ],
      () => 60,
    );
    expect(raised!.approaches[1]).toBeCloseTo(20, 3);
    expect(raised!.approaches[0]).toBe(0); // nothing to the west
  });

  it('never ramps along an underpass or a road of another kind', () => {
    const [raised] = withApproaches(
      bridge(),
      [
        ground('tunnel', [at(100), at(200)], { level: -1 }),
        ground('rail', [at(-100), at(0)], { kind: 'rail' }),
      ],
      () => 60,
    );
    expect(raised!.approaches).toEqual([0, 0]);
  });
});

describe('raised road geometry', () => {
  it('ramps over the approaches to a full level, or within a bridge that has none', () => {
    const withRamps = profileOf(220, [60, 160], 1);
    expect(withRamps.top).toBeCloseTo(LEVEL_M);
    expect(liftAt(withRamps, 0)).toBe(0);
    expect(liftAt(withRamps, 60)).toBeCloseTo(LEVEL_M); // full height from the abutment on
    const without = profileOf(90, [0, 90], 1);
    expect(without.ramps).toEqual([30, 30]);
    expect(without.top).toBeLessThan(LEVEL_M);
    expect(rampFor(1)).toBeCloseTo(60);
  });

  const input = (over: Partial<RaisedInput> = {}): RaisedInput => ({
    points: [
      [0, 0],
      [60, 0],
      [260, 0],
      [320, 0],
    ],
    widths: [10, 10, 10, 10],
    level: 1,
    kind: 'road',
    cls: 'primary',
    approaches: [60, 60],
    ground: () => 0,
    ...over,
  });
  const ys = (positions: number[]) => positions.filter((_, i) => i % 3 === 1);

  it('builds embankments up to a deck on piers, all on the ground', () => {
    const { mesh, top } = buildRaised(input());
    expect(top).toBeCloseTo(LEVEL_M, 1);
    expect(mesh.positions.length % 9).toBe(0);
    // Everything stands on the ground: embankment sides and piers reach 0, nothing goes below.
    expect(Math.min(...ys(mesh.positions))).toBeCloseTo(0, 5);
    expect(Math.max(...ys(mesh.positions))).toBeCloseTo(LEVEL_M + 1, 1); // parapets
  });

  it('spans a valley straight between its abutments, embankments following the ground', () => {
    const ground = ([x]: [number, number]) => (x > 60 && x < 260 ? 0 : 20);
    const { mesh } = buildRaised(input({ ground }));
    const y = ys(mesh.positions);
    // The deck stays near its abutments' 20 m (+ its lift); piers go down to the valley floor.
    expect(Math.min(...y.filter((v) => v > 10))).toBeGreaterThan(19);
    expect(Math.min(...y)).toBeCloseTo(0, 5);
  });
});
