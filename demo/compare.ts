// Our map beside OSM2World's 3D viewer, cameras kept in step: drag, zoom or turn either one.
import { Map as MlMap, addProtocol, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol } from 'pmtiles';
import { LabelOcclusion, LandmarksLayer, RoofsLayer, setTheme, TreesLayer } from '../src/index';
import { startInspector, type O2WScene } from './inspector';
import { firstPointLabel, roofWalls, styleFor } from './style';

setWorkerUrl(workerUrl);
addProtocol('pmtiles', new Protocol().tile);

const key = import.meta.env.VITE_PROTOMAPS_KEY as string | undefined;
const pmtilesUrl = import.meta.env.VITE_PMTILES_URL as string | undefined;
const OVERTURE_BUILDINGS =
  'https://overturemaps-extras-us-west-2.s3.amazonaws.com/tiles/2026-09-23.1/buildings.pmtiles';

const map = new MlMap({
  container: 'map',
  style: styleFor({
    theme: 'day',
    basemap: 'streets',
    projection: 'mercator',
    terrain: false,
    roofData: 'overture',
    roofsUrl: OVERTURE_BUILDINGS,
    roofParts: true,
    protomaps: pmtilesUrl
      ? `pmtiles://${pmtilesUrl}`
      : `https://api.protomaps.com/tiles/v4.json?key=${key}`,
  }),
  // Jardin des Serres d'Auteuil; the URL hash (#zoom/lat/lng/bearing/pitch) wins.
  center: [2.25229, 48.84719],
  zoom: 17.5,
  pitch: 50,
  bearing: 16,
  maxPitch: 85,
  hash: true,
});

/** Surfaces of OSM2World's scene above a point, once its viewer is running. */
let o2wScene: O2WScene | undefined;

const roofs = new RoofsLayer({
  id: 'roofs',
  source: 'roof-buildings',
  sourceLayer: 'building',
  extrusionLayer: roofWalls(true),
});
startInspector(map, {
  roofs,
  wallLayers: roofWalls(true),
  source: 'roof-buildings',
  sourceLayers: ['building', 'building_part'],
  osm2world: () => o2wScene,
});

map.on('load', () => {
  setTheme(map, 'day', { sky: true });
  const before = firstPointLabel(map.getStyle().layers);
  map.addLayer(roofs, before);
  map.addLayer(new TreesLayer({ id: 'trees', source: 'protomaps' }), before);
  map.addLayer(
    new LandmarksLayer({ id: 'landmarks', replaceBuildings: ['buildings', ...roofWalls(true)] }),
    before,
  );
  map.addLayer(new LabelOcclusion());
});

// ---- Camera conversion ---------------------------------------------------------------------

const EARTH_RADIUS_M = 6378137;
const RAD = Math.PI / 180;

interface View {
  lng: number;
  lat: number;
  zoom: number;
  bearing: number;
  pitch: number;
}

/** MapLibre's vertical field of view, radians (36.87° by default). */
const fov = () =>
  ((map as { getVerticalFieldOfView?: () => number }).getVerticalFieldOfView?.() ?? 36.87) * RAD;

/** Metres per screen pixel at the view centre. */
const metresPerPixel = (lat: number, zoom: number) =>
  (2 * Math.PI * EARTH_RADIUS_M * Math.cos(lat * RAD)) / (512 * 2 ** zoom);

/** Pixels from the camera to the view centre (MapLibre's cameraToCenterDistance). */
const cameraPixels = () => map.getCanvas().clientHeight / 2 / Math.tan(fov() / 2);

const radiusOf = (v: View) => cameraPixels() * metresPerPixel(v.lat, v.zoom);
const zoomOf = (lat: number, radius: number) =>
  Math.log2((2 * Math.PI * EARTH_RADIUS_M * Math.cos(lat * RAD) * cameraPixels()) / (512 * radius));

