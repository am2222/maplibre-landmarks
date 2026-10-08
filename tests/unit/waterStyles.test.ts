import { describe, expect, it } from 'vitest';
import { Color } from 'three';
import { WATER_COLORS, WATER_STYLES, WAVES, waterColors, waterStyle } from '../../src/water/styles';

const lum = (hex: string) => {
  const c = new Color(hex);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
};

describe('water styles', () => {
  it('maps Protomaps water kinds to styles', () => {
    expect(waterStyle({ kind: 'ocean' }, 'Polygon')).toBe('sea');
    expect(waterStyle({ kind: 'swimming_pool' }, 'Polygon')).toBe('pool');
    expect(waterStyle({ kind: 'fountain' }, 'Polygon')).toBe('pool');
    expect(waterStyle({ kind: 'water', kind_detail: 'basin' }, 'MultiPolygon')).toBe('pool');
    expect(waterStyle({ kind: 'water', kind_detail: 'river' }, 'Polygon')).toBe('river');
    expect(waterStyle({ kind: 'water', kind_detail: 'canal' }, 'Polygon')).toBe('river');
    expect(waterStyle({ kind: 'water', kind_detail: 'lake' }, 'Polygon')).toBe('lake');
    expect(waterStyle({ kind: 'water' }, 'Polygon')).toBe('lake');
    expect(waterStyle({}, 'Polygon')).toBe('lake');
  });

  it('ignores lines and points', () => {
    expect(waterStyle({ kind: 'river' }, 'LineString')).toBeNull();
    expect(waterStyle({ kind: 'fountain' }, 'Point')).toBeNull();
  });

  it('keeps the shader order and the spec wave values', () => {
    expect(WATER_STYLES).toEqual(['sea', 'lake', 'river', 'pool']);
    expect(WAVES.sea).toMatchObject({ scale: 40, amplitude: 1 });
    expect(WAVES.lake).toMatchObject({ scale: 12, amplitude: 0.45 });
    expect(WAVES.river).toMatchObject({ scale: 8, amplitude: 0.6 });
    expect(WAVES.pool).toMatchObject({ scale: 1.5, amplitude: 0.25 });
  });

  it('uses theme colours, deep darker than shallow, and overrides the shallow colour', () => {
    for (const theme of ['day', 'dawn', 'dusk', 'night'] as const)
      for (const s of WATER_STYLES)
        expect(lum(WATER_COLORS[theme][s].deep)).toBeLessThan(lum(WATER_COLORS[theme][s].shallow));
    expect(waterColors('day')).toEqual(WATER_COLORS.day);
    const c = waterColors('day', { lake: '#ff0000' });
    expect(c.lake.shallow).toBe('#ff0000');
    expect(lum(c.lake.deep)).toBeLessThan(lum('#ff0000'));
    expect(c.sea).toEqual(WATER_COLORS.day.sea);
  });
});
