import type {
  FillExtrusionLayerSpecification,
  LayerSpecification,
  StyleSpecification,
} from 'maplibre-gl';
import { layers, namedFlavor } from '@protomaps/basemaps';
import type { Theme } from '../src/index';

export type Basemap = 'streets' | 'satellite';
export type Projection = 'mercator' | 'globe';
export type RoofData = 'overture' | 'local' | 'none';

export interface StyleOptions {
  theme: Theme;
  basemap: Basemap;
  projection: Projection;
  terrain: boolean;
  roofData: RoofData;
  /** Building tileset for the roofs (Overture's official tiles or a local file). */
  roofsUrl: string;
  /** Overture's official tiles keep building parts in their own layer. */
  roofParts: boolean;
  /** Protomaps source: a TileJSON URL or `pmtiles://…`. */
  protomaps: string;
}

/** Basemap flavour that matches each plugin theme. */
const FLAVOR: Record<Theme, 'light' | 'dark'> = {
  day: 'light',
  dawn: 'light',
  dusk: 'dark',
  night: 'dark',
};

export const DEM = {
  type: 'raster-dem' as const,
  tiles: ['https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png'],
  encoding: 'terrarium' as const,
  tileSize: 256,
  maxzoom: 15,
};

const SATELLITE = {
  type: 'raster' as const,
  tiles: [
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  ],
  tileSize: 256,
  maxzoom: 19,
  attribution:
    'Imagery © <a href="https://www.esri.com">Esri</a>, Maxar, Earthstar Geographics and the GIS User Community',
};

/** Wall layers under the roofs. */
export const roofWalls = (roofParts: boolean) =>
  roofParts ? ['roof-buildings-3d', 'roof-parts-3d'] : ['roof-buildings-3d'];

/**
 * Buildings in 3D. With roofs, Overture's buildings (with roof attributes) are the walls and
 * Protomaps' footprints stay flat underneath (outlines drawn by their parts are skipped);
 * without, Protomaps' own buildings are extruded. Either way they sit just below the first
 * label: Protomaps draws roads after buildings, and flat layers drawn after the 3D pass would
 * paint over the extrusions.
 */
function withBuildings(styleLayers: LayerSpecification[], o: StyleOptions): LayerSpecification[] {
  const flat = styleLayers.find((l) => l.id === 'buildings' && l.type === 'fill');
  if (!flat || flat.type !== 'fill') return styleLayers;
  const paint = (): FillExtrusionLayerSpecification['paint'] => ({
    'fill-extrusion-color': flat.paint?.['fill-color'] ?? '#d9d4ce',
    'fill-extrusion-height': ['coalesce', ['get', 'height'], 10],
    'fill-extrusion-base': ['coalesce', ['get', 'min_height'], 0],
  });
  if (o.roofData !== 'none') {
    const walls: LayerSpecification[] = [
      {
        id: 'roof-buildings-3d',
        type: 'fill-extrusion',
        source: 'roof-buildings',
        'source-layer': 'building',
        minzoom: 14,
        filter: ['!=', ['get', 'has_parts'], true],
        paint: paint(),
      },
    ];
    if (o.roofParts)
      walls.push({
        id: 'roof-parts-3d',
        type: 'fill-extrusion',
        source: 'roof-buildings',
        'source-layer': 'building_part',
        minzoom: 14,
        paint: paint(),
      });
    const firstLabel = styleLayers.findIndex((l) => l.type === 'symbol');
    const at = firstLabel === -1 ? styleLayers.length : firstLabel;
    return [...styleLayers.slice(0, at), ...walls, ...styleLayers.slice(at)];
  }
  const extruded: LayerSpecification = {
    id: flat.id,
    type: 'fill-extrusion',
    source: flat.source,
    'source-layer': flat['source-layer'],
    filter: flat.filter,
    minzoom: 14,
    paint: { ...paint(), 'fill-extrusion-opacity': 0.9 },
  };
  const rest = styleLayers.filter((l) => l !== flat);
  const firstSymbol = rest.findIndex((l) => l.type === 'symbol');
  const at = firstSymbol === -1 ? rest.length : firstSymbol;
  return [...rest.slice(0, at), extruded, ...rest.slice(at)];
}

/**
 * Satellite: imagery under Protomaps' roads, boundaries and labels. Area fills (land use, parks,
 * earth) are dropped; the water and building fills stay but are made invisible, so the water
 * and roof layers still find their place in the style.
 */
function onSatellite(styleLayers: LayerSpecification[]): LayerSpecification[] {
  const kept = styleLayers
    .filter((l) => l.type !== 'fill' || l.id === 'water' || l.id === 'buildings')
    .map((l) =>
      l.type === 'fill' ? { ...l, paint: { ...l.paint, 'fill-opacity': 0 } } : l,
    ) as LayerSpecification[];
  const at = kept.findIndex((l) => l.type !== 'background');
  const imagery: LayerSpecification = { id: 'satellite', type: 'raster', source: 'satellite' };
  return [...kept.slice(0, at), imagery, ...kept.slice(at)];
}

/** Hillshading under the roads (streets only), shown only with terrain. */
function withHillshade(styleLayers: LayerSpecification[], o: StyleOptions): LayerSpecification[] {
  if (o.basemap === 'satellite') return styleLayers;
  const dark = FLAVOR[o.theme] === 'dark';
  const at = styleLayers.findIndex((l) => l.id.startsWith('roads'));
  const hillshade: LayerSpecification = {
    id: 'hillshade',
    type: 'hillshade',
    source: 'hillshade-dem',
    layout: { visibility: o.terrain ? 'visible' : 'none' },
    paint: {
      'hillshade-exaggeration': 0.6,
      'hillshade-shadow-color': dark ? '#000000' : '#5a5348',
      'hillshade-highlight-color': dark ? '#3a3f4a' : '#ffffff',
    },
  };
  const i = at === -1 ? styleLayers.length : at;
  return [...styleLayers.slice(0, i), hillshade, ...styleLayers.slice(i)];
}

export function styleFor(o: StyleOptions): StyleSpecification {
  const flavor = FLAVOR[o.theme];
  let styleLayers = layers('protomaps', namedFlavor(flavor), { lang: 'en' });
  if (o.basemap === 'satellite') styleLayers = onSatellite(styleLayers);
  styleLayers = withHillshade(withBuildings(styleLayers, o), o);
  return {
    version: 8,
    glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
    sprite: `https://protomaps.github.io/basemaps-assets/sprites/v4/${flavor}`,
    projection: { type: o.projection },
    // The sky (colours, globe atmosphere) comes from the theme: setTheme(map, theme, { sky: true }).
    ...(o.terrain ? { terrain: { source: 'terrain', exaggeration: 1 } } : {}),
    sources: {
      protomaps: {
        type: 'vector',
        url: o.protomaps,
        attribution:
          '<a href="https://protomaps.com">Protomaps</a> © <a href="https://openstreetmap.org">OpenStreetMap</a>',
      },
      ...(o.basemap === 'satellite' ? { satellite: SATELLITE } : {}),
      ...(o.roofData !== 'none'
        ? { 'roof-buildings': { type: 'vector' as const, url: `pmtiles://${o.roofsUrl}` } }
        : {}),
      terrain: DEM,
      // Hillshading gets its own copy of the DEM (MapLibre warns when terrain shares one).
      'hillshade-dem': DEM,
    },
    layers: styleLayers,
  };
}
