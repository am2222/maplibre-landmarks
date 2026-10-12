// Our map beside OSM2World's 3D viewer, cameras kept in step: drag either one. OSM2World is served
// through the dev server's `/osm2world` proxy (vite.config.ts), so its frame is same-origin and its
// Babylon camera can be read and set directly. Dev server only.
import { Map as MlMap, addProtocol, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol } from 'pmtiles';
import { LabelOcclusion, LandmarksLayer, RoofsLayer, setTheme, TreesLayer } from '../src/index';
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

map.on('load', () => {
  setTheme(map, 'day', { sky: true });
  const before = firstPointLabel(map.getStyle().layers);
  map.addLayer(
    new RoofsLayer({
      id: 'roofs',
      source: 'roof-buildings',
      sourceLayer: 'building',
      extrusionLayer: roofWalls(true),
    }),
    before,
  );
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

// ---- OSM2World frame -----------------------------------------------------------------------

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
interface O2WWindow extends Window {
  eval(code: string): unknown;
  BABYLON: { Vector3: new (x: number, y: number, z: number) => O2WCamera['target'] };
}
interface Projection {
  toXZ(latLon: unknown): XZ;
  toLatLon(xz: XZ): { lat: number; lon: number };
}

const frame = document.getElementById('osm2world') as HTMLIFrameElement;
const start = viewOf();
frame.src =
  `/osm2world/demo/?lat=${start.lat}&lon=${start.lng}&radius=${radiusOf(start).toFixed(2)}` +
  `&alpha=${alphaOf(start.bearing).toFixed(4)}&beta=${(start.pitch * RAD).toFixed(4)}`;

/** Which pane the user last touched: it drives the other one. */
let driver: 'map' | 'osm2world' = 'map';

function connect(w: O2WWindow): void {
  const viewer = w.eval('viewer') as { camera: O2WCamera; originLatLon: unknown };
  const LatLon = w.eval('LatLon') as new (lat: number, lon: number) => unknown;
  const Proj = w.eval('OrthographicAzimuthalMapProjection') as new (origin: unknown) => Projection;
  const camera = viewer.camera;
  // The scene stays around the origin it loaded with: tiles are placed relative to it.
  const proj = new Proj(viewer.originLatLon);

  const push = () => {
    const v = viewOf();
    const xz = proj.toXZ(new LatLon(v.lat, v.lng));
    camera.fov = fov();
    camera.target = new w.BABYLON.Vector3(-xz.x, 0, -xz.z);
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

  push();
  map.on('move', () => {
    if (driver === 'map') push();
  });
  camera.onViewMatrixChangedObservable.add(pull);
  for (const type of ['pointerdown', 'wheel', 'touchstart'])
    w.document.addEventListener(type, () => (driver = 'osm2world'), { capture: true });
}

for (const type of ['pointerdown', 'wheel', 'touchstart', 'keydown'])
  map.getContainer().addEventListener(type, () => (driver = 'map'), { capture: true });

frame.addEventListener('load', () => {
  const w = frame.contentWindow as O2WWindow | null;
  if (!w) return;
  // The viewer is created by an inline script after OSM2World's own scripts load.
  const wait = setInterval(() => {
    try {
      if (w.eval('typeof viewer') !== 'object') return;
    } catch {
      return;
    }
    clearInterval(wait);
    connect(w);
  }, 100);
});
