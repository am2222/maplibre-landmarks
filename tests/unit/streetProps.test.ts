import { describe, expect, it } from 'vitest';
import { Box3 } from 'three';
import {
  directionDeg,
  hashedTurnDeg,
  PROP_COLOURS,
  PROP_KINDS,
  propGeometry,
  propScale,
} from '../../src/street/props';

describe('street props', () => {
  it('builds every kind standing on the ground, in metres, with a colour', () => {
    for (const kind of PROP_KINDS) {
      const g = propGeometry(kind);
      const box = new Box3().setFromBufferAttribute(g.getAttribute('position') as never);
      expect(box.min.y).toBeCloseTo(0, 6);
      expect(box.max.y).toBeGreaterThan(0.3);
      expect(box.max.y).toBeLessThan(3.5); // a statue on its plinth is the tallest
      expect(Math.max(box.max.x - box.min.x, box.max.z - box.min.z)).toBeLessThan(3);
      expect(g.getAttribute('normal')).toBeDefined();
      expect(PROP_COLOURS[kind]).toBeTypeOf('number');
    }
  });

  it('reads the OSM direction tag in degrees or compass letters', () => {
    expect(directionDeg({ direction: '135' })).toBe(135);
    expect(directionDeg({ direction: '-90' })).toBe(270);
    expect(directionDeg({ direction: 'NE' })).toBe(45);
    expect(directionDeg({ direction: 'wsw' })).toBe(247.5);
    expect(directionDeg({ direction: 'forward' })).toBeUndefined();
    expect(directionDeg({ direction: '300-30' })).toBeUndefined();
    expect(directionDeg({})).toBeUndefined();
  });

  it('turns untagged props by a stable angle from their position', () => {
    const a = hashedTurnDeg([2.35, 48.85]);
    expect(hashedTurnDeg([2.35, 48.85])).toBe(a);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(360);
    expect(hashedTurnDeg([2.3501, 48.85])).not.toBe(a);
  });

  it('includes fountains, artworks, masts and storage tanks', () => {
    for (const kind of ['fountain', 'artwork', 'communication_tower', 'storage_tank'])
      expect(PROP_KINDS).toContain(kind);
  });

  it('sizes masts and tanks from their tags and skips what is not drawn', () => {
    expect(propScale('bench', {})).toEqual([1, 1, 1]);
    // Only free-standing figures among artworks: no murals, no architecture.
    expect(propScale('artwork', { artwork_type: 'statue' })).toEqual([1, 1, 1]);
    expect(propScale('artwork', { artwork_type: 'Sculpture' })).toEqual([1, 1, 1]);
    expect(propScale('artwork', { artwork_type: 'mural' })).toBeNull();
    expect(propScale('artwork', {})).toBeNull();
    // A unit-height mast stretched to the tagged height (30 m untagged).
    expect(propScale('communication_tower', { height: '139' })).toEqual([139, 139, 139]);
    expect(propScale('communication_tower', {})).toEqual([30, 30, 30]);
    // A unit cylinder: radius across, height up (10 m wide, 8 m tall untagged).
    expect(propScale('storage_tank', { height: '6' })).toEqual([5, 6, 5]);
    expect(propScale('storage_tank', { diameter: '20 m' })).toEqual([10, 8, 10]);
    expect(propScale('storage_tank', { location: 'underground' })).toBeNull();
  });
});
