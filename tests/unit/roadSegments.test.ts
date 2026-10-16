import { describe, expect, it } from 'vitest';
import {
  flagRanges,
  numberRules,
  readPiece,
  ruleAt,
  slice,
  partsOf,
  stitch,
  type SegmentPiece,
} from '../../src/roads/segments';
import type { LngLat } from '../../src/core/types';

const C: LngLat = [-75.7135, 45.4205];
const M = 111_320;
const KX = M * Math.cos((C[1] * Math.PI) / 180);
const at = (east: number, north = 0): LngLat => [C[0] + east / KX, C[1] + north / M];
const BIG: SegmentPiece['tile'] = [-76, 45, -75, 46];
const eastOf = (p: LngLat) => Math.round((p[0] - C[0]) * KX);
const lengthOf = (line: LngLat[]) =>
  line.slice(1).reduce((s, p, i) => {
    const q = line[i]!;
    return s + Math.hypot((p[0] - q[0]) * KX, (p[1] - q[1]) * M);
  }, 0);

describe('Overture segment rules', () => {
  it('reads flag ranges and numeric rules, from JSON strings as tiles carry them', () => {
    expect(flagRanges('[{"values":["is_bridge"]}]', 'is_bridge')).toEqual([[0, 1]]);
    expect(
      flagRanges(
        '[{"between":[0.2,0.5],"values":["is_bridge","is_link"]},{"values":["is_tunnel"]}]',
        'is_bridge',
      ),
    ).toEqual([[0.2, 0.5]]);
    expect(flagRanges(undefined, 'is_bridge')).toEqual([]);
    expect(numberRules('[{"value":1},{"value":2,"between":[0.5,1]}]')).toEqual([
      { value: 1, between: [0, 1] },
      { value: 2, between: [0.5, 1] },
    ]);
  });

  it('lets a ranged rule win over the segment-wide one', () => {
    const rules = numberRules('[{"value":1},{"value":2,"between":[0.5,1]}]');
    expect(ruleAt(rules, 0.25)).toBe(1);
    expect(ruleAt(rules, 0.75)).toBe(2);
    expect(ruleAt([], 0.5)).toBeUndefined();
  });

  it('keeps road and rail segments, with their bridge ranges', () => {
    const coords = [at(0), at(100)];
    const props = (over: object) => ({ id: 's', subtype: 'road', class: 'primary', ...over });
    expect(readPiece(props({}), coords, BIG, 'f')).toMatchObject({ bridges: [] });
    expect(
      readPiece(props({ road_flags: '[{"values":["is_bridge"]}]' }), coords, BIG, 'f'),
    ).toMatchObject({ id: 's', kind: 'road', bridges: [[0, 1]] });
    expect(
      readPiece(
        props({ subtype: 'rail', rail_flags: '[{"values":["is_bridge"]}]' }),
        coords,
        BIG,
        'f',
      ),
    ).toMatchObject({ kind: 'rail' });
    expect(
      readPiece(
        props({ subtype: 'water', road_flags: '[{"values":["is_bridge"]}]' }),
        coords,
        BIG,
        'f',
      ),
    ).toBeNull();
  });
});

describe('segment geometry', () => {
  it('stitches tile pieces that overlap in the buffers back into one line', () => {
    const a = [at(0), at(50), at(120)];
    const b = [at(100), at(160), at(220)];
    const line = stitch([b, a]);
    expect(line[0]).toEqual(at(0));
    expect(line.at(-1)).toEqual(at(220));
    expect(lengthOf(line)).toBeCloseTo(220, 0);
  });

  it('slices a line by shares of its length', () => {
    const part = slice([at(0), at(100), at(200)], 0.25, 0.75);
    expect(part[0]![0]).toBeCloseTo(at(50)[0], 9);
    expect(part).toHaveLength(3); // the inner vertex at 100 m is kept
    expect(lengthOf(part)).toBeCloseTo(100, 3);
  });
});

