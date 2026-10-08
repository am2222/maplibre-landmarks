import {
  Map as MlMap,
  addProtocol,
  setWorkerUrl,
  type LayerSpecification,
  type StyleSpecification,
} from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { layers, namedFlavor } from '@protomaps/basemaps';
import { Protocol } from 'pmtiles';
import {
  LabelOcclusion,
  LandmarksLayer,
  RoofsLayer,
  setTheme,
  TreesLayer,
  type LandmarkInfo,
  type Theme,
} from '../src/index';

setWorkerUrl(workerUrl);

const key = import.meta.env.VITE_PROTOMAPS_KEY as string | undefined;
const pmtilesUrl = import.meta.env.VITE_PMTILES_URL as string | undefined;
if (!key && !pmtilesUrl) {
  document.body.innerHTML =
    '<p class="missing">Set <code>VITE_PROTOMAPS_KEY</code> or <code>VITE_PMTILES_URL</code> in <code>.env.local</code> (see <code>.env.example</code>).</p>';
  throw new Error('No basemap tiles configured');
}
if (pmtilesUrl || import.meta.env.VITE_ROOFS_PMTILES) addProtocol('pmtiles', new Protocol().tile);

/** Basemap flavour that matches each plugin theme. */
const FLAVOR: Record<Theme, 'light' | 'dark'> = {
  day: 'light',
  dawn: 'light',
  dusk: 'dark',
  night: 'dark',
};

/**
 * Swap Protomaps' flat `buildings` fill for 3D extrusions so landmarks stand among real buildings.
 * The extrusion moves above the road layers (just below the first label): Protomaps draws roads
 * after buildings, and flat layers drawn after the 3D pass would paint over the extrusions.
 */
function withExtrudedBuildings(styleLayers: LayerSpecification[]): LayerSpecification[] {
  const flat = styleLayers.find((l) => l.id === 'buildings' && l.type === 'fill');
  if (!flat || flat.type !== 'fill') return styleLayers;
  const extruded: LayerSpecification = {
    id: flat.id,
    type: 'fill-extrusion',
    source: flat.source,
    'source-layer': flat['source-layer'],
    filter: flat.filter,
    minzoom: 14,
    paint: {
      'fill-extrusion-color': flat.paint?.['fill-color'] ?? '#d9d4ce',
      'fill-extrusion-height': ['coalesce', ['get', 'height'], 10],
      'fill-extrusion-base': ['coalesce', ['get', 'min_height'], 0],
      'fill-extrusion-opacity': 0.9,
    },
  };
  const rest = styleLayers.filter((l) => l !== flat);
  const firstSymbol = rest.findIndex((l) => l.type === 'symbol');
  const at = firstSymbol === -1 ? rest.length : firstSymbol;
  return [...rest.slice(0, at), extruded, ...rest.slice(at)];
}

function styleFor(theme: Theme): StyleSpecification {
  const flavor = FLAVOR[theme];
  return {
    version: 8,
    glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
    sprite: `https://protomaps.github.io/basemaps-assets/sprites/v4/${flavor}`,
    sources: {
      protomaps: {
        type: 'vector',
        url: pmtilesUrl
          ? `pmtiles://${pmtilesUrl}`
          : `https://api.protomaps.com/tiles/v4.json?key=${key}`,
        attribution:
          '<a href="https://protomaps.com">Protomaps</a> © <a href="https://openstreetmap.org">OpenStreetMap</a>',
      },
      terrain: {
        type: 'raster-dem',
        tiles: ['https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png'],
        encoding: 'terrarium',
        tileSize: 256,
        maxzoom: 15,
      },
    },
    layers: withExtrudedBuildings(layers('protomaps', namedFlavor(flavor), { lang: 'en' })),
  };
}

let theme: Theme = 'day';
let wind = 1;

const map = new MlMap({
  container: 'map',
  style: styleFor(theme),
  center: [2.2945, 48.8584],
  zoom: 16.5,
  pitch: 60,
  bearing: -20,
  hash: true,
});

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let layer: LandmarksLayer | undefined;
let trees: TreesLayer | undefined;
let channel: 'latest' | 'preview' = 'latest';

