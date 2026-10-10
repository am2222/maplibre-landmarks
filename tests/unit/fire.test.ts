import { describe, expect, it, vi } from 'vitest';
import { Scene } from 'three';
import type { ModuleContext } from '../../src/core/LayerModule';
import {
  buildField,
  distanceTransform,
  fronts,
  outwardAt,
  rasterise,
  resample,
  sampleField,
  type FirePolygons,
} from '../../src/fire/field';
import { FireModule, firesOf } from '../../src/fire/FireModule';
import { view } from './helpers';

const square = (x0: number, z0: number, size: number) => [
  [x0, z0],
  [x0 + size, z0],
  [x0 + size, z0 + size],
  [x0, z0 + size],
  [x0, z0],
];
const fire = (polygons: number[][][][], rate = 1, active = true): FirePolygons => ({
  polygons,
  rate,
  active,
});
const rect = { minX: 0, minZ: 0, cell: 1, nx: 40, nz: 40 };

describe('rasterise', () => {
  it('fills cell centres inside each polygon with its fire, leaving holes empty', () => {
    const owner = rasterise(
      [fire([[square(5, 5, 20), square(10, 10, 5)]]), fire([[square(30, 30, 5)]])],
      rect,
    );
    const at = (x: number, z: number) => owner[z * 40 + x];
    expect(at(6, 6)).toBe(0);
    expect(at(12, 12)).toBe(-1); // the hole
    expect(at(31, 31)).toBe(1);
    expect(at(2, 2)).toBe(-1);
  });
});

describe('distanceTransform', () => {
  it('matches brute-force squared distances and finds the nearest site', () => {
    const nx = 13;
    const nz = 9;
    const sites = [5, 40, 77, 100];
    const { d2, nearest } = distanceTransform((i) => sites.includes(i), nx, nz);
    for (let i = 0; i < nx * nz; i++) {
      const [x, z] = [i % nx, Math.floor(i / nx)];
      const best = Math.min(
        ...sites.map((s) => ((s % nx) - x) ** 2 + (Math.floor(s / nx) - z) ** 2),
      );
      expect(d2[i]).toBe(best);
      const s = nearest[i]!;
      expect(((s % nx) - x) ** 2 + (Math.floor(s / nx) - z) ** 2).toBe(best);
    }
  });

  it('reports no nearest site when there are none', () => {
    const { nearest } = distanceTransform(() => false, 4, 4);
    expect([...nearest].every((n) => n === -1)).toBe(true);
  });
});

describe('buildField', () => {
  it('is negative inside, positive outside, and zero about on the perimeter', () => {
    const field = buildField([fire([[square(10, 10, 20)]])], rect);
    // Within a cell of the true distance.
    expect(Math.abs(sampleField(field, 20, 20)[0] + 10)).toBeLessThanOrEqual(1);
    expect(Math.abs(sampleField(field, 35, 20)[0] - 5)).toBeLessThanOrEqual(1);
    expect(Math.abs(sampleField(field, 10, 20)[0])).toBeLessThan(1);
    const [nx, nz] = outwardAt(field, 31, 20);
    expect(nx).toBeCloseTo(1, 1);
    expect(nz).toBeCloseTo(0, 1);
  });

  it('carries the nearest fire’s spread and flag, and merges overlapping fires', () => {
    const field = buildField(
      [fire([[square(2, 2, 10)]], 2), fire([[square(26, 26, 10)]], 3, false)],
      rect,
    );
    expect(sampleField(field, 13, 7)).toEqual([expect.any(Number), 2, 1]);
    // A contained fire never spreads.
    expect(sampleField(field, 38, 31).slice(1)).toEqual([0, 0]);
    const merged = buildField([fire([[square(5, 5, 12)]]), fire([[square(15, 5, 12)]])], rect);
    expect(fronts(merged)).toHaveLength(1);
  });
});

describe('fronts', () => {
  it('traces one closed front per perimeter, holes included, closing at the grid edge', () => {
    const field = buildField([fire([[square(5, 5, 25), square(12, 12, 8)]])], rect);
    const lines = fronts(field);
    expect(lines).toHaveLength(2);
    // A fire over the edge of the field still gets a closed front.
    const edge = buildField([fire([[square(-10, 10, 20)]])], rect);
    expect(fronts(edge)).toHaveLength(1);
  });

  it('resamples a front evenly with growing arc length', () => {
    const field = buildField([fire([[square(10, 10, 20)]])], rect);
    const points = resample(fronts(field)[0]!, 2);
    expect(points.length).toBeGreaterThan(30);
    expect(points.length).toBeLessThan(50);
    for (let i = 1; i < points.length; i++)
      expect(points[i]!.arc).toBeGreaterThan(points[i - 1]!.arc);
  });
});

describe('firesOf', () => {
  const polygon = (lng: number, lat: number) => ({
    type: 'Polygon',
    coordinates: [
      [
        [lng, lat],
        [lng + 0.01, lat],
        [lng + 0.01, lat + 0.01],
        [lng, lat + 0.01],
        [lng, lat],
      ],
    ],
  });
  const rate = (p: Record<string, unknown>) => (typeof p.rate === 'number' ? p.rate : 1);
  const active = (p: Record<string, unknown>) => p.active !== false;

  it('reads features, multipolygons and geometry collections with their properties', () => {
    const fires = firesOf(
      {
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', geometry: polygon(0, 0), properties: { rate: 2 } },
          { type: 'Feature', geometry: polygon(1, 0), properties: { active: false } },
          { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] } },
          { type: 'GeometryCollection', geometries: [polygon(2, 0)] },
        ],
      },
      rate,
      active,
    );
    expect(fires).toHaveLength(3);
    expect(fires[0]!.rate).toBe(2);
    expect(fires[1]!.active).toBe(false);
    // 0.01° × 0.01° at the equator: about 123 ha.
    expect(fires[0]!.area / 1e4).toBeCloseTo(123, -1);
  });

  it('ignores anything that is not a polygon', () => {
    expect(firesOf(null, rate, active)).toEqual([]);
    expect(firesOf({ type: 'LineString', coordinates: [] }, rate, active)).toEqual([]);
  });
});

