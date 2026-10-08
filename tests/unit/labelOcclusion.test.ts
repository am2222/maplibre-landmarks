import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Matrix4 } from 'three';
import type { Map as MlMap } from 'maplibre-gl';
import { LabelOcclusion } from '../../src/labels/LabelOcclusion';
import { setExemptionSource } from '../../src/labels/exemptions';
import { LABEL_STATE } from '../../src/labels/opacity';
import { fakeGl } from './fakeGl';

const FRAME = {
  defaultProjectionData: { mainMatrix: new Matrix4().toArray(), projectionTransition: 0 },
} as never;

function fakeMap() {
  const handlers = new Map<string, (e?: unknown) => void>();
  const styleLayers = [
    { id: 'roads', type: 'line' },
    { id: 'landmarks', type: 'custom' },
    { id: 'pois', type: 'symbol', sourceLayer: 'pois', source: 'protomaps' },
  ];
  const order = ['roads', 'landmarks', 'pois', 'label-occlusion'];
  const paint: Record<string, Record<string, unknown>> = { pois: { 'text-opacity': 1 } };
  const states = new Map<unknown, Record<string, unknown>>();
  const point = (id: number, lng: number) => ({
    id,
    source: 'protomaps',
    sourceLayer: 'pois',
    geometry: { type: 'Point', coordinates: [lng, 48.85] },
  });
  const map = {
    handlers,
    styleLayers,
    order,
    paint,
    states,
    zoom: 16,
    labels: [point(1, 2.29), point(2, 2.3)],
    on: vi.fn((t: string, fn: (e?: unknown) => void) => handlers.set(t, fn)),
    off: vi.fn((t: string) => handlers.delete(t)),
    getZoom: () => map.zoom,
    getCenter: () => ({ lng: 2.29, lat: 48.85 }),
    getCanvas: () => ({ clientWidth: 800, clientHeight: 600 }),
    layout: {} as Record<string, unknown>,
    getLayoutProperty: (_id: string, p: string) => map.layout[p],
    project: () => ({ x: 0, y: 0 }),
    getTerrain: () => null,
    queryTerrainElevation: () => 0,
    getPixelRatio: () => map.pixelRatio,
    pixelRatio: 1,
    extra: {} as Record<string, object>,
    getLayer: (id: string): object | undefined =>
      map.extra[id] ??
      (id === 'label-occlusion' && order.includes(id)
        ? { id, type: 'custom' }
        : styleLayers.find((l) => l.id === id)),
    getLayersOrder: () => [...order],
    moveLayer: vi.fn((id: string, before?: string) => {
      order.splice(order.indexOf(id), 1);
      order.splice(before ? order.indexOf(before) : order.length, 0, id);
    }),
    queryRenderedFeatures: vi.fn((opts: { layers: string[] }) => {
      for (const id of opts.layers) if (!styleLayers.some((l) => l.id === id)) throw new Error(id);
      return map.labels;
    }),
    getPaintProperty: (id: string, p: string) => paint[id]?.[p],
    setPaintProperty: vi.fn((id: string, p: string, v: unknown) => ((paint[id] ??= {})[p] = v)),
    setFeatureState: vi.fn((f: { id: unknown }, s: Record<string, unknown>) =>
      states.set(f.id, { ...states.get(f.id), ...s }),
    ),
    removeFeatureState: vi.fn((f: { id: unknown }) => states.delete(f.id)),
    triggerRepaint: vi.fn(),
  };
  return map;
}

const stateOf = (m: ReturnType<typeof fakeMap>, id: number) =>
  m.states.get(id)?.[LABEL_STATE] as number | undefined;

