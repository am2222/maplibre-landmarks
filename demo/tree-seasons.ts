// Trees through the year, on a blank map (no keys or tilesets needed): a scattered park and a
// row of mapped street trees, with the season, snow and theme controls of TreesLayer.
import { Map as MlMap, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Feature } from 'geojson';
import { setTheme, TreesLayer, type Theme } from '../src/index';

setWorkerUrl(workerUrl);

const C: [number, number] = [2.3364, 48.8462]; // Jardin du Luxembourg, Paris
const M = 111_195;
const kx = M * Math.cos((C[1] * Math.PI) / 180);
const at = (e: number, n: number): [number, number] => [C[0] + e / kx, C[1] + n / M];
const rect = (e0: number, n0: number, e1: number, n1: number) => [
  at(e0, n0),
  at(e1, n0),
  at(e1, n1),
  at(e0, n1),
  at(e0, n0),
];

const features: Feature[] = [
  {
    type: 'Feature',
    id: 1,
    properties: { kind: 'park' },
    geometry: { type: 'Polygon', coordinates: [rect(-110, -45, 110, 60)] },
  },
];
// Street trees along both sides of an avenue south of the park.
for (let i = 0; i < 22; i++)
  for (const n of [-58, -72])
    features.push({
      type: 'Feature',
      id: 100 + features.length,
      properties: { kind: 'tree' },
      geometry: { type: 'Point', coordinates: at(-105 + i * 10, n) },
    });

// The basemap's ground is not part of the trees layer: the sample tints the park itself.
const GROUND: Record<string, string> = {
  spring: '#c6e0a8',
  summer: '#b9d79c',
  autumn: '#cfd09a',
  winter: '#eef2f4',
};
const NAMES = ['spring', 'summer', 'autumn', 'winter'] as const;

const map = new MlMap({
  container: 'map',
  center: at(0, -10),
  zoom: 17.8,
  pitch: 58,
  bearing: -15,
  style: {
    version: 8,
    sources: { t: { type: 'geojson', data: { type: 'FeatureCollection', features } } },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#e8e6e1' } },
      {
        id: 'park',
        type: 'fill',
        source: 't',
        filter: ['==', ['get', 'kind'], 'park'],
        paint: { 'fill-color': GROUND.autumn!, 'fill-color-transition': { duration: 1200 } },
      },
    ],
  },
});

const trees = new TreesLayer({
  id: 'trees',
  source: 't',
  sourceLayers: { points: '', polygons: '' },
  scatter: { park: 1 / 150 },
  density: 1,
  season: 'autumn',
  onError: (err) => console.warn('[trees]', err),
});
Object.assign(window, { map, trees });
map.on('load', () => map.addLayer(trees));

const buttons = [...document.querySelectorAll<HTMLButtonElement>('#seasons button')];
const scrub = document.querySelector<HTMLInputElement>('#scrub')!;
const play = document.querySelector<HTMLButtonElement>('#play')!;
let playing = 0;

const showSeason = (value: number) => {
  const name = NAMES[Math.round(value) % 4]!;
  for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.season === name));
  map.setPaintProperty('park', 'fill-color', GROUND[name]);
};
const stop = () => {
  cancelAnimationFrame(playing);
  playing = 0;
  play.textContent = 'Play year';
};

for (const b of buttons)
  b.addEventListener('click', () => {
    stop();
    trees.setSeason(b.dataset.season as (typeof NAMES)[number]);
    const value = NAMES.indexOf(b.dataset.season as (typeof NAMES)[number]);
    scrub.value = String(value);
    showSeason(value);
  });
scrub.addEventListener('input', () => {
  stop();
  trees.setSeason(Number(scrub.value), { durationMs: 0 });
  showSeason(Number(scrub.value));
});
play.addEventListener('click', () => {
  if (playing) return stop();
  play.textContent = 'Pause';
  let last = performance.now();
  const tick = (now: number) => {
    const value = (trees.getSeason() + ((now - last) / 1000) * 0.25) % 4;
    last = now;
    trees.setSeason(value, { durationMs: 0 });
    scrub.value = String(value);
    showSeason(value);
    playing = requestAnimationFrame(tick);
  };
  playing = requestAnimationFrame(tick);
});
document.querySelector<HTMLInputElement>('#snow')!.addEventListener('change', (e) => {
  trees.setSnow((e.target as HTMLInputElement).checked);
});
document.querySelector<HTMLSelectElement>('#theme')!.addEventListener('change', (e) => {
  setTheme(map, (e.target as HTMLSelectElement).value as Theme);
});
