import type { FeatureIdentifier, Map as MlMap } from 'maplibre-gl';
import polygonClipping, { type MultiPolygon } from 'polygon-clipping';
import { sameValue, scaleBy, stripWrappers } from '../core/expressions';
import { pointInPolygons, polygonsOf, type Ring } from '../core/geometry';
import { notifyExemptionsChanged } from '../labels/exemptions';
import { EARTH_RADIUS_M } from '../core/mercator';
import type { LandmarkEntry } from './catalogue';
import { entryKey } from './discovery';

export type { Ring } from '../core/geometry';
export type ReplacementTarget = Pick<
  MlMap,
  | 'getLayer'
  | 'getPaintProperty'
  | 'setPaintProperty'
  | 'querySourceFeatures'
  | 'setFeatureState'
  | 'removeFeatureState'
  | 'on'
  | 'off'
>;

/**
 * Feature-state key on basemap buildings a landmark replaces: 0 = shown, 1 = fully replaced.
 * Values in between animate the hand-over (extrusions sink, flat fills fade).
 */
export const FADE_STATE = 'landmarks:fade';
const KEEP = ['-', 1, ['coalesce', ['feature-state', FADE_STATE], 0]];
const ourScale = (v: unknown) =>
  Array.isArray(v) && v.length === 3 && v[0] === '*' && sameValue(v[2], KEEP) ? v[1] : undefined;
const RESCAN_DEBOUNCE_MS = 100;
type PaintProperty = Parameters<MlMap['getPaintProperty']>[1];
type PaintValue = Parameters<MlMap['setPaintProperty']>[2];

const METRES_PER_DEG = (2 * Math.PI * EARTH_RADIUS_M) / 360;

/**
 * Moves each vertex insetM metres toward the ring's vertex centroid (approximate inward buffer).
 * A negative insetM moves vertices away from the centroid (outward buffer).
 */
export function insetRing(ring: Ring, insetM: number): Ring {
  const closed =
    ring.length > 1 && ring[0]![0] === ring.at(-1)![0] && ring[0]![1] === ring.at(-1)![1];
  const pts = closed ? ring.slice(0, -1) : ring;
  const cx = pts.reduce((s, p) => s + p[0]!, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1]!, 0) / pts.length;
  const kx = METRES_PER_DEG * Math.cos((cy * Math.PI) / 180);
  const out = pts.map(([x, y]) => {
    const dx = (x! - cx) * kx;
    const dy = (y! - cy) * METRES_PER_DEG;
    const d = Math.hypot(dx, dy);
    if (insetM === 0 || d === 0) return [x!, y!];
    const f = d > insetM ? (d - insetM) / d : 0;
    return [cx + (x! - cx) * f, cy + (y! - cy) * f];
  });
  return [...out, out[0]!];
}

export function footprintOf(entry: LandmarkEntry, insetM: number): number[][][][] {
  const fp = entry.replacementFootprint;
  const [w, s, e, n] = entry.bounds;
  const polygons: number[][][][] = !fp
    ? [
        [
          [
            [w, s],
            [e, s],
            [e, n],
            [w, n],
            [w, s],
          ],
        ],
      ]
    : fp.type === 'Polygon'
      ? [fp.coordinates]
      : fp.coordinates;
  // Outer rings shrink and holes grow, so buildings sharing a wall on either side stay visible.
  return polygons.map(([outer, ...holes]) => [
    insetRing(outer!, insetM),
    ...holes.map((h) => insetRing(h, -insetM)),
  ]);
}

/** Paint properties scaled by (1 − fade), per layer type. */
const HIDING_PAINT: Record<string, [property: PaintProperty, fallback: unknown][]> = {
  fill: [['fill-opacity', 1]],
  'fill-extrusion': [
    ['fill-extrusion-height', 0],
    ['fill-extrusion-base', 0],
  ],
};

/** Vertex centroid of a feature's first outer ring, or null for non-polygons. */
function centreOf(geometry: { type: string; coordinates: unknown }): number[] | null {
  const ring =
    geometry.type === 'Polygon'
      ? (geometry.coordinates as number[][][])[0]
      : geometry.type === 'MultiPolygon'
        ? (geometry.coordinates as number[][][][])[0]?.[0]
        : undefined;
  if (!ring?.length) return null;
  const pts = ring.length > 1 ? ring.slice(0, -1) : ring;
  return [
    pts.reduce((a, p) => a + p[0]!, 0) / pts.length,
    pts.reduce((a, p) => a + p[1]!, 0) / pts.length,
  ];
}

/**
 * Share of a building inside a footprint above which it is replaced even with its centre
 * outside: parts straddling the outline (a tower's legs). Neighbours that only share a wall
 * overlap the inset footprint by about nothing.
 */
const MOSTLY_INSIDE = 0.4;

type Bbox = [number, number, number, number];

