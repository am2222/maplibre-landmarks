import { Map as MlMap, addProtocol, setWorkerUrl, type JumpToOptions } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol } from 'pmtiles';
import {
  FogLayer,
  LabelOcclusion,
  LandmarksLayer,
  PowerLinesLayer,
  RoofsLayer,
  setTheme,
  THEMES,
  TreesLayer,
  WaterLayer,
  type LandmarkInfo,
  type Theme,
  type TreeSeason,
} from '../src/index';
import { $, initCollapse, initTabs, range, syncTabDots, toggle } from './panel';
import {
  firstPointLabel,
  roofWalls,
  styleFor,
  type Basemap,
  type Projection,
  type RoofData,
} from './style';

setWorkerUrl(workerUrl);
addProtocol('pmtiles', new Protocol().tile);

const key = import.meta.env.VITE_PROTOMAPS_KEY as string | undefined;
const pmtilesUrl = import.meta.env.VITE_PMTILES_URL as string | undefined;
if (!key && !pmtilesUrl) {
  document.body.innerHTML =
    '<p class="missing">Set <code>VITE_PROTOMAPS_KEY</code> or <code>VITE_PMTILES_URL</code> in <code>.env.local</code> (see <code>.env.example</code>).</p>';
  throw new Error('No basemap tiles configured');
}
// Roof data: Overture's official building tiles (worldwide, nothing to build; buildings and
// building parts in separate layers), or an optional local tileset (`VITE_ROOFS_PMTILES`;
// `?roofs=/my-roofs.pmtiles` overrides it for one visit; paths resolve against the page).
const OVERTURE_BUILDINGS =
  'https://overturemaps-extras-us-west-2.s3.amazonaws.com/tiles/2026-09-23.1/buildings.pmtiles';
// Start-up settings from the page URL (the docs embed a dusk skyline):
// `?theme=dusk`, `?fog` (or `?fog=<height in metres>`), `?panel=0` (folded), `?roofs=<tileset>`,
// `?season=autumn` (spring | summer | autumn | winter | auto | 0–4).
const params = new URLSearchParams(location.search);
// Power lines: Overture's base theme (only fetched while the power layer is on).
const OVERTURE_BASE =
  'https://overturemaps-extras-us-west-2.s3.amazonaws.com/tiles/2026-09-23.1/base.pmtiles';
const roofsParam = params.get('roofs');
const themeParam = params.get('theme');
const SEASONS = ['spring', 'summer', 'autumn', 'winter'] as const;
const seasonParam = params.get('season');
const startSeason: TreeSeason =
  seasonParam === 'auto' || SEASONS.includes(seasonParam as never)
    ? (seasonParam as TreeSeason)
    : seasonParam && Number.isFinite(Number(seasonParam))
      ? Number(seasonParam)
      : 'summer';
const localRoofsUrl = roofsParam
  ? new URL(roofsParam, location.href).href
  : (import.meta.env.VITE_ROOFS_PMTILES as string | undefined);

const state = {
  theme: (themeParam && themeParam in THEMES ? themeParam : 'day') as Theme,
  basemap: 'streets' as Basemap,
  projection: 'mercator' as Projection,
  terrain: false,
  // A `?roofs=` tileset is what the visit is for: start on it.
  roofData: (roofsParam ? 'local' : 'overture') as RoofData,
  /** A season name, 'auto', or a time of year (0 spring … 3 winter) once scrubbed or playing. */
  season: startSeason,
};
/** Overture-schema tilesets (the official one, or `?roofs=`): buildings and parts in two layers. */
const roofParts = () =>
  state.roofData === 'overture' || (state.roofData === 'local' && (!localRoofsUrl || !!roofsParam));
const style = () =>
  styleFor({
    ...state,
    roofsUrl: state.roofData === 'local' && localRoofsUrl ? localRoofsUrl : OVERTURE_BUILDINGS,
    roofParts: roofParts(),
    powerUrl: toggle('power').checked ? OVERTURE_BASE : undefined,
    protomaps: pmtilesUrl
      ? `pmtiles://${pmtilesUrl}`
      : `https://api.protomaps.com/tiles/v4.json?key=${key}`,
  });

