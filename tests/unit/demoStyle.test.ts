import { describe, expect, it } from 'vitest';
import type { LayerSpecification } from 'maplibre-gl';
import { firstPointLabel, styleFor } from '../../demo/style';

const along = (l: LayerSpecification) =>
  l.type === 'symbol' && String(l.layout?.['symbol-placement'] ?? 'point').startsWith('line');

describe('demo style', () => {
  for (const roofData of ['overture', 'none'] as const)
    it(`keeps street names and arrows on the ground, under the 3D buildings (${roofData})`, () => {
      const { layers } = styleFor({
        theme: 'day',
        basemap: 'streets',
        projection: 'mercator',
        terrain: false,
        roofData,
        roofsUrl: 'x.pmtiles',
        roofParts: true,
        protomaps: 'x.json',
      });
      const walls = layers.findIndex((l) => l.type === 'fill-extrusion');
      const lines = layers.filter(along);
      expect(lines.length).toBeGreaterThan(0);
      for (const l of lines) expect(layers.indexOf(l)).toBeLessThan(walls);
      const points = layers.filter((l) => l.type === 'symbol' && !along(l));
      for (const l of points) expect(layers.indexOf(l)).toBeGreaterThan(walls);
      // Custom 3D layers (trees, roofs, landmarks) go in right there too.
      expect(layers.findIndex((l) => l.id === firstPointLabel(layers))).toBeGreaterThan(walls);
    });
});
