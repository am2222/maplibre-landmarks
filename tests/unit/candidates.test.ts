import { describe, expect, it, vi } from 'vitest';
import {
  CandidateScanner,
  labelLayerIds,
  roofHeight,
  type ScanMap,
} from '../../src/labels/candidates';

describe('labelLayerIds', () => {
  const layers = [
    { id: 'pois', type: 'symbol', 'source-layer': 'pois' },
    {
      id: 'poi_omt',
      type: 'symbol',
      'source-layer': 'poi',
      layout: { 'symbol-placement': 'point' },
    },
    { id: 'building_labels', type: 'symbol', 'source-layer': 'building' },
    {
      id: 'roads_labels',
      type: 'symbol',
      'source-layer': 'roads',
      layout: { 'symbol-placement': 'line' },
    },
    {
      id: 'pois_line',
      type: 'symbol',
      'source-layer': 'pois',
      layout: { 'symbol-placement': 'line' },
    },
    { id: 'places', type: 'symbol', 'source-layer': 'places' },
    { id: 'buildings', type: 'fill-extrusion', 'source-layer': 'buildings' },
  ];

  it('auto-detects point labels of POI and building layers', () => {
    expect(labelLayerIds(layers)).toEqual(['pois', 'poi_omt', 'building_labels']);
  });

  it('uses an override, keeping only symbol layers that exist', () => {
    expect(labelLayerIds(layers, ['places', 'gone', 'buildings'])).toEqual(['places']);
  });
});

describe('roofHeight', () => {
  it('prefers render_height, then height, then min_height + 9, then 0', () => {
    expect(roofHeight({ render_height: 30, height: 20 })).toBe(30);
    expect(roofHeight({ height: '20' })).toBe(20);
    expect(roofHeight({ min_height: 6 })).toBe(15);
    expect(roofHeight({})).toBe(0);
  });
});

const BUILDING = {
  type: 'Polygon',
  coordinates: [
    [
      [2.0, 48.0],
      [2.002, 48.0],
      [2.002, 48.002],
      [2.0, 48.002],
      [2.0, 48.0],
    ],
  ],
};

function label(id: number | undefined, lng: number, lat: number, source = 'protomaps') {
  return { id, source, sourceLayer: 'pois', geometry: { type: 'Point', coordinates: [lng, lat] } };
}

function fakeMap(over: Partial<Record<string, unknown>> = {}) {
  const labels = [
    label(1, 2.001, 48.001), // on the building's roof
    label(1, 2.001, 48.001), // same label from a neighbouring tile
    label(2, 2.01, 48.01), // open ground, further from the centre
    label(undefined, 2.0, 48.0), // no id: cannot be tracked
  ];
  let terrain: object | null = null;
  const map = {
    labels,
    setTerrain: (t: object | null) => (terrain = t),
    getTerrain: () => terrain,
    queryTerrainElevation: vi.fn(() => 100),
    getCenter: () => ({ lng: 2.001, lat: 48.001 }),
    getCanvas: () => ({ clientWidth: 2000, clientHeight: 2000 }),
    project: (ll: [number, number] | { lng: number; lat: number }) => {
      const [lng, lat] = Array.isArray(ll) ? ll : [ll.lng, ll.lat];
      return { x: (lng - 2) * 1e5, y: (48.02 - lat) * 1e5 };
    },
    getLayersOrder: () => ['pois', 'buildings'],
    getLayer: (id: string) =>
      ({ pois: { type: 'symbol', sourceLayer: 'pois' }, buildings: { type: 'fill-extrusion' } })[
        id as 'pois' | 'buildings'
      ],
    getLayoutProperty: () => undefined,
    queryRenderedFeatures: vi.fn((a: unknown, b?: { layers?: string[] }) => {
      const opts = (b ?? a) as { layers?: string[] };
      if (opts.layers?.includes('buildings')) {
        return [{ geometry: BUILDING, properties: { height: 30 } }];
      }
      return labels;
    }),
    ...over,
  };
  return map;
}
const asScan = (m: ReturnType<typeof fakeMap>) => m as unknown as ScanMap;