const map = new MlMap({
  container: 'map',
  style: style(),
  center: [2.2945, 48.8584],
  zoom: 16.5,
  pitch: 60,
  bearing: -20,
  hash: true,
  maxPitch: 85,
});

// ---- Layers -------------------------------------------------------------------------------

let landmarks: LandmarksLayer | undefined;
let roofs: RoofsLayer | undefined;
let trees: TreesLayer | undefined;
let water: WaterLayer | undefined;
let fog: FogLayer | undefined;
let power: PowerLinesLayer | undefined;

let occlusion: LabelOcclusion | undefined;
let models: LandmarkInfo[] = [];

/** The first label above the 3D layers (street names lie under them, see style.ts). */
const firstSymbol = () => firstPointLabel(map.getStyle().layers);
/** 3D layers go under the fog (it blends over them), or under the labels without fog. */
const before3D = () => (map.getLayer('fog') ? 'fog' : firstSymbol());
/** Removing a layer restores what it changed (hidden buildings, shortened walls). */
const remove = (id: string) => {
  if (map.getLayer(id)) map.removeLayer(id);
};

function renderModels(list: LandmarkInfo[]) {
  models = list;
  $('models').innerHTML = list
    .map((m) => `<li>${m.name ?? m.id} <em>(${m.lod})</em><small>${m.attribution}</small></li>`)
    .join('');
  $('landmark-stats').textContent = list.length
    ? `${list.length} models loaded`
    : 'No models in view (zoom 14+ near a landmark).';
}

function addLandmarks() {
  remove('landmarks');
  landmarks = new LandmarksLayer({
    id: 'landmarks',
    channel: $<HTMLSelectElement>('channel').value as 'latest' | 'preview',
    replaceBuildings:
      state.roofData !== 'none' ? ['buildings', ...roofWalls(roofParts())] : ['buildings'],
    showFrom: select('landmark-show-from').value as 'extrusions' | 'catalogue',
    maxResident: landmarkMax.value(),
    fadeMs: landmarkFade.value(),
    onModelsChanged: renderModels,
    onError: (err, ctx) => console.warn('[landmarks]', ctx, err),
  });
  map.addLayer(landmarks, before3D());
}

function addRoofs() {
  remove('roofs');
  if (state.roofData === 'none') return;
  roofs = new RoofsLayer({
    id: 'roofs',
    source: 'roof-buildings',
    sourceLayer: 'building',
    extrusionLayer: roofWalls(roofParts()),
    wallColors: $<HTMLInputElement>('wall-colors').checked,
    farCutoff: $<HTMLInputElement>('roof-cutoff').checked,
    maxBuildings: roofMax.value(),
    onError: (err) => console.warn('[roofs]', err),
  });
  map.addLayer(roofs, before3D());
}

function addTrees() {
  remove('trees');
  trees = new TreesLayer({
    id: 'trees',
    source: 'protomaps',
    wind: { strength: treeWind.value(), directionDeg: treeWindDir.value() },
    density: treeDensity.value(),
    maxTrees: treeMax.value(),
    lodDistanceM: treeLod.value(),
    riseMs: treeRise.value(),
    farCutoff: $<HTMLInputElement>('tree-cutoff').checked,
    season: state.season,
    snow: $<HTMLInputElement>('tree-snow').checked,
    onError: (err, ctx) => console.warn('[trees]', ctx, err),
  });
  map.addLayer(trees, before3D());
}

/**
 * Right above the basemap's water fill and its river/stream lines (they would draw over the
 * water): roads, bridges and labels still draw on top.
 */
function addWater() {
  remove('water-3d');
  water = new WaterLayer({
    id: 'water-3d',
    source: 'protomaps',
    sourceLayer: 'water',
    waves: waves.value(),
    maxTriangles: waterMax.value(),
  });
  const layers = map.getStyle().layers;
  let i = layers.findIndex((l) => l.id === 'water');
  while (i !== -1 && i + 1 < layers.length) {
    const next = layers[i + 1] as { 'source-layer'?: string; type: string };
    if (next['source-layer'] !== 'water' || next.type === 'symbol') break;
    i++;
  }
  map.addLayer(water, i === -1 ? undefined : layers[i + 1]?.id);
}

