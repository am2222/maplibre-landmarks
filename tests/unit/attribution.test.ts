import { describe, expect, it, vi } from 'vitest';
import {
  AttributionSource,
  attributionText,
  LICENCES_URL,
  type AttributionTarget,
} from '../../src/landmarks/attribution';

describe('attributionText', () => {
  it('lists unique attributions, escapes HTML and links the licences', () => {
    const text = attributionText(
      [{ attribution: 'IGN <LiDAR>' }, { attribution: 'IGN <LiDAR>' }],
      'Open Landmarks; © OpenStreetMap contributors',
    );
    expect(text).toContain(LICENCES_URL);
    expect(text).toContain('IGN &lt;LiDAR&gt;');
    expect(text.match(/IGN/g)).toHaveLength(1);
    expect(text.match(/OpenStreetMap/g)).toHaveLength(1);
  });

  it('always credits OpenStreetMap', () => {
    expect(attributionText([{ attribution: 'X' }])).toContain('© OpenStreetMap contributors');
  });
});

function fakeStyle() {
  const layers = new Set<string>();
  const sources = new Map<string, unknown>();
  const map = {
    getLayer: vi.fn((id: string) => (layers.has(id) ? { id } : undefined)),
    getSource: vi.fn((id: string) => sources.get(id)),
    addSource: vi.fn((id: string, spec: unknown) => sources.set(id, spec)),
    addLayer: vi.fn((spec: { id: string }) => layers.add(spec.id)),
    removeLayer: vi.fn((id: string) => layers.delete(id)),
    removeSource: vi.fn((id: string) => sources.delete(id)),
  };
  return { map, layers, sources, target: map as unknown as AttributionTarget };
}

describe('AttributionSource', () => {
  it('adds a used source carrying the attribution and replaces it on change', () => {
    const { map, sources, layers, target } = fakeStyle();
    const src = new AttributionSource(target, 'lm-attr');
    src.set('A');
    expect((sources.get('lm-attr') as { attribution: string }).attribution).toBe('A');
    expect(layers.has('lm-attr')).toBe(true);
    src.set('A');
    expect(map.addSource).toHaveBeenCalledTimes(1);
    src.set('B');
    expect((sources.get('lm-attr') as { attribution: string }).attribution).toBe('B');
    src.set('');
    expect(sources.size).toBe(0);
    expect(layers.size).toBe(0);
  });

  it('remove() survives a torn-down style', () => {
    const { map, target } = fakeStyle();
    const src = new AttributionSource(target, 'lm-attr');
    src.set('A');
    map.getLayer.mockImplementation(() => {
      throw new Error('style is gone');
    });
    expect(() => src.remove()).not.toThrow();
  });
});
