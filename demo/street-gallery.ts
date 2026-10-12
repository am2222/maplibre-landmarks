// Every street furniture kind and area shape side by side, on a blank map (no keys or tilesets).
import { Map as MlMap, Marker, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Feature } from 'geojson';
import { PROP_KINDS, StreetFurnitureLayer } from '../src/index';

setWorkerUrl(workerUrl);

const ORIGIN: [number, number] = [2.35, 48.85];
const M_LAT = 1 / 111_320;
const M_LNG = M_LAT / Math.cos((ORIGIN[1] * Math.PI) / 180);
/** Metres east and south of the origin to lng/lat. */
const at = (x: number, y: number): [number, number] => [
  ORIGIN[0] + x * M_LNG,
  ORIGIN[1] - y * M_LAT,
];

let nextId = 1;
const labels: { text: string; at: [number, number] }[] = [];
const features: Feature[] = [];

const point = (cls: string, x: number, y: number, tags: object, label = cls) => {
  features.push({
    type: 'Feature',
    properties: { class: cls, id: String(nextId++), source_tags: JSON.stringify(tags) },
    geometry: { type: 'Point', coordinates: at(x, y) },
  });
  labels.push({ text: label, at: at(x, y + 2.5) });
};
const rect = (
  cls: string,
  x: number,
  y: number,
  w: number,
  d: number,
  tags: object,
  label: string,
) => {
  features.push({
    type: 'Feature',
    properties: { class: cls, id: String(nextId++), source_tags: JSON.stringify(tags) },
    geometry: {
      type: 'Polygon',
      coordinates: [[at(x, y), at(x + w, y), at(x + w, y + d), at(x, y + d), at(x, y)]],
    },
  });
  labels.push({ text: label, at: at(x + w / 2, y + d + 2) });
};

// Rows 1–2: the small props, 9 m apart, 8 to a row (artworks need a figure type to be drawn).
const SMALL = PROP_KINDS.filter((k) => k !== 'communication_tower' && k !== 'storage_tank');
SMALL.forEach((kind, i) =>
  point(
    kind,
    (i % 8) * 9,
    Math.floor(i / 8) * 12,
    kind === 'artwork' ? { artwork_type: 'statue' } : {},
  ),
);
// Row 3: masts and tanks, sized from their tags.
point('communication_tower', 5, 40, { height: '40' }, 'communication_tower (40 m)');
point('storage_tank', 30, 40, { height: '8', diameter: '10' }, 'storage_tank');
rect('storage_tank', 50, 34, 12, 12, { height: '10' }, 'storage_tank (outline)');
// Row 4: areas.
rect('fountain', 0, 64, 9, 9, { height: '0.5' }, 'fountain basin');
rect('platform', 16, 66, 24, 4, { railway: 'platform' }, 'rail platform');
rect('platform', 46, 67, 14, 2.5, { bus: 'yes' }, 'bus platform');
rect('pier', 0, 84, 20, 5, {}, 'pier');
features.push({
  type: 'Feature',
  properties: { class: 'pier', id: String(nextId++), source_tags: '{}' },
  geometry: { type: 'LineString', coordinates: [at(30, 86), at(52, 86), at(52, 96)] },
});
labels.push({ text: 'pier (line)', at: at(41, 89) });

const map = new MlMap({
  container: 'map',
  center: at(30, 42),
  zoom: 19,
  pitch: 50,
  bearing: 0,
  style: {
    version: 8,
    sources: { infra: { type: 'geojson', data: { type: 'FeatureCollection', features } } },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#eef0ea' } },
      // MapLibre loads a source only for a layer that uses it.
      { id: 'infra-load', type: 'circle', source: 'infra', paint: { 'circle-radius': 0 } },
    ],
  },
});
(window as unknown as { map: MlMap }).map = map;

map.on('load', () => {
  map.addLayer(
    new StreetFurnitureLayer({
      id: 'street',
      source: 'infra',
      sourceLayer: '', // GeoJSON: no source layers
      minZoom: 0,
      farCutoff: false,
      onError: (err) => console.warn('[street]', err),
    }),
  );
  for (const { text, at: where } of labels) {
    const el = document.createElement('div');
    el.className = 'label';
    el.textContent = text;
    new Marker({ element: el, anchor: 'top' }).setLngLat(where).addTo(map);
  }
});