describe('partsOf', () => {
  const piece = (over: Partial<SegmentPiece>): SegmentPiece => ({
    id: 's',
    kind: 'road',
    cls: 'primary',
    coords: [at(0), at(200)],
    bridges: [[0, 1]],
    tunnels: [],
    levels: [],
    widths: [],
    connectors: [],
    tile: BIG,
    ...over,
  });

  it('draws a whole-segment bridge at level 1 with its class width', () => {
    const { bridges, ground } = partsOf([piece({})]);
    expect(bridges[0]).toMatchObject({ kind: 'road', level: 1, width: 10 });
    expect(lengthOf(bridges[0]!.coords)).toBeCloseTo(200, 3);
    expect(ground).toEqual([]);
  });

  it('uses tagged level and width, and cuts a partial bridge from the whole line', () => {
    const {
      bridges: [span],
      ground,
    } = partsOf([
      piece({
        bridges: [[0.5, 1]],
        levels: [{ value: 2, between: [0.5, 1] }],
        widths: [{ value: 14, between: [0, 1] }],
      }),
    ]);
    expect(span).toMatchObject({ level: 2, width: 14 });
    expect(lengthOf(span!.coords)).toBeCloseTo(100, 3);
    // The rest of the segment is on the ground: a possible approach.
    expect(ground).toHaveLength(1);
    expect(ground[0]).toMatchObject({ level: 0 });
    expect(lengthOf(ground[0]!.coords)).toBeCloseTo(100, 3);
  });

  it('takes tunnels out of the ground, leaving bridges whole', () => {
    const { bridges, tunnels, ground } = partsOf([
      piece({
        bridges: [[0.5, 0.75]],
        tunnels: [
          [0, 0.25],
          [0.6, 1],
        ],
      }),
    ]);
    expect(bridges.map((b) => Math.round(lengthOf(b.coords)))).toEqual([50]);
    expect(tunnels.map((t) => Math.round(lengthOf(t.coords)))).toEqual([50, 50]);
    expect(ground.map((g) => Math.round(lengthOf(g.coords)))).toEqual([50]);
  });

  it('keeps a segment without a bridge as ground', () => {
    const { bridges, ground } = partsOf([piece({ bridges: [] })]);
    expect(bridges).toEqual([]);
    expect(lengthOf(ground[0]!.coords)).toBeCloseTo(200, 3);
  });

  it('places a partial bridge from connectors when the rest of the segment is not held', () => {
    // A 400 m segment, bridged from 200 to 300 m; only its first 320 m are held (the tile ends
    // there), with connectors at its start and 100 m along.
    const tile: SegmentPiece['tile'] = [C[0] - 1, C[1] - 1, at(320)[0], C[1] + 1];
    const connectors = new Map([
      ['c0', at(0)],
      ['c1', at(100)],
      ['c2', at(400)], // not held: off the line
    ]);
    const held = piece({
      coords: [at(0), at(330)],
      bridges: [[0.5, 0.75]],
      connectors: [
        { id: 'c0', at: 0 },
        { id: 'c1', at: 0.25 },
        { id: 'c2', at: 1 },
      ],
      tile,
    });
    const { bridges, ground } = partsOf([held], (id) => connectors.get(id));
    expect(bridges).toHaveLength(1);
    expect(eastOf(bridges[0]!.coords[0]!)).toBe(200);
    expect(eastOf(bridges[0]!.coords.at(-1)!)).toBe(300);
    // The ground before it is placed; the one after runs off the held line.
    expect(ground).toHaveLength(1);
    expect(lengthOf(ground[0]!.coords)).toBeCloseTo(200, 0);
  });

  it('waits for the whole segment before placing a partial bridge', () => {
    // The tile ends at 120 m east: the piece is cut there, so its far end is not a real end.
    const cut: SegmentPiece['tile'] = [C[0] - 1, C[1] - 1, at(120)[0], C[1] + 1];
    const held = piece({ coords: [at(0), at(130)], bridges: [[0.5, 1]], tile: cut });
    expect(partsOf([held]).bridges).toEqual([]);
    const next = piece({
      coords: [at(110), at(200)],
      bridges: [[0.5, 1]],
      tile: [at(120)[0], C[1] - 1, C[0] + 1, C[1] + 1],
    });
    const [span] = partsOf([held, next]).bridges;
    expect(lengthOf(span!.coords)).toBeCloseTo(100, 0);
  });
});
