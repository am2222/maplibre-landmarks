import { Map as MlMap, setWorkerUrl, type StyleSpecification } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Geometry } from 'geojson';
import { LabelOcclusion, LandmarksLayer, RoofsLayer, type LandmarkInfo } from '../src/index';

setWorkerUrl(workerUrl);

interface Target {
  anchor: [number, number];
  footprint: Geometry;
  neighbour: Geometry;
}

declare global {
  interface Window {
    __start(t: Target): Promise<void>;
    /** Replace the style (new background colour); resolves after `style.load`. */
    __setStyle(background: string, diff: boolean): Promise<void>;
    /** Add icon labels at the given points, plus label occlusion. */
    __addLabels(points: [number, number][]): void;
    /** Add one gabled test building (GeoJSON, id 1) with roofs. */
    __addRoofs(polygon: number[][][]): RoofsLayer;
    __state: { models: LandmarkInfo[]; errors: string[] };
    __map?: MlMap;
  }
}

window.__state = { models: [], errors: [] };
let target: Target | undefined;

// Blank style + a legacy-filtered "buildings" layer, like Protomaps, so no tile key is needed.
function styleFor({ footprint, neighbour }: Target, background: string): StyleSpecification {
  return {
    version: 8,
    sources: {
      b: {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              id: 1,
              properties: { kind: 'building', name: 'landmark' },
              geometry: footprint,
            },
            {
              type: 'Feature',
              id: 2,
              properties: { kind: 'building', name: 'neighbour' },
              geometry: neighbour,
            },
          ],
        },
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': background } },
      {
        id: 'buildings',
        type: 'fill',
        source: 'b',
        filter: ['in', 'kind', 'building', 'building_part'],
        paint: { 'fill-color': '#ff0000' },
      },
    ],
  };
}

window.__start = async (t) => {
  target = t;
  const map = new MlMap({
    container: 'map',
    center: t.anchor,
    zoom: 16.5,
    pitch: 50,
    canvasContextAttributes: { preserveDrawingBuffer: true },
    style: styleFor(t, '#ffffff'),
  });
  window.__map = map;
  map.on('error', (e) => window.__state.errors.push(String(e.error?.message ?? e)));
  await map.once('load');
  map.addLayer(
    new LandmarksLayer({
      id: 'landmarks',
      replaceBuildings: ['buildings'],
      onModelsChanged: (m) => (window.__state.models = m),
      onError: (err, ctx) => window.__state.errors.push(`${ctx.stage}: ${String(err)}`),
    }),
  );
};

window.__setStyle = async (background, diff) => {
  const map = window.__map!;
  const loaded = map.once('style.load');
  map.setStyle(styleFor(target!, background), { diff });
  await loaded;
};

window.__addLabels = (points) => {
  const map = window.__map!;
  const size = 8;
  map.addImage('dot', {
    width: size,
    height: size,
    data: new Uint8Array(size * size * 4).fill(255),
  });
  map.addSource('labels', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: points.map((coordinates, i) => ({
        type: 'Feature',
        id: i + 1,
        properties: {},
        geometry: { type: 'Point', coordinates },
      })),
    },
  });
  map.addLayer({
    id: 'labels',
    type: 'symbol',
    source: 'labels',
    layout: { 'icon-image': 'dot', 'icon-allow-overlap': true, 'icon-ignore-placement': true },
  });
  map.addLayer(
    new LabelOcclusion({
      labelLayers: ['labels'],
      onError: (err) => window.__state.errors.push(`labels: ${String(err)}`),
    }),
  );
};

window.__addRoofs = (polygon) => {
  const map = window.__map!;
  map.addSource('rb', {
    type: 'geojson',
    data: {
      type: 'Feature',
      id: 1,
      properties: { height: 30, roof_shape: 'gabled' },
      geometry: { type: 'Polygon', coordinates: polygon },
    },
  });
  map.addLayer({
    id: 'rb-3d',
    type: 'fill-extrusion',
    source: 'rb',
    paint: { 'fill-extrusion-color': '#cccccc', 'fill-extrusion-height': ['get', 'height'] },
  });
  const roofs = new RoofsLayer({
    id: 'roofs',
    source: 'rb',
    extrusionLayer: 'rb-3d',
    onError: (err) => window.__state.errors.push(`roofs: ${String(err)}`),
  });
  map.addLayer(roofs);
  return roofs;
};
