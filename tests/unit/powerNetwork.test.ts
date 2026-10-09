import { describe, expect, it } from 'vitest';
import { buildNetwork, type LinePiece, type Support } from '../../src/power/network';

const M = 111_320;
const KX = M * Math.cos((48.93 * Math.PI) / 180);
/** Point `east`, `north` metres from 2.34, 48.93. */
const at = (east: number, north = 0): [number, number] => [2.34 + east / KX, 48.93 + north / M];
const tower = (east: number, north = 0, over: Partial<Support> = {}): Support => ({
  lngLat: at(east, north),
  kind: 'tower',
  ...over,
});
const piece = (id: string, eastings: number[], over: Partial<LinePiece> = {}): LinePiece => ({
  id,
  kind: 'line',
  coords: eastings.map((e) => at(e)),
  ...over,
});

describe('buildNetwork', () => {
  it('spans consecutive towers along a line, in order, ignoring towers off it', () => {
    // The line's vertices were simplified away: only its ends remain.
    const net = buildNetwork(
      [piece('a', [0, 900])],
      [tower(600), tower(0), tower(300), tower(900), tower(300, 200)],
    );
    expect(net.spans.map(([i, j]) => [net.supports[i]!.lngLat, net.supports[j]!.lngLat])).toEqual([
      [at(0), at(300)],
      [at(300), at(600)],
      [at(600), at(900)],
    ]);
  });

  it('joins a span cut by a tile edge to the next tower straight ahead on the same line', () => {
    // Tile edge at 450 m: each piece reaches 30 m past it (the tile buffer).
    const west = piece('a', [0, 480]);
    const east = piece('a', [420, 900]);
    const net = buildNetwork([west, east], [tower(0), tower(300), tower(600), tower(900)]);
    expect(net.spans).toHaveLength(3);
    // Another line's tower straight ahead is not joined.
    const other = buildNetwork(
      [piece('a', [0, 480]), piece('b', [600, 900])],
      [tower(0), tower(300), tower(600), tower(900)],
    );
    expect(other.spans).toHaveLength(2);
  });

  it('uses the line vertices as supports where no towers are mapped (poles)', () => {
    const net = buildNetwork([piece('m', [0, 40, 80], { kind: 'minor_line' })], []);
    expect(net.supports.map((s) => s.kind)).toEqual(['pole', 'pole', 'pole']);
    expect(net.spans).toHaveLength(2);
  });

  it('puts no pole on a line vertex in water: the wires span the river instead', () => {
    const river = (ll: [number, number]) => ll[0] > at(30)[0] && ll[0] < at(50)[0];
    const net = buildNetwork([piece('m', [0, 40, 80], { kind: 'minor_line' })], [], river);
    expect(net.supports).toHaveLength(2);
    expect(net.spans).toHaveLength(1);
    // Mapped towers stand where they are mapped, even in a river.
    expect(
      buildNetwork([piece('a', [0, 80])], [tower(0), tower(40), tower(80)], river).supports,
    ).toHaveLength(3);
  });

  it('turns each support across its line and takes the tagged height or the default', () => {
    const net = buildNetwork([piece('a', [0, 300])], [tower(0, 0, { height: 42 }), tower(300)]);
    expect(net.supports[0]!.height).toBe(42);
    expect(net.supports[1]!.height).toBe(30); // transmission default
    // Line runs east: arms across it, north-south (bearing of the line 90°).
    expect(net.supports[0]!.bearing).toBeCloseTo(90, 3);
  });

  it('merges the same tower seen in two tiles', () => {
    const net = buildNetwork([piece('a', [0, 300])], [tower(0), tower(0), tower(300)]);
    expect(net.supports).toHaveLength(2);
    expect(net.spans).toHaveLength(1);
  });
});