function renderList(models: LandmarkInfo[]) {
  $('models').innerHTML = models
    .map((m) => `<li>${m.name ?? m.id} <em>(${m.lod})</em><small>${m.attribution}</small></li>`)
    .join('');
}

const firstSymbol = () => map.getStyle().layers.find((l) => l.type === 'symbol')?.id;

function addLandmarks() {
  if (layer && map.getLayer(layer.id)) map.removeLayer(layer.id);
  layer = new LandmarksLayer({
    id: 'landmarks',
    channel,
    replaceBuildings: ['buildings'],
    onModelsChanged: renderList,
    onError: (err, ctx) => console.warn('[landmarks]', ctx, err),
  });
  map.addLayer(layer, firstSymbol());
}

function addTrees() {
  if (trees && map.getLayer(trees.id)) map.removeLayer(trees.id);
  trees = new TreesLayer({
    id: 'trees',
    source: 'protomaps',
    wind: { strength: wind },
    onError: (err, ctx) => console.warn('[trees]', ctx, err),
  });
  map.addLayer(trees, firstSymbol());
}

map.on('load', () => {
  setTheme(map, theme);
  addLandmarks();
  addTrees();
});
// A full (non-diffed) style swap drops custom layers: put them back.
map.on('style.load', () => {
  if (!map.getLayer('landmarks')) addLandmarks();
  if (!map.getLayer('trees')) addTrees();
  if (occlusion && !map.getLayer(occlusion.id)) map.addLayer(occlusion);
});

$<HTMLSelectElement>('channel').onchange = (e) => {
  channel = (e.target as HTMLSelectElement).value as 'latest' | 'preview';
  addLandmarks();
};
$<HTMLSelectElement>('theme').onchange = (e) => {
  theme = (e.target as HTMLSelectElement).value as Theme;
  map.setStyle(styleFor(theme));
  setTheme(map, theme);
};
$<HTMLInputElement>('wind').oninput = (e) => {
  wind = Number((e.target as HTMLInputElement).value);
  trees?.setWind({ strength: wind });
};
$<HTMLInputElement>('terrain').onchange = (e) =>
  map.setTerrain(
    (e.target as HTMLInputElement).checked ? { source: 'terrain', exaggeration: 1 } : null,
  );

let occlusion: LabelOcclusion | undefined;
$<HTMLInputElement>('occlusion').onchange = (e) => {
  if ((e.target as HTMLInputElement).checked) {
    occlusion = new LabelOcclusion();
    map.addLayer(occlusion);
  } else if (occlusion) {
    map.removeLayer(occlusion.id);
    occlusion = undefined;
  }
};

setInterval(() => {
  const s = trees?.getStats();
  if (s) {
    $('stats').textContent =
      `trees ${s.drawn} (near ${s.near}, far ${s.far}) · mapped ${s.mapped} · ` +
      `scattered ${s.scattered} · update ${s.updateMs.toFixed(1)} ms`;
  }
}, 1000);

// Debug handle for local measurement scripts.
(window as unknown as { __demo: object }).__demo = {
  map,
  get trees() {
    return trees;
  },
};

// Optional: an Overture-schema building tileset (see scripts/buildings) with real roofs.
const roofsUrl = import.meta.env.VITE_ROOFS_PMTILES as string | undefined;
if (roofsUrl) {
  map.on('load', () => {
    map.addSource('roof-buildings', { type: 'vector', url: `pmtiles://${roofsUrl}` });
    map.addLayer(
      {
        id: 'roof-buildings-3d',
        type: 'fill-extrusion',
        source: 'roof-buildings',
        'source-layer': 'building',
        minzoom: 14,
        paint: {
          'fill-extrusion-color': '#d9d4ce',
          'fill-extrusion-height': ['coalesce', ['get', 'height'], 10],
          'fill-extrusion-base': ['coalesce', ['get', 'min_height'], 0],
        },
      },
      map.getStyle().layers.find((l) => l.type === 'symbol')?.id,
    );
    map.addLayer(
      new RoofsLayer({
        id: 'roofs',
        source: 'roof-buildings',
        sourceLayer: 'building',
        extrusionLayer: 'roof-buildings-3d',
      }),
    );
  });
}