function bboxOf(polygons: number[][][][]): Bbox {
  const b: Bbox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const rings of polygons)
    for (const [x, y] of rings[0] ?? []) {
      b[0] = Math.min(b[0], x!);
      b[1] = Math.min(b[1], y!);
      b[2] = Math.max(b[2], x!);
      b[3] = Math.max(b[3], y!);
    }
  return b;
}

const overlaps = (a: Bbox, b: Bbox) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

/** Shoelace area of polygons with holes (degrees²: only ratios are used). */
function areaOf(polygons: number[][][][]): number {
  let total = 0;
  for (const rings of polygons)
    rings.forEach((ring, i) => {
      let a = 0;
      for (let k = 0; k + 1 < ring.length; k++)
        a += ring[k]![0]! * ring[k + 1]![1]! - ring[k + 1]![0]! * ring[k]![1]!;
      total += (i === 0 ? 1 : -1) * Math.abs(a / 2);
    });
  return total;
}

/** Share (0..1) of a building's area inside a footprint; 0 when it cannot be computed. */
function shareInside(building: number[][][][], footprint: number[][][][]): number {
  const area = areaOf(building);
  if (!(area > 0)) return 0;
  try {
    const inside = polygonClipping.intersection(
      building as MultiPolygon,
      footprint as MultiPolygon,
    ) as number[][][][];
    return areaOf(inside) / area;
  } catch {
    return 0;
  }
}

interface Target {
  layerId: string;
  source: string;
  sourceLayer?: string;
}

/** A landmark whose basemap buildings are being (or have been) handed over to its model. */
export interface Replacing {
  entry: LandmarkEntry;
  /** 0 = basemap building shown, 1 = fully replaced. */
  fade: number;
}

interface Claimed {
  feature: FeatureIdentifier;
  owners: string[];
}

/**
 * Hides basemap buildings under loaded landmarks with feature-state (repaint only, no tile
 * re-parse). Each target layer's paint is wrapped once so a feature's fade scales it away.
 */
