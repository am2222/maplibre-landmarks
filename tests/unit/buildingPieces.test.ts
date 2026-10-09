import { describe, expect, it } from 'vitest';
import { BuildingPieces } from '../../src/roofs/buildingPieces';

const square = (x0: number, x1: number) => [
  [
    [x0, 0],
    [x1, 0],
    [x1, 0.001],
    [x0, 0.001],
    [x0, 0],
  ],
];
const piece = (id: number | undefined, coordinates: number[][][], props: object = {}) => ({
  id,
  geometry: { type: 'Polygon', coordinates },
  properties: { roof_shape: 'gabled', ...props },
});
const keepRoofed = (p: Record<string, unknown>) => p.roof_shape !== undefined;

describe('BuildingPieces', () => {
  it('merges a building split over two tiles, rebuilding it as each side comes and goes', () => {
    const pieces = new BuildingPieces(keepRoofed);
    expect(pieces.add('15/1/1', 'building', [piece(7, square(0, 0.0011))])).toEqual(
      new Set(['building|7']),
    );
    const west = pieces.footprint('building|7')!;
    expect(west.polygons).toHaveLength(1);
    expect(pieces.add('15/2/1', 'building', [piece(7, square(0.001, 0.002))])).toEqual(
      new Set(['building|7']),
    );
    const whole = pieces.footprint('building|7')!;
    expect(whole.signature).not.toBe(west.signature);
    expect(whole.centroid[0]).toBeCloseTo(0.001, 6);
    expect(pieces.footprint('building|7')).toBe(whole); // cached until a piece changes
    expect(pieces.drop('15/1/1', 'building')).toEqual(new Set(['building|7']));
    expect(pieces.footprint('building|7')!.centroid[0]).toBeCloseTo(0.0015, 6);
    pieces.drop('15/2/1', 'building');
    expect(pieces.footprint('building|7')).toBeUndefined();
    expect(pieces.keys()).toEqual([]);
  });

  it('keeps buildings and parts with the same id apart, and each feed drops only its own', () => {
    const pieces = new BuildingPieces(keepRoofed);
    pieces.add('15/1/1', 'building', [piece(7, square(0, 0.001))]);
    pieces.add('15/1/1', 'building_part', [piece(7, square(0.005, 0.006))]);
    expect(pieces.keys().sort()).toEqual(['building_part|7', 'building|7']);
    expect(pieces.sourceLayerOf('building_part|7')).toBe('building_part');
    pieces.drop('15/1/1', 'building');
    expect(pieces.keys()).toEqual(['building_part|7']);
  });

  it('replaces a reloaded tile, reporting buildings it no longer has as changed', () => {
    const pieces = new BuildingPieces(keepRoofed);
    pieces.add('15/1/1', 'building', [piece(1, square(0, 0.001)), piece(2, square(0.01, 0.011))]);
    const changed = pieces.add('15/1/1', 'building', [piece(1, square(0, 0.001))]);
    expect(changed).toEqual(new Set(['building|1', 'building|2']));
    expect(pieces.keys()).toEqual(['building|1']);
  });

  it('skips unroofed buildings without decoding them, and counts pieces without ids', () => {
    const pieces = new BuildingPieces(keepRoofed);
    const plain = {
      id: 3,
      properties: {},
      get geometry(): never {
        throw new Error('decoded');
      },
    };
    pieces.add('15/1/1', 'building', [plain as never, piece(undefined, square(0, 0.001))]);
    expect(pieces.keys()).toEqual([]);
    expect(pieces.missingIds).toBe(1);
  });
});
