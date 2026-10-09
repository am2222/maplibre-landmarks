import { describe, expect, it } from 'vitest';
import { Color, SRGBColorSpace } from 'three';
import {
  colorVariance,
  DEFAULT_ROOF_COLOR,
  materialPairs,
  normalizeFacade,
  parseColor,
  roofRGB,
  toRGB,
} from '../../src/roofs/colors';
import {
  buildingBase,
  buildingHeight,
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
    expect(normaliseShape('side_hipped')).toBe('side_hipped');
    expect(normaliseShape('pyramid')).toBe('pyramidal');
    expect(normaliseShape('side_half-hipped')).toBe('side_half_hipped');
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

  it('falls back to floor counts for heights (3 m a floor, roof on top), and reads 3,5', () => {
    expect(read({ num_floors: 4, roof_shape: 'gabled' })).toMatchObject({
      height: 12,
      minHeight: 0,
    });
    expect(read({ num_floors: 4, roof_height: 3, roof_shape: 'gabled' })!.height).toBe(15);
    expect(read({ num_floors: 4, min_floor: 1, roof_shape: 'gabled' })!.minHeight).toBe(3);
    expect(read({ height: 20, num_floors: 4, roof_shape: 'gabled' })!.height).toBe(20); // tagged wins
    expect(read({ height: '12,5', roof_height: '3,5', roof_shape: 'gabled' })).toMatchObject({
      height: 12.5,
      roofHeight: 3.5,
    });
  });

  it('snaps a tagged direction to a wall within its precision (letters 45°, degrees 10°, decimals 0.5°)', () => {
    const snap = (roof_direction: unknown) =>
      read({ height: 9, roof_shape: 'gabled', roof_direction })!.directionSnap;
    expect(snap('NE')).toBe(45);
    expect(snap(90)).toBe(10);
    expect(snap('90')).toBe(10);
    expect(snap('92.5')).toBe(0.5);
    expect(snap(undefined)).toBeUndefined();
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
      normalizeFacade('#cc7755'),
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

describe('roof colour tweaks', () => {
  const hsl = (rgb: [number, number, number]) =>
    new Color(...rgb).getHSL({ h: 0, s: 0, l: 0 }, SRGBColorSpace);

  it('tones roof colours down to 70 % saturation, keeping hue and lightness', () => {
    const red = hsl(roofRGB('#ff0000'));
    expect(red.h).toBeCloseTo(0, 4);
    expect(red.s).toBeCloseTo(0.7, 4);
    expect(red.l).toBeCloseTo(0.5, 4);
    expect(hsl(roofRGB('#999999')).s).toBeCloseTo(0, 6);
  });

  it('shifts lightness by a stable per-building variance', () => {
    expect(hsl(roofRGB('#808080', 0.06)).l).toBeCloseTo(hsl(roofRGB('#808080')).l + 0.06, 4);
    expect(hsl(roofRGB('#ffffff', 0.06)).l).toBeCloseTo(1, 6);
    const ids = [1, 2, 3, 4, 5, 6, 7, 8, 'way/9', 'way/10'];
    for (const id of ids) {
      expect([0.06, 0.03, -0.06, -0.03]).toContain(colorVariance(id));
      expect(colorVariance(id)).toBe(colorVariance(id));
    }
    expect(new Set(ids.map(colorVariance)).size).toBeGreaterThan(1);
  });
});

describe('facade colours', () => {
  const hsl = (hex: string) => new Color(hex).getHSL({ h: 0, s: 0, l: 0 }, SRGBColorSpace);

  it('tones tagged facades down: less saturated, no pure black or white', () => {
    expect(normalizeFacade('#ff0000')).toBe('#b75e5e');
    expect(normalizeFacade('#000000')).toBe('#4d4d4d');
    expect(normalizeFacade('#ffffff')).toBe('#e0e0e0');
    for (const hex of ['#00ff00', '#ff69b4', '#ffcc00', '#0000ff']) {
      expect(hsl(normalizeFacade(hex)).s).toBeLessThan(hsl(hex).s);
      expect(hsl(normalizeFacade(hex)).h).toBeCloseTo(hsl(hex).h, 2);
    }
  });

  it('matches the wall style expression channel for channel', async () => {
    const { expression } = await import('@maplibre/maplibre-gl-style-spec');
    const { wallRules } = await import('../../src/roofs/walls');
    const color = wallRules(DEFAULT_FIELDS, true)[1]!.wrap('#123456');
    const parsed = expression.createExpression(
      color as never,
      {
        type: 'color',
        'property-type': 'data-driven',
        expression: { interpolated: true, parameters: ['zoom', 'feature'] },
      } as never,
    );
    if (parsed.result !== 'success') throw new Error(JSON.stringify(parsed.value));
    const hexOf = (properties: Record<string, unknown>) => {
      const c = parsed.value.evaluate({ zoom: 16 }, { properties, type: 'Polygon' } as never) as {
        r: number;
        g: number;
        b: number;
      };
      return `#${new Color().setRGB(c.r, c.g, c.b, SRGBColorSpace).getHexString()}`;
    };
    expect(hexOf({ facade_color: 'hotpink' })).toBe(normalizeFacade('#ff69b4'));
    expect(hexOf({ facade_color: '#0a0' })).toBe(normalizeFacade('#00aa00'));
    expect(hexOf({ facade_material: 'gold' })).toBe(normalizeFacade('#ffcc00'));
    // Untagged (or unparseable) walls keep the style's own colour.
    expect(hexOf({})).toBe('#123456');
    expect(hexOf({ facade_color: 'nonsense' })).toBe('#123456');
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

describe('buildingHeight / buildingBase', () => {
  it('give the walls the heights the roofs use (tagged, then floors, then a default)', async () => {
    const { expression } = await import('@maplibre/maplibre-gl-style-spec');
    const evaluate = (expr: unknown, properties: Record<string, unknown>) => {
      const parsed = expression.createExpression(
        expr as never,
        {
          type: 'number',
          'property-type': 'data-driven',
          expression: { interpolated: true, parameters: ['zoom', 'feature'] },
        } as never,
      );
      if (parsed.result !== 'success') throw new Error(parsed.value.map((e) => e.message).join());
      return parsed.value.evaluate({ zoom: 16 }, { type: 'Polygon', properties } as never);
    };
    expect(evaluate(buildingHeight(), { height: 20, num_floors: 4 })).toBe(20);
    expect(evaluate(buildingHeight(), { num_floors: 4, roof_height: 3 })).toBe(15);
    expect(evaluate(buildingHeight(), {})).toBe(10);
    expect(evaluate(buildingHeight(DEFAULT_FIELDS, 6), {})).toBe(6);
    expect(evaluate(buildingBase(), { min_floor: 2 })).toBe(6);
    expect(evaluate(buildingBase(), { min_height: 4, min_floor: 2 })).toBe(4);
    expect(evaluate(buildingBase(), {})).toBe(0);
    for (const props of [
      { num_floors: 4, roof_height: 3, roof_shape: 'gabled' },
      { min_floor: 2, num_floors: 5, roof_shape: 'gabled' },
    ])
      expect(read(props)).toMatchObject({
        height: evaluate(buildingHeight(), props),
        minHeight: evaluate(buildingBase(), props),
      });
  });
});
