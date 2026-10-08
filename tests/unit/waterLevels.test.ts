import { describe, expect, it } from 'vitest';
import { flatLevel, levelGroups } from '../../src/water/levels';

const piece = (key: string, props: string, links: string[] = []) => ({ key, props, links });

describe('water levels', () => {
  it('groups pieces linked across tile cuts with the same properties, transitively', () => {
    const g = levelGroups([
      piece('a', 'lake', ['b']),
      piece('b', 'lake', ['c']), // a-b-c: one lake cut into three tiles
      piece('c', 'lake'),
      piece('d', 'lake'), // same (unnamed) properties, but a separate lake
      piece('e', 'river', ['a']), // a river flowing into the lake keeps its own level
      piece('f', 'lake', ['gone']), // link to a piece no longer drawn
    ]);
    expect(g.get('a')).toBe(g.get('b'));
    expect(g.get('b')).toBe(g.get('c'));
    expect(g.get('d')).not.toBe(g.get('a'));
    expect(g.get('e')).not.toBe(g.get('a'));
    expect(g.get('f')).toBe('f');
  });

  it('sits at the upper quartile of the ground sampled inside the water, or null without data', () => {
    const at = [0, 0, 1, 0, 2, 0, 3, 0, 4, 0];
    // Shores dip below the lake surface in the DEM; the water must clear the surface itself.
    expect(flatLevel(at, (x) => [438, 446, 447, 447.5, 448][x]!)).toBe(447.5);
    expect(flatLevel(at.slice(0, 6), (x) => (x === 1 ? null : 50 + x))).toBe(52);
    expect(flatLevel(at, () => null)).toBeNull();
  });
});
