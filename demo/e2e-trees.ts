import { Map as MlMap, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Feature } from 'geojson';
import { RainLayer, setTheme, TreesLayer, type Theme, type TreeStats } from '../src/index';

setWorkerUrl(workerUrl);

declare global {
  interface Window {
    __trees?: TreesLayer;
    __map?: MlMap;
    __errors: string[];
    __stats(): TreeStats;
    __setWind(strength: number): void;
    __setTheme(theme: Theme): void;
    __rain?: RainLayer;
    __addRain(): void;
  }
}

const C: [number, number] = [2.2945, 48.8556];
const M = 111_195;
const kx = M * Math.cos((C[1] * Math.PI) / 180);
const at = (e: number, n: number): [number, number] => [C[0] + e / kx, C[1] + n / M];
const square = (e: number, n: number, size: number) => [
  at(e - size / 2, n - size / 2),
  at(e + size / 2, n - size / 2),
  at(e + size / 2, n + size / 2),
  at(e - size / 2, n + size / 2),
  at(e - size / 2, n - size / 2),
];

const features: Feature[] = [];
let id = 1;
// 30 mapped trees on a 40 m ring around the centre.
for (let i = 0; i < 30; i++) {
  const a = (i / 30) * 2 * Math.PI;
  features.push({
    type: 'Feature',
    id: id++,
    properties: { kind: 'tree' },
    geometry: { type: 'Point', coordinates: at(Math.cos(a) * 40, Math.sin(a) * 40) },
  });
}
// A 60 m forest 90 m west, already holding 20 mapped trees (≥ 25% of 3600/60 = 60): not scattered.
features.push({
  type: 'Feature',
  id: 200,
  properties: { kind: 'forest' },
  geometry: { type: 'Polygon', coordinates: [square(-90, 0, 60)] },
});
for (let i = 0; i < 20; i++) {
  features.push({
    type: 'Feature',
    id: id++,
    properties: { kind: 'tree' },
    geometry: {
      type: 'Point',
      coordinates: at(-110 + (i % 5) * 10, -20 + Math.floor(i / 5) * 10),
    },
  });
}
// An 80 m park 90 m east with no mapped trees: scattered (6400/400 ≈ 16 trees).
features.push({
  type: 'Feature',
  id: 100,
  properties: { kind: 'park' },
  geometry: { type: 'Polygon', coordinates: [square(90, 0, 80)] },
});

window.__errors = [];
const map = new MlMap({
  container: 'map',
  center: C,
  zoom: 17,
  pitch: 50,
  canvasContextAttributes: { preserveDrawingBuffer: true },
  style: {
    version: 8,
    sources: { t: { type: 'geojson', data: { type: 'FeatureCollection', features } } },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#ffffff' } },
      // MapLibre only loads tiles for sources a style layer uses; keep `t` used, invisibly.
      { id: 't-used', type: 'circle', source: 't', paint: { 'circle-opacity': 0 } },
    ],
  },
});
window.__map = map;
map.on('error', (e) => window.__errors.push(String(e.error?.message ?? e)));
map.once('load', () => {
  const trees = new TreesLayer({
    id: 'trees',
    source: 't',
    sourceLayers: { points: '', polygons: '' },
    minZoom: 15,
    density: 1, // the scene checks scattering itself, not thinning
    theme: 'day',
    onError: (err, ctx) => window.__errors.push(`${ctx.stage}: ${String(err)}`),
  });
  window.__trees = trees;
  map.addLayer(trees);
});
window.__stats = () => window.__trees!.getStats();
window.__setWind = (strength) => window.__trees!.setWind({ strength });
window.__setTheme = (theme) => setTheme(map, theme);
window.__addRain = () => {
  window.__rain = new RainLayer({ id: 'rain', intensity: 1, lightning: false });
  map.addLayer(window.__rain);
};
