// Every roof shape side by side, on a blank map (no keys or tilesets needed).
import { Map as MlMap, Marker, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Feature, Polygon } from 'geojson';
import { RoofsLayer } from '../src/index';

setWorkerUrl(workerUrl);

const SHAPES = [
  'gabled',
  'saltbox',
  'hipped',
  'half_hipped',
  'gambrel',
  'mansard',
  'skillion',
  'round',
  'butterfly',
  'crosspitched',
  'sawtooth',
  'pyramidal',
  'cone',
  'dome',
  'onion',
];
const ORIGIN: [number, number] = [2.35, 48.85];
const COLS = 5;
const SPACING_M = 45;
const M_LAT = 1 / 111_320;
const M_LNG = M_LAT / Math.cos((ORIGIN[1] * Math.PI) / 180);

const at = (x: number, y: number): [number, number] => [
  ORIGIN[0] + x * M_LNG,
  ORIGIN[1] - y * M_LAT,
];

const features: Feature<Polygon>[] = SHAPES.map((shape, i) => {
  const cx = (i % COLS) * SPACING_M;
  const cy = Math.floor(i / COLS) * SPACING_M;
  const radial = ['cone', 'dome', 'onion', 'pyramidal'].includes(shape);
  // Wide enough for three sawtooth teeth; square for the radial shapes.
  const [w, d] = shape === 'sawtooth' ? [30, 24] : radial ? [16, 16] : [28, 16];
  return {
    type: 'Feature',
    id: i + 1,
    properties: { height: 16, roof_shape: shape },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          at(cx - w / 2, cy - d / 2),
          at(cx + w / 2, cy - d / 2),
          at(cx + w / 2, cy + d / 2),
          at(cx - w / 2, cy + d / 2),
          at(cx - w / 2, cy - d / 2),
        ],
      ],
    },
  };
});

const map = new MlMap({
  container: 'map',
  center: at(2 * SPACING_M, SPACING_M),
  zoom: 17.3,
  pitch: 55,
  bearing: -20,
  style: {
    version: 8,
    sources: { b: { type: 'geojson', data: { type: 'FeatureCollection', features } } },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#eef0ea' } },
      {
        id: 'b-3d',
        type: 'fill-extrusion',
        source: 'b',
        paint: { 'fill-extrusion-color': '#d9d4ce', 'fill-extrusion-height': ['get', 'height'] },
      },
    ],
  },
});
(window as unknown as { map: MlMap }).map = map;

map.on('load', () => {
  map.addLayer(
    new RoofsLayer({
      id: 'roofs',
      source: 'b',
      extrusionLayer: 'b-3d',
      wallColors: true,
      onError: (err) => console.warn('[roofs]', err),
    }),
  );
  SHAPES.forEach((shape, i) => {
    const el = document.createElement('div');
    el.className = 'label';
    el.textContent = shape;
    const cx = (i % COLS) * SPACING_M;
    const cy = Math.floor(i / COLS) * SPACING_M;
    new Marker({ element: el, anchor: 'top' }).setLngLat(at(cx, cy + 14)).addTo(map);
  });
});