/** Power lines from Overture's base tiles (the style adds the source while they are on). */
function addPower() {
  remove('power');
  // Without its source yet: restyle, and the style reload adds this layer (restoreLayers).
  if (!map.getSource('overture-base')) return restyle();
  power = new PowerLinesLayer({
    id: 'power',
    source: 'overture-base',
    onError: (err) => console.warn('[power]', err),
  });
  map.addLayer(power, before3D());
}

function addFog() {
  remove('fog');
  fog = new FogLayer({
    id: 'fog',
    density: fogDensity.value(),
    height: fogHeight.value(),
    coverage: fogCoverage.value(),
    wind: { speed: fogWind.value(), direction: fogWindDir.value() },
  });
  map.addLayer(fog, firstSymbol());
}

function addLabels() {
  if (occlusion && map.getLayer(occlusion.id)) return;
  occlusion = new LabelOcclusion();
  map.addLayer(occlusion);
}

const LAYERS: Record<string, { add(): void; id: () => string | undefined }> = {
  landmarks: { add: addLandmarks, id: () => 'landmarks' },
  roofs: { add: addRoofs, id: () => 'roofs' },
  trees: { add: addTrees, id: () => 'trees' },
  water: { add: addWater, id: () => 'water-3d' },
  fog: { add: addFog, id: () => 'fog' },
  power: { add: addPower, id: () => 'power' },
  labels: { add: addLabels, id: () => occlusion?.id },
};

function setLayer(name: string, on: boolean) {
  toggle(name).checked = on;
  syncTabDots();
  if (on) LAYERS[name]!.add();
  else {
    const id = LAYERS[name]!.id();
    if (id) remove(id);
    if (name === 'landmarks') renderModels([]);
  }
}

/** Every layer switched on and missing from the style (after a full style swap). */
function restoreLayers() {
  for (const name of Object.keys(LAYERS)) {
    const id = LAYERS[name]!.id();
    if (toggle(name).checked && (!id || !map.getLayer(id))) LAYERS[name]!.add();
  }
}

// ---- Panel --------------------------------------------------------------------------------

initTabs(params.has('season') ? 'trees' : 'landmarks');
initCollapse();
if (params.get('panel') === '0') $('collapse').click();
for (const name of Object.keys(LAYERS))
  toggle(name).addEventListener('change', () => setLayer(name, toggle(name).checked));
syncTabDots();

const degrees = (v: number) => `${v}°`;
const treeWind = range('tree-wind', (v) => trees?.setWind({ strength: v }));
const treeWindDir = range('tree-wind-dir', (v) => trees?.setWind({ directionDeg: v }), degrees);
const waves = range('water-waves', (v) => water?.setWaves(v));
const fogDensity = range('fog-density', (v) => fog?.setDensity(v));
const fogHeight = range(
  'fog-height',
  (v) => fog?.setHeight(v),
  (v) => `${v} m`,
);
const fogCoverage = range('fog-coverage', (v) => fog?.setCoverage(v));
const fogWind = range(
  'fog-wind',
  (v) => fog?.setWind({ speed: v }),
  (v) => `${v} m/s`,
);
const fogWindDir = range('fog-wind-dir', (v) => fog?.setWind({ direction: v }), degrees);
if (params.has('fog')) {
  const height = Number(params.get('fog'));
  if (height > 0) fogHeight.set(height);
  toggle('fog').checked = true; // added with the other layers on load
  syncTabDots();
}