describe('CandidateScanner', () => {
  it('de-duplicates, drops id-less labels and orders by distance from the centre', () => {
    const map = fakeMap();
    const found = new CandidateScanner(asScan(map)).scan(['pois'], 10);
    expect(found.map((c) => c.key)).toEqual(['protomaps/pois/1', 'protomaps/pois/2']);
    expect(found[0]!.feature).toEqual({ source: 'protomaps', sourceLayer: 'pois', id: 1 });
  });

  it('caps at maxLabels', () => {
    expect(new CandidateScanner(asScan(fakeMap())).scan(['pois'], 1)).toHaveLength(1);
  });

  it('lifts probes above roofs and terrain', () => {
    const map = fakeMap();
    const s = new CandidateScanner(asScan(map));
    const [onRoof, onGround] = s.scan(['pois'], 10);
    expect(onRoof!.elevation).toBe(30 + 2.5);
    expect(onGround!.elevation).toBe(2.5);
    map.setTerrain({});
    expect(s.scan(['pois'], 10)[0]!.elevation).toBe(100 + 30 + 2.5);
  });

  it('caches roofs and spends at most the lookup budget per scan', () => {
    const map = fakeMap();
    const s = new CandidateScanner(asScan(map), 1);
    s.scan(['pois'], 10); // 1 label scan + 1 roof lookup (budget 1)
    expect(map.queryRenderedFeatures).toHaveBeenCalledTimes(2);
    s.scan(['pois'], 10); // label 1 cached; label 2 gets its lookup now
    expect(map.queryRenderedFeatures).toHaveBeenCalledTimes(4);
    s.scan(['pois'], 10); // both cached
    expect(map.queryRenderedFeatures).toHaveBeenCalledTimes(5);
    s.clearRoofs();
    s.scan(['pois'], 10);
    expect(map.queryRenderedFeatures).toHaveBeenCalledTimes(7);
  });

  it('marks labels inside exempt footprints and skips their roof lookup', () => {
    const map = fakeMap();
    const s = new CandidateScanner(asScan(map));
    s.setExemptions([BUILDING.coordinates]);
    const [exempt, other] = s.scan(['pois'], 10);
    expect(exempt!.exempt).toBe(true);
    expect(other!.exempt).toBe(false);
    expect(map.queryRenderedFeatures).toHaveBeenCalledTimes(2); // labels + label 2's roof
  });

  it('marks labels whose roof is not looked up yet as pending, not probed at ground', () => {
    const map = fakeMap();
    const [first, second] = new CandidateScanner(asScan(map), 1).scan(['pois'], 10);
    expect(first!.pending).toBe(false);
    expect(second!.pending).toBe(true); // budget spent: probing at ground would hide it
    const again = new CandidateScanner(asScan(fakeMap()), 48).scan(['pois'], 10);
    expect(again.every((c) => !c.pending)).toBe(true);
  });

  it('exempts labels whose anchor is off-screen (a clipped probe would read as hidden)', () => {
    const map = fakeMap();
    map.labels.push(label(3, 1.99, 48.001)); // x < 0
    const found = new CandidateScanner(asScan(map)).scan(['pois'], 10);
    expect(found.find((c) => c.key.endsWith('/3'))!.exempt).toBe(true);
    expect(found.find((c) => c.key.endsWith('/2'))!.exempt).toBe(false);
  });

  it('forgets ground-level roof results when building tiles arrive, keeping real roofs', () => {
    const map = fakeMap();
    const s = new CandidateScanner(asScan(map));
    s.scan(['pois'], 10); // labels + 2 roof lookups (label 2 on open ground → 0)
    expect(map.queryRenderedFeatures).toHaveBeenCalledTimes(3);
    s.forgetGround();
    s.scan(['pois'], 10); // label 1's roof (30 m) is kept; label 2 is looked up again
    expect(map.queryRenderedFeatures).toHaveBeenCalledTimes(5);
  });

  it('never queries with an empty layer list', () => {
    const map = fakeMap();
    expect(new CandidateScanner(asScan(map)).scan([], 10)).toEqual([]);
    expect(map.queryRenderedFeatures).not.toHaveBeenCalled();
  });
});