describe('FireModule', () => {
  const data = {
    type: 'Polygon',
    coordinates: [
      [
        [2.29, 48.85],
        [2.3, 48.85],
        [2.3, 48.86],
        [2.29, 48.86],
        [2.29, 48.85],
      ],
    ],
  };
  function setup(options = {}, terrain = false) {
    const handlers: Record<string, () => void> = {};
    const map = {
      on: (e: string, f: () => void) => (handlers[e] = f),
      off: vi.fn(),
      getTerrain: () => (terrain ? { source: 'dem' } : null),
      queryTerrainElevation: ([lng]: number[]) => 100 + (lng! - 2.29) * 10_000,
      getCanvas: () => ({ height: 800 }),
    };
    const scene = new Scene();
    const module = new FireModule({ data, ...options });
    module.onAdd({
      map,
      scene,
      core: { theme: 'day' },
      requestRepaint: vi.fn(),
    } as unknown as ModuleContext);
    module.update(view({ center: [2.295, 48.855], zoom: 13, bounds: [2.27, 48.84, 2.32, 48.87] }));
    return { module, scene };
  }

  it('builds the ground, flames and embers around the fires in view', () => {
    const { module } = setup();
    expect(module.ground!.visible).toBe(true);
    expect(module.flames!.visible).toBe(true);
    expect(module.flames!.geometry.instanceCount).toBeGreaterThan(100);
    expect(module.smoke!.visible).toBe(true);
    expect(module.embers!.visible).toBe(true);
    const stats = module.getStats();
    expect(stats.fires).toBe(1);
    expect(stats.mappedHa).toBeGreaterThan(70);
    // No terrain: one flat quad.
    expect(module.ground!.geometry.attributes.position!.count).toBe(4);
  });

  it('drapes the ground on the terrain', () => {
    const { module } = setup({ terrainSpacing: 100 }, true);
    const pos = module.ground!.geometry.attributes.position!;
    expect(pos.count).toBeGreaterThan(100);
    const ys = Array.from({ length: pos.count }, (_, i) => pos.getY(i));
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(50);
  });

  it('spreads while playing, holds when paused, and resets to the mapped perimeter', () => {
    const { module } = setup({ rate: 6, timeScale: 2 });
    module.frame(0);
    module.frame(50);
    module.frame(100);
    expect(module.getStats().spreadM).toBeCloseTo(6 * 2 * 0.1, 5);
    expect(module.uniforms.uGrowth.value).toBeGreaterThan(0);
    module.setPlaying(false);
    module.frame(150);
    expect(module.getStats().spreadM).toBeCloseTo(1.2, 5);
    // A new rate keeps the front where it is.
    module.setRate(3);
    expect(module.getStats().spreadM).toBeCloseTo(1.2, 5);
    module.resetSpread();
    expect(module.uniforms.uGrowth.value).toBe(0);
  });

  it('keeps the fire as it is while the view pans around it', () => {
    const { module } = setup();
    const field = module.uniforms.uField.value;
    const seeds = module.smoke!.geometry.attributes.aSeed!.array.slice();
    module.update(view({ center: [2.3, 48.857], zoom: 13.5, bounds: [2.28, 48.845, 2.32, 48.87] }));
    expect(module.uniforms.uField.value).toBe(field);
    // A real rebuild (new data) keeps the particles' seeds: nothing jumps.
    module.setData(data);
    module.update(view({ center: [2.3, 48.857], bounds: [2.28, 48.845, 2.32, 48.87] }));
    expect(module.uniforms.uField.value).not.toBe(field);
    expect(module.smoke!.geometry.attributes.aSeed!.array).toEqual(seeds);
  });

  it('trails the plume further in stronger wind', () => {
    const { module } = setup({ wind: { speed: 1 } });
    const calm = module.uniforms.uPlume.value;
    module.setWind({ speed: 10 });
    expect(module.uniforms.uPlume.value).toBeGreaterThan(calm * 2);
    expect(setup({ plumeLength: 5000 }).module.uniforms.uPlume.value).toBe(5000);
  });

  it('can leave the smoke out', () => {
    const { module } = setup({ smoke: false });
    expect(module.smoke!.visible).toBe(false);
    expect(module.flames!.visible).toBe(true);
  });

  it('draws nothing without fires in view', () => {
    const { module } = setup();
    module.setData(null);
    module.update(view({ center: [2.295, 48.855], bounds: [2.27, 48.84, 2.32, 48.87] }));
    expect(module.ground!.visible).toBe(false);
    expect(module.getStats().fires).toBe(0);
  });

  it('cleans up', () => {
    const { module, scene } = setup();
    module.onRemove();
    expect(scene.children.filter((c) => c.type !== 'Group')).toHaveLength(0);
    expect(module.uniforms.uField.value).toBeNull();
  });
});