/** A range that rebuilds its layer when let go (the option is fixed at construction). */
const rebuilding = (id: string, layer: string, format?: (v: number) => string) => {
  const r = range(id, () => {}, format);
  $(id).addEventListener('change', () => {
    if (toggle(layer).checked) LAYERS[layer]!.add();
  });
  return r;
};
const ms = (v: number) => `${v} ms`;
const metres = (v: number) => `${v} m`;
const count = (v: number) => v.toLocaleString();
const treeDensity = range(
  'tree-density',
  (v) => trees?.setDensity(v),
  (v) => `${Math.round(v * 100)}%`,
);
const treeMax = rebuilding('tree-max', 'trees', count);
const treeLod = rebuilding('tree-lod', 'trees', metres);
const treeRise = rebuilding('tree-rise', 'trees', ms);
const roofMax = rebuilding('roof-max', 'roofs', count);
const waterMax = rebuilding('water-max', 'water', count);
const landmarkMax = rebuilding('landmark-max', 'landmarks');
const landmarkFade = rebuilding('landmark-fade', 'landmarks', ms);
range('max-pitch', (v) => map.setMaxPitch(v), degrees);
for (const [id, layer] of [
  ['tree-cutoff', 'trees'],
  ['roof-cutoff', 'roofs'],
] as const)
  $<HTMLInputElement>(id).onchange = () => {
    if (toggle(layer).checked) LAYERS[layer]!.add();
  };

/**
 * Apply a new style (a diffed swap: custom layers survive). When the roof walls change, the
 * roofs and landmarks are rebuilt for the new walls.
 */
function restyle(wallsChange = false) {
  if (wallsChange) remove('roofs');
  map.setStyle(style());
  setTheme(map, state.theme, { sky: true });
  if (wallsChange)
    map.once('style.load', () => {
      if (toggle('roofs').checked) addRoofs();
      if (toggle('landmarks').checked) addLandmarks();
    });
}

const select = (id: string) => $<HTMLSelectElement>(id);
select('theme').value = state.theme;
select('theme').onchange = () => {
  state.theme = select('theme').value as Theme;
  restyle();
};
select('basemap').onchange = () => {
  state.basemap = select('basemap').value as Basemap;
  restyle();
};
select('projection').onchange = () => {
  state.projection = select('projection').value as Projection;
  restyle();
};
$<HTMLInputElement>('terrain').onchange = () => {
  state.terrain = $<HTMLInputElement>('terrain').checked;
  restyle();
};
select('landmark-show-from').onchange = () => {
  if (toggle('landmarks').checked) addLandmarks();
};
select('channel').onchange = () => {
  if (toggle('landmarks').checked) addLandmarks();
};
// Without a local tileset, "Local file" has nothing to load.
if (!localRoofsUrl)
  select('roof-data').querySelector<HTMLOptionElement>('[value=local]')!.disabled = true;
select('roof-data').value = state.roofData;
select('roof-data').onchange = () => {
  state.roofData = select('roof-data').value as RoofData;
  restyle(true);
};
$<HTMLInputElement>('wall-colors').onchange = () => {
  if (toggle('roofs').checked) addRoofs();
};

// ---- Seasons ------------------------------------------------------------------------------

/** Seasons per second while "Play year" runs: a whole year in 6 s. */
const PLAY_SPEED = 4 / 6;
const yearInput = $<HTMLInputElement>('tree-year');
const seasonButtons = [...document.querySelectorAll<HTMLElement>('#tree-season [data-season]')];
let playing = 0;

/** Slider, read-out and buttons from the trees' current time of year (it eases between seasons). */
function showSeason() {
  const value = trees && toggle('trees').checked ? trees.getSeason() : Number(yearInput.value);
  if (document.activeElement !== yearInput || playing) yearInput.value = String(value);
  const nearest = SEASONS[Math.round(value) % 4]!;
  $('tree-season-out').textContent =
    state.season === 'auto' ? `auto · ${nearest}` : `${nearest} · ${value.toFixed(2)}`;
  const active =
    typeof state.season === 'string'
      ? state.season
      : Math.abs(value - Math.round(value)) < 0.1
        ? nearest
        : undefined;
  for (const b of seasonButtons) b.classList.toggle('active', b.dataset.season === active);
}

function stopPlay() {
  cancelAnimationFrame(playing);
  playing = 0;
  $('tree-play').textContent = '▶ Play year';
}

function setSeason(season: TreeSeason, durationMs?: number) {
  state.season = season;
  trees?.setSeason(season, durationMs === undefined ? undefined : { durationMs });
}

for (const b of seasonButtons)
  b.addEventListener('click', () => {
    stopPlay();
    setSeason(b.dataset.season as TreeSeason);
  });
