import { describe, expect, it } from 'vitest';
import { DEFAULT_ROOF_COLOR, materialPairs, parseColor, toRGB } from '../../src/roofs/colors';
import {
  DEFAULT_FIELDS,
  normaliseShape,
  readRoofProps,
  ROOF_SHAPE_VALUES,
  resolveFields,
} from '../../src/roofs/schema';

const read = (p: Record<string, unknown>) => readRoofProps(p, DEFAULT_FIELDS, '#d9d4ce');

describe('roof shapes', () => {
  it('normalises case, dashes and aliases', () => {
    expect(normaliseShape('Gabled')).toBe('gabled');
    expect(normaliseShape('half-hipped')).toBe('half_hipped');
    expect(normaliseShape('double_saltbox')).toBe('mansard');
    expect(normaliseShape('quadruple_saltbox')).toBe('mansard');
    expect(normaliseShape('side_hipped')).toBe('hipped');
    expect(normaliseShape('pyramid')).toBe('pyramidal');
    expect(normaliseShape('side_half-hipped')).toBe('half_hipped');
    expect(normaliseShape('hipped-and-gabled')).toBe('hipped_and_gabled');
    expect(normaliseShape('gabled_height_moved')).toBe('saltbox');
    expect(normaliseShape('bellcast_gable')).toBe('bellcast_gable');
    expect(normaliseShape('gabled_irregular')).toBe('saltbox');
    expect(normaliseShape('spherical')).toBe('dome');
    expect(normaliseShape('pitched')).toBe('gabled');
    expect(normaliseShape('lean_to')).toBe('skillion');
    expect(normaliseShape('monopitch')).toBe('skillion');
    expect(normaliseShape('shed')).toBe('skillion');
    expect(normaliseShape('sawtooth')).toBe('sawtooth');
    expect(normaliseShape('saltbox')).toBe('saltbox');
  });

  it('treats flat, unknown and missing shapes as no roof', () => {
    for (const v of ['flat', 'many', 'gabled_row', '', undefined, 3])
      expect(normaliseShape(v)).toBeNull();
  });
});

describe('ROOF_SHAPE_VALUES', () => {
  it('lists every _ / - spelling, including mixed ones', () => {
    for (const v of ['side_half-hipped', 'side-half_hipped', 'hipped-and-gabled', 'lean-to'])
      expect(ROOF_SHAPE_VALUES).toContain(v);
    expect(ROOF_SHAPE_VALUES.every((v) => normaliseShape(v) !== null)).toBe(true);
  });
});

describe('readRoofProps', () => {
  it('reads a minimal tagged building with defaults', () => {
    expect(read({ height: 20, roof_shape: 'gabled' })).toEqual({
      shape: 'gabled',
      height: 20,
      minHeight: 0,
      roofHeight: undefined,
      direction: undefined,
      orientation: undefined,
      roofColor: DEFAULT_ROOF_COLOR,
      wallColor: '#d9d4ce',
    });
  });

  it('rejects outlines with parts, missing heights and empty spans', () => {
    expect(read({ height: 20, roof_shape: 'gabled', has_parts: true })).toBeNull();
    expect(read({ height: 20, roof_shape: 'gabled', has_parts: 'true' })).toBeNull();
    expect(read({ roof_shape: 'gabled' })).toBeNull();
    expect(read({ height: 10, min_height: 10, roof_shape: 'gabled' })).toBeNull();
    expect(read({ height: 20, roof_shape: 'flat' })).toBeNull();
  });

  it('parses numbers, compass directions and orientation', () => {
    const p = read({
      height: '30',
      min_height: 4,
      roof_shape: 'hipped',
      roof_height: '6',
      roof_direction: 'NE',
      roof_orientation: 'Across',
    })!;
    expect(p).toMatchObject({
      height: 30,
      minHeight: 4,
      roofHeight: 6,
      direction: 45,
      orientation: 'across',
    });
    expect(read({ height: 9, roof_shape: 'gabled', roof_direction: 90 })!.direction).toBe(90);
    expect(
      read({ height: 9, roof_shape: 'gabled', roof_direction: 'x' })!.direction,
    ).toBeUndefined();
    expect(read({ height: 9, roof_shape: 'gabled', roof_height: -2 })!.roofHeight).toBeUndefined();
    expect(read({ height: 9, roof_shape: 'gabled', roof_angle: '35' })!.roofAngle).toBe(35);
    expect(read({ height: 9, roof_shape: 'gabled', roof_angle: 90 })!.roofAngle).toBeUndefined();
  });

  it('takes colours from colour tags, then materials, then defaults', () => {
    expect(read({ height: 9, roof_shape: 'dome', roof_color: 'red' })!.roofColor).toBe('#ff0000');
    expect(read({ height: 9, roof_shape: 'dome', roof_color: '#ABC' })!.roofColor).toBe('#aabbcc');
    expect(read({ height: 9, roof_shape: 'dome', roof_material: 'tiles' })!.roofColor).toBe(
      '#f08060',
    );
    expect(read({ height: 9, roof_shape: 'dome', facade_material: 'brick' })!.wallColor).toBe(
      '#cc7755',
    );
    expect(read({ height: 9, roof_shape: 'dome', facade_color: 'nonsense' })!.wallColor).toBe(
      '#d9d4ce',
    );
  });

  it('maps differently named source fields', () => {
    const fields = resolveFields({ roof_shape: 'roof:shape', height: 'render_height' });
    expect(readRoofProps({ 'roof:shape': 'dome', render_height: 12 }, fields, '#fff')!.shape).toBe(
      'dome',
    );
  });
});

describe('colours', () => {
  it('parses CSS colours and exposes linear RGB and material pairs', () => {
    expect(parseColor('rgb(255, 0, 0)')).toBe('#ff0000');
    expect(parseColor(42)).toBeUndefined();
    expect(toRGB('#ffffff')).toEqual([1, 1, 1]);
    const pairs = materialPairs();
    expect(pairs[pairs.indexOf('slate') + 1]).toBe('#666666');
    expect(pairs[pairs.indexOf('tiles') + 1]).toBe('#f08060');
  });
});