export class BuildingReplacement {
  private readonly originals = new Map<
    string,
    Map<PaintProperty, { original: unknown; applied: unknown }>
  >();
  /** Features under the current landmarks, by `source/layer/id`. */
  private claimed = new Map<string, Claimed>();
  /** Fade value last written to each feature. */
  private applied = new Map<string, FeatureIdentifier & { fade: number }>();
  private regions: {
    key: string;
    footprints: number[][][][];
    bbox: Bbox;
    ids: (number | string)[];
  }[] = [];
  /** Keys of the claimed features last written (listeners hear when the set changes). */
  private claimedKey = '';
  private fades = new Map<string, number>();
  private lastKey = '';
  private listening = false;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly map: ReplacementTarget,
    private readonly layerIds: string[],
    private readonly insetM: number,
  ) {}

  /** Set the landmarks being replaced and their fades. Cheap when only fades change. */
  update(items: Replacing[]): void {
    this.fades = new Map(items.map((i) => [entryKey(i.entry), i.fade]));
    const key = [...this.fades.keys()].sort().join('|');
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.regions = items.map(({ entry }) => {
        const footprints = footprintOf(entry, this.insetM);
        return {
          key: entryKey(entry),
          footprints,
          bbox: bboxOf(footprints),
          ids: entry.basemapReplacement?.featureIds ?? [],
        };
      });
      if (this.regions.length && !this.listening) {
        this.map.on('sourcedata', this.onSourceData);
        this.listening = true;
      }
      this.rescan();
    }
    this.apply();
  }

  /** Forget state tied to a replaced style without touching the map. */
  reset(): void {
    this.originals.clear();
    this.claimed.clear();
    this.applied.clear();
    this.lastKey = '';
    this.claimedKey = '';
  }

  restore(): void {
    clearTimeout(this.timer);
    if (this.listening) this.map.off('sourcedata', this.onSourceData);
    this.listening = false;
    for (const f of this.applied.values())
      this.safely(() => this.map.removeFeatureState(f, FADE_STATE));
    this.applied.clear();
    this.claimed.clear();
    if (this.claimedKey) {
      this.claimedKey = '';
      notifyExemptionsChanged(this.map);
    }
    for (const [layerId, props] of this.originals) {
      for (const [prop, { original, applied }] of props) {
        this.safely(() => {
          // Another wrapper (e.g. roofs) may sit on top of ours now: leave it in place.
          if (
            this.map.getLayer(layerId) &&
            sameValue(this.map.getPaintProperty(layerId, prop), applied)
          ) {
            this.map.setPaintProperty(layerId, prop, original as PaintValue);
          }
        });
      }
    }
    this.originals.clear();
    this.regions = [];
    this.fades.clear();
    this.lastKey = '';
  }

  /**
   * Lowest zoom at which every replaced extrusion layer draws. A model shown below it would
   * stand alone among flat buildings, so models wait for it.
   */
  extrusionMinZoom(): number {
    let zoom = 0;
    for (const layerId of this.layerIds) {
      const layer = this.map.getLayer(layerId) as { type: string; minzoom?: number } | undefined;
      if (layer?.type === 'fill-extrusion') zoom = Math.max(zoom, layer.minzoom ?? 0);
    }
    return zoom;
  }

  private targets(): Target[] {
    const out: Target[] = [];
    for (const layerId of this.layerIds) {
      const layer = this.map.getLayer(layerId) as
        { type: string; source: string; sourceLayer?: string } | undefined;
      if (layer && HIDING_PAINT[layer.type]) {
        out.push({ layerId, source: layer.source, sourceLayer: layer.sourceLayer });
        this.wrapPaint(layerId, layer.type);
      }
    }
    return out;
  }

  private wrapPaint(layerId: string, type: string): void {
    if (this.originals.has(layerId)) return;
    const props = new Map<PaintProperty, { original: unknown; applied: unknown }>();
    for (const [prop, fallback] of HIDING_PAINT[type]!) {
      // A wrapper of ours may still be in the style (re-added layer, style reset): peel it.
      const original = stripWrappers(this.map.getPaintProperty(layerId, prop), ourScale);
      const scaled = scaleBy(original ?? fallback, KEEP);
      if (scaled === undefined) {
        console.warn(`[maplibre-landmarks] cannot wrap legacy function ${layerId}/${prop}`);
        continue;
      }
      props.set(prop, { original, applied: scaled });
      this.map.setPaintProperty(layerId, prop, scaled as PaintValue);
    }
    this.originals.set(layerId, props);
  }

  /** Work out which basemap features each landmark claims (on model-set change or new tiles). */
  private rescan(): void {
    const next = new Map<string, Claimed>();
    const claim = (k: string, feature: FeatureIdentifier, owner: string) => {
      const c = next.get(k);
      if (!c) next.set(k, { feature, owners: [owner] });
      else if (!c.owners.includes(owner)) c.owners.push(owner);
    };
    const scanned = new Set<string>();
    for (const t of this.targets()) {
      const sourceKey = `${t.source}/${t.sourceLayer ?? ''}`;
      if (!this.regions.length || scanned.has(sourceKey)) continue;
      scanned.add(sourceKey);
      const at = (id: number | string): FeatureIdentifier => ({
        source: t.source,
        sourceLayer: t.sourceLayer,
        id,
      });
      // Ids Open Landmarks lists for each model (authoritative for Protomaps builds)...
      for (const r of this.regions)
        for (const id of r.ids) claim(`${sourceKey}/${id}`, at(id), r.key);
      // ...plus anything whose centre falls inside an inset footprint (newer OSM, other basemaps).
      const features = this.map.querySourceFeatures(
        t.source,
        t.sourceLayer ? { sourceLayer: t.sourceLayer } : {},
      );
      for (const f of features) {
        if (f.id === undefined || f.id === null) continue;
        const geometry = f.geometry as { type: string; coordinates: unknown };
        const centre = centreOf(geometry);
        if (!centre) continue;
        // Dense tiles hold thousands of buildings, nearly all far from any landmark: reject
        // them by their bounds before the outline tests.
        const polygons = polygonsOf(geometry);
        const box = bboxOf(polygons);
        for (const r of this.regions) {
          if (!overlaps(box, r.bbox)) continue;
          // ...or mostly inside it (parts straddling the outline).
          const inside =
            pointInPolygons(centre, r.footprints) ||
            shareInside(polygons, r.footprints) >= MOSTLY_INSIDE;
          if (inside) claim(`${sourceKey}/${f.id}`, at(f.id), r.key);
        }
      }
    }
    this.claimed = next;
  }

  /** Write each claimed feature's fade (the strongest of its owners); clear released ones. */
  private apply(): void {
    for (const [k, f] of this.applied) {
      if (!this.claimed.has(k)) {
        this.map.removeFeatureState(f, FADE_STATE);
        this.applied.delete(k);
      }
    }
    for (const [k, { feature, owners }] of this.claimed) {
      const fade = Math.max(0, ...owners.map((o) => this.fades.get(o) ?? 0));
      const prev = this.applied.get(k);
      if (prev?.fade === fade) continue;
      this.map.setFeatureState(feature, { [FADE_STATE]: fade });
      this.applied.set(k, { ...feature, fade });
    }
    // Roofs drawn on these buildings hide with them: tell exemption listeners about the change.
    const key = [...this.claimed.keys()].sort().join('|');
    if (key !== this.claimedKey) {
      this.claimedKey = key;
      notifyExemptionsChanged(this.map);
    }
  }

  private readonly onSourceData = (e: { sourceId?: string }): void => {
    if (!this.regions.length) return;
    const sources = new Set(
      this.layerIds.map((id) => (this.map.getLayer(id) as { source?: string } | undefined)?.source),
    );
    if (!e.sourceId || !sources.has(e.sourceId)) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () =>
        this.safely(() => {
          this.rescan();
          this.apply();
        }),
      RESCAN_DEBOUNCE_MS,
    );
  };

  private safely(fn: () => void): void {
    try {
      fn();
    } catch {
      // The style was torn down (setStyle / map.remove).
    }
  }
}