yearInput.addEventListener('input', () => {
  stopPlay();
  setSeason(Number(yearInput.value), 0);
});
$('tree-play').addEventListener('click', () => {
  if (playing) return stopPlay();
  $('tree-play').textContent = '⏸ Pause';
  let last = performance.now();
  const step = (now: number) => {
    const from = trees?.getSeason() ?? Number(yearInput.value);
    setSeason((from + ((now - last) / 1000) * PLAY_SPEED) % 4, 0);
    last = now;
    playing = requestAnimationFrame(step);
  };
  playing = requestAnimationFrame(step);
});
$<HTMLInputElement>('tree-snow').onchange = () =>
  trees?.setSnow($<HTMLInputElement>('tree-snow').checked);
const seasonTick = () => {
  showSeason();
  requestAnimationFrame(seasonTick);
};
seasonTick();

// ---- Places -------------------------------------------------------------------------------

interface Place {
  view: JumpToOptions;
  basemap?: Basemap;
  projection?: Projection;
  terrain?: boolean;
  /** Fog height in metres, or false to switch the fog off. */
  fog?: number | false;
}
const PLACES: Record<string, Place> = {
  paris: {
    view: { center: [2.2945, 48.8584], zoom: 16, bearing: -20, pitch: 65 },
    basemap: 'streets',
    projection: 'mercator',
    terrain: false,
    fog: false,
  },
  chamonix: {
    view: { center: [6.8694, 45.9237], zoom: 12.8, bearing: 160, pitch: 70 },
    basemap: 'streets',
    projection: 'mercator',
    terrain: true,
    fog: 350,
  },
  alps: {
    view: { center: [6.865, 45.885], zoom: 12.6, bearing: 205, pitch: 72 },
    basemap: 'satellite',
    projection: 'mercator',
    terrain: true,
    fog: 450,
  },
  globe: {
    view: { center: [6.9, 45.9], zoom: 2.2, bearing: 0, pitch: 0 },
    projection: 'globe',
  },
};

function goTo(place: Place) {
  const changed =
    (place.basemap && place.basemap !== state.basemap) ||
    (place.projection && place.projection !== state.projection) ||
    (place.terrain !== undefined && place.terrain !== state.terrain);
  if (place.basemap) state.basemap = select('basemap').value = place.basemap;
  if (place.projection) state.projection = select('projection').value = place.projection;
  if (place.terrain !== undefined)
    state.terrain = $<HTMLInputElement>('terrain').checked = place.terrain;
  if (changed) restyle();
  if (place.fog === false) setLayer('fog', false);
  else if (place.fog !== undefined) {
    fogHeight.set(place.fog);
    if (fog && map.getLayer('fog')) fog.setHeight(place.fog);
    else setLayer('fog', true);
  }
  map.jumpTo(place.view);
}
for (const button of document.querySelectorAll<HTMLElement>('[data-place]'))
  button.addEventListener('click', () => goTo(PLACES[button.dataset.place!]!));

// ---- Map lifecycle --------------------------------------------------------------------------

map.on('load', () => {
  setTheme(map, state.theme, { sky: true });
  restoreLayers();
});
// A full (non-diffed) style swap drops custom layers: put back the ones switched on.
map.on('style.load', restoreLayers);

setInterval(() => {
  const t = trees?.getStats();
  $('tree-stats').textContent =
    t && toggle('trees').checked
      ? `${t.drawn} trees (near ${t.near}, far ${t.far}) · update ${t.updateMs.toFixed(1)} ms`
      : '';
  const r = roofs?.getStats();
  $('roof-stats').textContent =
    r && toggle('roofs').checked
      ? `${r.buildings} roofs · ${r.triangles.toLocaleString()} triangles (zoom 15+)`
      : '';
  const p = power?.getStats();
  $('power-stats').textContent =
    p && toggle('power').checked ? `${p.supports} supports · ${p.spans} spans (zoom 14+)` : '';
  const w = water?.getStats();
  $('water-stats').textContent =
    w && toggle('water').checked
      ? `${w.pieces} water pieces · ${w.triangles.toLocaleString()} triangles`
      : '';
}, 1000);
renderModels(models);

// Debug handle for local measurement scripts.
(window as unknown as { __demo: object }).__demo = {
  map,
  get trees() {
    return trees;
  },
  get power() {
    return power;
  },
};