function setup(options = {}) {
  const map = fakeMap();
  const f = fakeGl();
  const layer = new LabelOcclusion({ fadeMs: 0, ...options });
  layer.onAdd(map as unknown as MlMap, f.gl);
  vi.advanceTimersByTime(0); // first scan
  return { map, f, layer };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('LabelOcclusion', () => {
  it('moves itself between the 3D layers and the first label layer', () => {
    const { map } = setup();
    expect(map.order).toEqual(['roads', 'landmarks', 'label-occlusion', 'pois']);
  });

  it('wraps label opacity and hides labels whose probe is occluded', () => {
    const { map, f, layer } = setup();
    expect(map.paint.pois!['text-opacity']).toEqual([
      '*',
      1,
      ['coalesce', ['feature-state', LABEL_STATE], 1],
    ]);
    layer.render(f.gl, FRAME);
    expect(f.drawn).toHaveLength(2);
    f.answer((first) => first === 0); // label 1 visible, label 2 behind something
    vi.advanceTimersByTime(20); // result polling frame
    expect(stateOf(map, 1)).toBe(1);
    expect(stateOf(map, 2)).toBe(0);
  });

  it('never hides labels inside an exempt footprint', () => {
    const map0 = fakeMap();
    setExemptionSource(map0, 'landmarks', () => [
      [
        [
          [2.28, 48.84],
          [2.295, 48.84],
          [2.295, 48.86],
          [2.28, 48.86],
          [2.28, 48.84],
        ],
      ],
    ]);
    const f = fakeGl();
    const layer = new LabelOcclusion({ fadeMs: 0 });
    layer.onAdd(map0 as unknown as MlMap, f.gl);
    vi.advanceTimersByTime(0);
    layer.render(f.gl, FRAME);
    expect(f.drawn.map((d) => d.first)).toEqual([0]); // only label 2 is probed
    f.answer(() => false);
    vi.advanceTimersByTime(20);
    expect(stateOf(map0, 1)).toBe(1);
    expect(stateOf(map0, 2)).toBe(0);
    setExemptionSource(map0, 'landmarks', null);
  });

  it('re-scans when the map goes idle, for labels placed after the last scan', () => {
    const map = fakeMap();
    const placed = map.labels;
    map.labels = []; // symbols not placed yet when the layer is added
    const f = fakeGl();
    const layer = new LabelOcclusion({ fadeMs: 0 });
    layer.onAdd(map as unknown as MlMap, f.gl);
    vi.advanceTimersByTime(0);
    map.labels = placed;
    map.handlers.get('idle')!();
    vi.advanceTimersByTime(100);
    layer.render(f.gl, FRAME);
    expect(f.drawn).toHaveLength(2);
  });

  it('settles: an idle re-scan that finds nothing new does not repaint', () => {
    const { map } = setup();
    vi.advanceTimersByTime(100);
    map.triggerRepaint.mockClear();
    map.handlers.get('idle')!();
    vi.advanceTimersByTime(100);
    expect(map.triggerRepaint).not.toHaveBeenCalled();
  });

  it('keeps pending labels out of the probe set', async () => {
    const { CandidateScanner } = await import('../../src/labels/candidates');
    const scan = vi.spyOn(CandidateScanner.prototype, 'scan').mockReturnValue([
      {
        key: 'a',
        feature: { source: 's', id: 1 },
        lngLat: [2.29, 48.85],
        elevation: 2.5,
        exempt: false,
        pending: true,
      },
      {
        key: 'b',
        feature: { source: 's', id: 2 },
        lngLat: [2.3, 48.85],
        elevation: 2.5,
        exempt: false,
        pending: false,
      },
    ]);
    const { map, f, layer } = setup();
    layer.render(f.gl, FRAME);
    expect(f.drawn.map((d) => d.first)).toEqual([0]); // only 'b'
    scan.mockClear();
    vi.advanceTimersByTime(100); // a pending label schedules a quick follow-up scan
    expect(scan).toHaveBeenCalled();
    scan.mockRestore();
    void map;
  });

  it('shows labels again when the layer is hidden with visibility: none', () => {
    const { map, f, layer } = setup();
    layer.render(f.gl, FRAME);
    f.answer(() => false);
    vi.advanceTimersByTime(20);
    expect(stateOf(map, 2)).toBe(0);
    map.layout.visibility = 'none';
    map.handlers.get('styledata')!();
    vi.advanceTimersByTime(100);
    expect(map.states.has(2)).toBe(false);
  });

  it('a diffed setStyle resets labels it had hidden instead of forgetting them', () => {
    const { map, f, layer } = setup();
    layer.render(f.gl, FRAME);
    f.answer(() => false);
    vi.advanceTimersByTime(20);
    expect(stateOf(map, 2)).toBe(0);
    map.labels = []; // tiles re-laid out after the diff: not found by the first re-scan
    map.handlers.get('style.load')!();
    vi.advanceTimersByTime(100);
    expect(map.states.has(2)).toBe(false); // shown, not stuck hidden
  });

  it('sizes probes with the map pixel ratio, not the device one', () => {
    const { map, f, layer } = setup();
    map.pixelRatio = 3;
    layer.render(f.gl, FRAME);
    expect(f.raw.uniform1f).toHaveBeenCalledWith(expect.anything(), 12);
  });

  it('ignores 2D custom layers and other occlusion layers when placing itself', () => {
    const map = fakeMap();
    map.order.splice(2, 0, 'overlay'); // a 2D custom layer above the 3D content
    map.extra.overlay = { id: 'overlay', type: 'custom', implementation: { renderingMode: '2d' } };
    const f = fakeGl();
    const a = new LabelOcclusion({ fadeMs: 0 });
    const b = new LabelOcclusion({ id: 'second', fadeMs: 0 });
    map.order.push('second');
    map.extra.second = { id: 'second', type: 'custom', implementation: b };
    a.onAdd(map as unknown as MlMap, f.gl);
    b.onAdd(map as unknown as MlMap, f.gl);
    for (let i = 0; i < 3; i++) map.handlers.get('styledata')!(); // each instance listens
    const moves = map.moveLayer.mock.calls.length;
    for (let i = 0; i < 3; i++) map.handlers.get('styledata')!();
    expect(map.moveLayer.mock.calls.length).toBe(moves); // settled: no ping-pong
    expect(map.order.indexOf('label-occlusion')).toBe(map.order.indexOf('landmarks') + 1);
    expect(map.order.indexOf('label-occlusion')).toBeLessThan(map.order.indexOf('pois'));
  });

  it('re-looks up ground-level roofs when building tiles arrive', async () => {
    const { CandidateScanner } = await import('../../src/labels/candidates');
    const forget = vi.spyOn(CandidateScanner.prototype, 'forgetGround');
    const { map } = setup();
    map.styleLayers.push({ id: 'b3d', type: 'fill-extrusion', source: 'bsrc' } as never);
    map.order.push('b3d');
    map.handlers.get('sourcedata')!({ sourceId: 'other' } as never);
    expect(forget).not.toHaveBeenCalled();
    map.handlers.get('sourcedata')!({ sourceId: 'bsrc' } as never);
    expect(forget).toHaveBeenCalledTimes(1);
    forget.mockRestore();
  });

  it('ignores late probe answers while every label is being shown', () => {
    const { map, f, layer } = setup();
    layer.render(f.gl, FRAME); // queries in flight
    map.zoom = 14; // below minZoom: show everything
    layer.render(f.gl, FRAME);
    f.answer(() => false); // the earlier queries now say "hidden"
    vi.advanceTimersByTime(20);
    expect(stateOf(map, 2)).not.toBe(0);
  });

  it('shows everything below minZoom and stops probing', () => {
    const { map, f, layer } = setup();
    layer.render(f.gl, FRAME);
    f.answer(() => false);
    vi.advanceTimersByTime(20);
    expect(stateOf(map, 1)).toBe(0);
    map.zoom = 14;
    map.handlers.get('moveend')!();
    vi.advanceTimersByTime(100);
    expect(map.states.has(1)).toBe(false); // dropped labels are reset to the default (shown)
    layer.render(f.gl, FRAME);
    expect(f.drawn).toHaveLength(0);
  });

  it('only scans label layers that still exist', () => {
    const { map } = setup();
    map.styleLayers.splice(2, 1); // app removed the POI layer
    map.handlers.get('moveend')!();
    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
  });

  it('does nothing without label layers or without WebGL2', () => {
    const map = fakeMap();
    map.styleLayers.splice(2, 1);
    const f = fakeGl();
    const layer = new LabelOcclusion({ fadeMs: 0 });
    layer.onAdd(map as unknown as MlMap, f.gl);
    vi.advanceTimersByTime(0);
    expect(map.queryRenderedFeatures).not.toHaveBeenCalled();
    const { f: f2, layer: l2 } = setup();
    const webgl1 = { ...f2.raw, createQuery: undefined } as unknown as WebGL2RenderingContext;
    expect(() => l2.render(webgl1, FRAME)).not.toThrow();
    expect(f2.drawn).toHaveLength(0);
  });

  it('shows all labels on context loss and rebuilds after restore', () => {
    const { map, f, layer } = setup();
    layer.render(f.gl, FRAME);
    f.answer(() => false);
    vi.advanceTimersByTime(20);
    expect(stateOf(map, 2)).toBe(0);
    map.handlers.get('webglcontextlost')!();
    vi.advanceTimersByTime(20);
    expect(stateOf(map, 2)).toBe(1);
    const restored = fakeGl();
    map.handlers.get('webglcontextrestored')!();
    vi.advanceTimersByTime(0);
    layer.render(restored.gl, FRAME);
    expect(restored.drawn).toHaveLength(2); // a fresh probe on the new context
  });

  it('reports shader failures once and leaves labels alone', () => {
    const onError = vi.fn();
    const { map, layer } = setup({ onError });
    const bad = fakeGl();
    bad.failCompile();
    layer.render(bad.gl, FRAME);
    layer.render(bad.gl, FRAME);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(stateOf(map, 2)).not.toBe(0);
  });

  it('removal restores paint, clears feature-state and deletes GL objects', () => {
    const { map, f, layer } = setup();
    layer.render(f.gl, FRAME);
    f.answer(() => false);
    vi.advanceTimersByTime(20);
    layer.onRemove(map as unknown as MlMap, f.gl);
    expect(map.paint.pois!['text-opacity']).toBe(1);
    expect(map.states.size).toBe(0);
    expect(f.raw.deleteProgram).toHaveBeenCalled();
    expect(map.handlers.size).toBe(0);
  });

  it('re-wraps after a diffed setStyle and tears down cleanly after a full one', () => {
    const { map, f, layer } = setup();
    layer.render(f.gl, FRAME);
    f.answer(() => false);
    vi.advanceTimersByTime(20);
    // Diffed: paint reset by the new style, layer kept.
    map.paint.pois!['text-opacity'] = 0.9;
    map.handlers.get('style.load')!();
    vi.advanceTimersByTime(0);
    expect(map.paint.pois!['text-opacity']).toEqual([
      '*',
      0.9,
      ['coalesce', ['feature-state', LABEL_STATE], 1],
    ]);
    // Full: our layer is gone and the new style must not be touched.
    map.order.splice(map.order.indexOf('label-occlusion'), 1);
    map.paint.pois!['text-opacity'] = 0.7;
    map.setPaintProperty.mockClear();
    map.removeFeatureState.mockClear();
    map.handlers.get('style.load')!();
    expect(map.setPaintProperty).not.toHaveBeenCalled();
    expect(map.removeFeatureState).not.toHaveBeenCalled();
    expect(map.handlers.size).toBe(0);
  });
});