// Babylon's ArcRotateCamera sits at target + r·(cos α sin β, cos β, sin α sin β). OSM2World's scene
// x and z point west and south (its own view=N is α = π/2): α = π/2 − bearing, β = pitch.
const alphaOf = (bearing: number) => Math.PI / 2 - bearing * RAD;
const bearingOf = (alpha: number) => {
  const b = (Math.PI / 2 - alpha) / RAD;
  return ((((b + 180) % 360) + 360) % 360) - 180;
};

const viewOf = (): View => {
  const c = map.getCenter();
  return {
    lng: c.lng,
    lat: c.lat,
    zoom: map.getZoom(),
    bearing: map.getBearing(),
    pitch: map.getPitch(),
  };
};

// ---- OSM2World viewer ----------------------------------------------------------------------

// OSM2World's own web frontend, loaded from osm2world.org (as its demo page does), drawing tiles
// from its tile server. Its sky files have no CORS headers, so copies are served with the demo
// (public/osm2world).
const OSM2WORLD = 'https://osm2world.org/demo/';
const SCRIPTS = [
  'https://cdn.babylonjs.com/babylon.js',
  'https://cdn.babylonjs.com/loaders/babylonjs.loaders.min.js',
  'https://cdn.babylonjs.com/loaders/babylon.glTF2FileLoader.js',
  'https://code.jquery.com/pep/0.4.3/pep.js',
  `${OSM2WORLD}src/geocoords.js`,
  `${OSM2WORLD}src/osm2world-frontend.js`,
];
const SKY = ['DaySkyHDRI041B.env', 'DaySkyHDRI041B.jpg'];

interface XZ {
  x: number;
  z: number;
}
interface O2WCamera {
  target: XZ & { y: number };
  radius: number;
  alpha: number;
  beta: number;
  fov: number;
  upperBetaLimit: number;
  onViewMatrixChangedObservable: { add(fn: () => void): void };
}
interface PickedMesh {
  name: string;
  isEnabled(): boolean;
  isVisible: boolean;
}
interface Viewer {
  camera: O2WCamera;
  scene: {
    multiPickWithRay(
      ray: unknown,
      predicate: (mesh: PickedMesh) => boolean,
    ): { pickedPoint: { y: number } | null }[] | null;
    pick(
      x: number,
      y: number,
      predicate: (mesh: PickedMesh) => boolean,
    ): { pickedPoint: { x: number; y: number; z: number } | null };
  };
  originLatLon: unknown;
  setView(origin: unknown, radius: number, alpha: number, beta: number): void;
}
interface Babylon {
  Vector3: new (x: number, y: number, z: number) => O2WCamera['target'];
  Ray: new (origin: O2WCamera['target'], direction: O2WCamera['target'], length: number) => unknown;
  Tools: { PreprocessUrl: (url: string) => string };
}
interface Projection {
  toXZ(latLon: unknown): XZ;
  toLatLon(xz: XZ): { lat: number; lon: number };
}

/** A top-level `const`/`class` of OSM2World's classic scripts (not a property of `window`). */
const global = <T>(name: string): T => (0, eval)(name) as T;

const loadScript = (src: string) =>
  new Promise<void>((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.append(el);
  });

/** Which pane the user last touched: it drives the other one. */
let driver: 'map' | 'osm2world' = 'map';

