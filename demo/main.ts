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
  FogLayer,
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
// Optional: an Overture-schema building tileset (scripts/buildings) drawn with real roofs.
// `?roofs=/roofs-osm.pmtiles` overrides it for one visit (paths resolve against the page).
const roofsParam = new URLSearchParams(location.search).get('roofs');
const roofsUrl = roofsParam
  ? new URL(roofsParam, location.href).href
  : (import.meta.env.VITE_ROOFS_PMTILES as string | undefined);
if (pmtilesUrl || roofsUrl) addProtocol('pmtiles', new Protocol().tile);

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
  const firstLabel = styleLayers.findIndex((l) => l.type === 'symbol');
  if (roofsUrl) {
    // Overture buildings (with roof attributes) replace Protomaps' extrusions; the flat
    // Protomaps footprints stay underneath. Outlines drawn by their parts are skipped.
    const walls: LayerSpecification = {
      id: 'roof-buildings-3d',
      type: 'fill-extrusion',
      source: 'roof-buildings',
      'source-layer': 'building',
      minzoom: 14,
      filter: ['!=', ['get', 'has_parts'], true],
      paint: {
        'fill-extrusion-color': flat.paint?.['fill-color'] ?? '#d9d4ce',
        'fill-extrusion-height': ['coalesce', ['get', 'height'], 10],
        'fill-extrusion-base': ['coalesce', ['get', 'min_height'], 0],
      },
    };
    const at = firstLabel === -1 ? styleLayers.length : firstLabel;
    return [...styleLayers.slice(0, at), walls, ...styleLayers.slice(at)];
  }
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

const DEM = {
  type: 'raster-dem' as const,
  tiles: ['https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png'],
  encoding: 'terrarium' as const,
  tileSize: 256,
  maxzoom: 15,
};
let terrainOn = false;

/** Hillshading under the roads, shown only with terrain so mountains read as mountains. */
function withHillshade(styleLayers: LayerSpecification[], flavor: string): LayerSpecification[] {
  const at = styleLayers.findIndex((l) => l.id.startsWith('roads'));
  const hillshade: LayerSpecification = {
    id: 'hillshade',
    type: 'hillshade',
    source: 'hillshade-dem',
    layout: { visibility: terrainOn ? 'visible' : 'none' },
    paint: {
      'hillshade-exaggeration': 0.6,
      'hillshade-shadow-color': flavor === 'dark' ? '#000000' : '#5a5348',
      'hillshade-highlight-color': flavor === 'dark' ? '#3a3f4a' : '#ffffff',
    },
  };
  const i = at === -1 ? styleLayers.length : at;
  return [...styleLayers.slice(0, i), hillshade, ...styleLayers.slice(i)];
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
      ...(roofsUrl
        ? { 'roof-buildings': { type: 'vector' as const, url: `pmtiles://${roofsUrl}` } }
        : {}),
      terrain: DEM,
      // Hillshading gets its own copy of the DEM (MapLibre warns when terrain shares one).
      'hillshade-dem': DEM,
    },
    layers: withHillshade(
      withExtrudedBuildings(layers('protomaps', namedFlavor(flavor), { lang: 'en' })),
      flavor,
    ),
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
  maxPitch: 85,
});

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let layer: LandmarksLayer | undefined;
let trees: TreesLayer | undefined;
let roofs: RoofsLayer | undefined;
let occlusion: LabelOcclusion | undefined;
let channel: 'latest' | 'preview' = 'latest';

function renderList(models: LandmarkInfo[]) {
  $('models').innerHTML = models
    .map((m) => `<li>${m.name ?? m.id} <em>(${m.lod})</em><small>${m.attribution}</small></li>`)
    .join('');
}

const firstSymbol = () => map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
/** 3D layers go under the fog (it blends over them), or under the labels without fog. */
const before3D = () => (map.getLayer('fog') ? 'fog' : firstSymbol());

function addLandmarks() {
  if (layer && map.getLayer(layer.id)) map.removeLayer(layer.id);
  layer = new LandmarksLayer({
    id: 'landmarks',
    channel,
    replaceBuildings: roofsUrl ? ['buildings', 'roof-buildings-3d'] : ['buildings'],
    onModelsChanged: renderList,
    onError: (err, ctx) => console.warn('[landmarks]', ctx, err),
  });
  map.addLayer(layer, before3D());
}

function addTrees() {
  if (trees && map.getLayer(trees.id)) map.removeLayer(trees.id);
  trees = new TreesLayer({
    id: 'trees',
    source: 'protomaps',
    wind: { strength: wind },
    onError: (err, ctx) => console.warn('[trees]', ctx, err),
  });
  map.addLayer(trees, before3D());
}

