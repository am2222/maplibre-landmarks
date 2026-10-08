import type { FeatureIdentifier, Map as MlMap } from 'maplibre-gl';
import { pointInPolygons, polygonsOf } from '../core/geometry';
import type { LngLat } from '../core/types';

const LABEL_SOURCE_LAYERS = ['pois', 'poi', 'buildings', 'building'];
/** Probes sit this far above the ground or roof so the surface itself never hides them. */
const PROBE_LIFT_M = 2.5;
/** Assumed storey height when a building only has a base height. */
const STOREY_M = 9;
const MAX_ROOF_CACHE = 2048;

export interface StyleLayerLike {
  id: string;
  type: string;
  source?: string;
  'source-layer'?: string;
  layout?: Record<string, unknown>;
}

export type LayerReader = Pick<MlMap, 'getLayersOrder' | 'getLayer' | 'getLayoutProperty'>;

/** The style's layers in order, read without `getStyle()` (which deep-clones the style). */
export function styleLayersOf(map: LayerReader): StyleLayerLike[] {
  return map.getLayersOrder().flatMap((id) => {
    const layer = map.getLayer(id) as
      { type: string; source?: string; sourceLayer?: string } | undefined;
    if (!layer) return [];
    const placement =
      layer.type === 'symbol' ? map.getLayoutProperty(id, 'symbol-placement') : undefined;
    return [
      {
        id,
        type: layer.type,
        source: layer.source,
        'source-layer': layer.sourceLayer,
        layout: placement === undefined ? undefined : { 'symbol-placement': placement },
      },
    ];
  });
}

/** Point labels of POI and building layers, or the existing symbol layers of `override`. */
export function labelLayerIds(layers: StyleLayerLike[], override?: string[]): string[] {
  if (override) {
    return override.filter((id) => layers.some((l) => l.id === id && l.type === 'symbol'));
  }
  return layers
    .filter(
      (l) =>
        l.type === 'symbol' &&
        (l.layout?.['symbol-placement'] ?? 'point') === 'point' &&
        LABEL_SOURCE_LAYERS.includes(l['source-layer'] ?? ''),
    )
    .map((l) => l.id);
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' && v !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};

/** Roof height of an extruded building from its tile properties. */
export function roofHeight(p: Record<string, unknown>): number {
  const min = num(p.min_height);
  return num(p.render_height) ?? num(p.height) ?? (min !== undefined ? min + STOREY_M : 0);
}

export interface Candidate {
  /** `source/sourceLayer/id`. */
  key: string;
  feature: FeatureIdentifier;
  lngLat: LngLat;
  /** Probe height in metres above sea level (terrain exaggeration included). */
  elevation: number;
  /**
   * Never probed, always shown: inside a landmark footprint, or the anchor is off-screen (GL
   * clips a point by its centre, so its probe would read as hidden).
   */
  exempt: boolean;
  /** Roof height not looked up yet (lookup budget spent): not probed this scan. */
  pending: boolean;
}

export type ScanMap = Pick<
  MlMap,
  | 'queryRenderedFeatures'
  | 'project'
  | 'getCenter'
  | 'getLayersOrder'
  | 'getLayer'
  | 'getLayoutProperty'
  | 'getTerrain'
  | 'queryTerrainElevation'
  | 'getCanvas'
>;

interface Found {
  key: string;
  feature: FeatureIdentifier;
  lngLat: LngLat;
  distance: number;
  onScreen: boolean;
}

/** Finds the labels on screen and where to probe each one. */
export class CandidateScanner {
  private readonly roofs = new Map<string, { lng: number; lat: number; roof: number }>();
  private exemptions: number[][][][] = [];

  constructor(
    private readonly map: ScanMap,
    private readonly maxRoofLookups = 48,
  ) {}

  setExemptions(polygons: number[][][][]): void {
    this.exemptions = polygons;
  }

  clearRoofs(): void {
    this.roofs.clear();
  }

  /**
   * Drop cached "no roof" results. A building tile that had not rendered yet reads as open
   * ground, which would probe the label inside its own building; call when building tiles load.
   */
  forgetGround(): void {
    for (const [key, { roof }] of this.roofs) if (roof === 0) this.roofs.delete(key);
  }

  scan(layerIds: string[], maxLabels: number): Candidate[] {
    if (!layerIds.length) return [];
    const centre = this.map.project(this.map.getCenter());
    const { clientWidth: width, clientHeight: height } = this.map.getCanvas();
    const found = new Map<string, Found>();
    for (const f of this.map.queryRenderedFeatures({ layers: layerIds })) {
      if (f.id === undefined || f.id === null || f.geometry.type !== 'Point') continue;
      const key = `${f.source}/${f.sourceLayer ?? ''}/${f.id}`;
      if (found.has(key)) continue;
      const lngLat = f.geometry.coordinates as LngLat;
      const p = this.map.project(lngLat);
      found.set(key, {
        key,
        feature: { source: f.source, sourceLayer: f.sourceLayer, id: f.id },
        lngLat,
        distance: Math.hypot(p.x - centre.x, p.y - centre.y),
        onScreen: p.x >= 0 && p.x <= width && p.y >= 0 && p.y <= height,
      });
    }
    const nearest = [...found.values()].sort((a, b) => a.distance - b.distance).slice(0, maxLabels);
    const extrusions = styleLayersOf(this.map)
      .filter((l) => l.type === 'fill-extrusion')
      .map((l) => l.id);
    const terrain = !!this.map.getTerrain();
    let budget = this.maxRoofLookups;
    return nearest.map(({ key, feature, lngLat, onScreen }) => {
      const exempt = !onScreen || pointInPolygons(lngLat, this.exemptions);
      let roof = 0;
      let pending = false;
      if (!exempt && extrusions.length) {
        const cached = this.roofs.get(key);
        if (cached && cached.lng === lngLat[0] && cached.lat === lngLat[1]) roof = cached.roof;
        else if (budget > 0) {
          budget--;
          roof = this.lookupRoof(lngLat, extrusions);
          this.remember(key, lngLat, roof);
        } else pending = true;
      }
      const ground = terrain ? (this.map.queryTerrainElevation(lngLat) ?? 0) : 0;
      return { key, feature, lngLat, elevation: ground + roof + PROBE_LIFT_M, exempt, pending };
    });
  }

  private lookupRoof(lngLat: LngLat, layers: string[]): number {
    let roof = 0;
    for (const f of this.map.queryRenderedFeatures(this.map.project(lngLat), { layers })) {
      const geometry = f.geometry as { type: string; coordinates: unknown };
      if (pointInPolygons(lngLat, polygonsOf(geometry))) {
        roof = Math.max(roof, roofHeight((f.properties ?? {}) as Record<string, unknown>));
      }
    }
    return roof;
  }

  private remember(key: string, [lng, lat]: LngLat, roof: number): void {
    this.roofs.delete(key);
    this.roofs.set(key, { lng, lat, roof });
    while (this.roofs.size > MAX_ROOF_CACHE) this.roofs.delete(this.roofs.keys().next().value!);
  }
}