function connect(viewer: Viewer, BABYLON: Babylon): void {
  const LatLon = global<new (lat: number, lon: number) => unknown>('LatLon');
  const Proj = global<new (origin: unknown) => Projection>('OrthographicAzimuthalMapProjection');
  const camera = viewer.camera;
  // The scene stays around the origin it started with: tiles are placed relative to it.
  const start = viewOf();
  viewer.setView(new LatLon(start.lat, start.lng), radiusOf(start), 0, 0);
  const proj = new Proj(viewer.originLatLon);

  const push = () => {
    const v = viewOf();
    const xz = proj.toXZ(new LatLon(v.lat, v.lng));
    camera.fov = fov();
    camera.target = new BABYLON.Vector3(-xz.x, 0, -xz.z);
    camera.radius = radiusOf(v);
    camera.alpha = alphaOf(v.bearing);
    camera.beta = Math.min(v.pitch * RAD, camera.upperBetaLimit);
  };

  const pull = () => {
    if (driver !== 'osm2world') return;
    const t = camera.target;
    const { lat, lon } = proj.toLatLon({ x: -t.x, z: -t.z });
    map.jumpTo({
      center: [lon, lat],
      zoom: zoomOf(lat, camera.radius),
      bearing: bearingOf(camera.alpha),
      pitch: camera.beta / RAD,
    });
  };

  // OSM2World's world is flat (ground at y = 0): a hit's y is its height above ground. Its sky
  // dome and ground plane are not buildings.
  const down = new BABYLON.Vector3(0, -1, 0);
  const solid = (mesh: PickedMesh) =>
    mesh.isEnabled() && mesh.isVisible && mesh.name !== 'sky' && mesh.name !== 'ground';
  o2wScene = {
    heights: (lng, lat) => {
      const xz = proj.toXZ(new LatLon(lat, lng));
      const ray = new BABYLON.Ray(new BABYLON.Vector3(-xz.x, 1000, -xz.z), down, 2000);
      const hits = viewer.scene.multiPickWithRay(ray, solid);
      return (hits ?? []).flatMap((h) => (h.pickedPoint ? [h.pickedPoint.y] : []));
    },
    pick: (fx, fy) => {
      // The canvas in device pixels, as Babylon picks.
      const hit = viewer.scene.pick(canvas.width * fx, canvas.height * fy, solid);
      const p = hit.pickedPoint;
      if (!p) return undefined;
      const { lat, lon } = proj.toLatLon({ x: -p.x, z: -p.z });
      return { lngLat: [lon, lat], height: p.y };
    },
  };

  push();
  map.on('move', () => {
    if (driver === 'map') push();
  });
  camera.onViewMatrixChangedObservable.add(pull);
}

for (const type of ['pointerdown', 'wheel', 'touchstart', 'keydown'])
  map.getContainer().addEventListener(type, () => (driver = 'map'), { capture: true });
const canvas = document.getElementById('osm2world') as HTMLCanvasElement;
for (const type of ['pointerdown', 'wheel', 'touchstart'])
  canvas.addEventListener(type, () => (driver = 'osm2world'), { capture: true });

async function startOsm2World(): Promise<void> {
  for (const src of SCRIPTS) await loadScript(src);
  const BABYLON = (window as unknown as { BABYLON: Babylon }).BABYLON;
  // Its sky (lighting and backdrop) from our copies: the originals are not served cross-origin.
  BABYLON.Tools.PreprocessUrl = (url) =>
    SKY.includes(url) ? `${import.meta.env.BASE_URL}osm2world/${url}` : url;
  // The viewer writes its view into the page URL (?lat=…): the map's #hash is this page's URL.
  const replaceState = history.replaceState.bind(history);
  history.replaceState = (data, unused, url) => {
    if (typeof url === 'string' && url.startsWith('?lat=')) return;
    replaceState(data, unused, url);
  };
  const O2W = global<{
    Viewer: { fromCanvas(id: string, roots: string[], options: unknown): Viewer };
    defaultRenderOptions: { high: unknown };
  }>('OSM2World');
  const viewer = O2W.Viewer.fromCanvas(
    'osm2world',
    ['https://tiles.osm2world.org/glb/'],
    O2W.defaultRenderOptions.high,
  );
  connect(viewer, BABYLON);
}

startOsm2World().catch((err) => {
  console.warn('[compare] OSM2World viewer', err);
  document.getElementById('o2w-tag')!.textContent = 'OSM2World could not load';
});