function addRoofs() {
  if (!roofsUrl) return;
  if (roofs && map.getLayer(roofs.id)) map.removeLayer(roofs.id);
  roofs = new RoofsLayer({
    id: 'roofs',
    source: 'roof-buildings',
    sourceLayer: 'building',
    extrusionLayer: 'roof-buildings-3d',
    onError: (err) => console.warn('[roofs]', err),
  });
  map.addLayer(roofs, before3D());
}

function setOcclusion(on: boolean) {
  if (on && !occlusion) {
    occlusion = new LabelOcclusion();
    map.addLayer(occlusion);
  } else if (!on && occlusion) {
    if (map.getLayer(occlusion.id)) map.removeLayer(occlusion.id);
    occlusion = undefined;
  }
}

const isOn = (id: string) => $<HTMLInputElement>(id).checked;
// Without a roofs tileset there is nothing to toggle.
if (!roofsUrl) $<HTMLInputElement>('show-roofs').parentElement!.hidden = true;

map.on('load', () => {
  setTheme(map, theme);
  if (isOn('show-landmarks')) addLandmarks();
  if (isOn('show-roofs')) addRoofs();
  if (isOn('show-trees')) addTrees();
  setOcclusion(isOn('occlusion'));
});
// A full (non-diffed) style swap drops custom layers: put back the ones switched on.
map.on('style.load', () => {
  if (isOn('show-landmarks') && !map.getLayer('landmarks')) addLandmarks();
  if (isOn('show-roofs') && roofsUrl && !map.getLayer('roofs')) addRoofs();
  if (isOn('show-trees') && !map.getLayer('trees')) addTrees();
  if (occlusion && !map.getLayer(occlusion.id)) map.addLayer(occlusion);
});

/** Removing a layer restores what it changed (hidden buildings, shortened walls). */
function remove(id: string) {
  if (map.getLayer(id)) map.removeLayer(id);
}

$<HTMLInputElement>('show-landmarks').onchange = () => {
  if (isOn('show-landmarks')) addLandmarks();
  else {
    remove('landmarks');
    layer = undefined;
    renderList([]);
  }
};
$<HTMLInputElement>('show-roofs').onchange = () => {
  if (isOn('show-roofs')) addRoofs();
  else {
    remove('roofs');
    roofs = undefined;
  }
};
$<HTMLInputElement>('show-trees').onchange = () => {
  if (isOn('show-trees')) addTrees();
  else {
    remove('trees');
    trees = undefined;
    $('stats').textContent = '';
  }
};

$<HTMLSelectElement>('channel').onchange = (e) => {
  channel = (e.target as HTMLSelectElement).value as 'latest' | 'preview';
  if (isOn('show-landmarks')) addLandmarks();
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
function setTerrainOn(on: boolean) {
  terrainOn = on;
  $<HTMLInputElement>('terrain').checked = on;
  map.setTerrain(on ? { source: 'terrain', exaggeration: 1 } : null);
  if (map.getLayer('hillshade'))
    map.setLayoutProperty('hillshade', 'visibility', on ? 'visible' : 'none');
}
$<HTMLInputElement>('terrain').onchange = (e) =>
  setTerrainOn((e.target as HTMLInputElement).checked);

$<HTMLInputElement>('occlusion').onchange = (e) =>
  setOcclusion((e.target as HTMLInputElement).checked);

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

let fog: FogLayer | undefined;
let fogHeight = 40;
function addFog() {
  if (fog && map.getLayer(fog.id)) map.removeLayer(fog.id);
  fog = new FogLayer({
    id: 'fog',
    height: fogHeight,
    density: Number($<HTMLInputElement>('fog-density').value),
  });
  map.addLayer(fog, firstSymbol());
}

/** Preset views: city ground fog, and valley fog among the Alps. */
function showView(view: 'paris' | 'chamonix') {
  const alps = view === 'chamonix';
  setTerrainOn(alps);
  fogHeight = alps ? 350 : 40;
  $<HTMLInputElement>('show-fog').checked = true;
  if (fog && map.getLayer(fog.id)) fog.setHeight(fogHeight);
  else addFog();
  map.jumpTo(
    alps
      ? { center: [6.8694, 45.9237], zoom: 12.8, bearing: 160, pitch: 70 }
      : { center: [2.2945, 48.8584], zoom: 16, bearing: -20, pitch: 65 },
  );
}
$('view-paris').onclick = () => showView('paris');
$('view-chamonix').onclick = () => showView('chamonix');
$<HTMLInputElement>('show-fog').onchange = () => {
  if (isOn('show-fog')) addFog();
  else {
    remove('fog');
    fog = undefined;
  }
};
$<HTMLInputElement>('fog-density').oninput = (e) =>
  fog?.setDensity(Number((e.target as HTMLInputElement).value));
map.on('style.load', () => {
  if (isOn('show-fog') && !map.getLayer('fog')) addFog();
});
