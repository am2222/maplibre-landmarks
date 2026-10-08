import type { FeatureIdentifier, Map as MlMap } from 'maplibre-gl';
import {
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Mesh,
  MeshStandardMaterial,
} from 'three';
import { pointInPolygons } from '../core/geometry';
import type { LayerModule, ModuleContext } from '../core/LayerModule';
import { localPosition, originAt } from '../core/mercator';
import { OwnedPaint } from '../core/ownedPaint';
import type { LngLat, Origin, ViewState } from '../core/types';
import { exemptionsFor, offExemptionsChanged, onExemptionsChanged } from '../labels/exemptions';
import { colorVariance } from './colors';
import { FootprintIndex, type Footprint, type SourceFeatureLike } from './footprints';
import type { Vec2 } from './geometry/frame';
import { buildRoof, type BuiltRoof } from './geometry/roof';
import {
  readRoofProps,
  resolveFields,
  ROOF_SHAPE_VALUES,
  type Fields,
  type RoofProps,
} from './schema';
import { ROOF_STATE, wallRules } from './walls';

export interface RoofsOptions {
  /** Vector source with Overture-schema building attributes and feature ids. */
  source: string;
  sourceLayer?: string;
  /** The app's fill-extrusion layer drawing the walls of the same buildings. */
  extrusionLayer: string;
  fields?: Partial<Fields>;
  minZoom?: number;
  maxBuildings?: number;
  wallColors?: boolean;
  gableColor?: string;
  onError?: (err: unknown) => void;
}

const REBUILD_DEBOUNCE_MS = 150;

interface Drawn {
  footprint: Footprint;
  props: RoofProps;
  built: BuiltRoof;
}

/** Real roof shapes on top of an app's fill-extrusion buildings. */
export class RoofsModule implements LayerModule {
  private ctx?: ModuleContext;
  private walls?: OwnedPaint;
  private mesh?: Mesh<BufferGeometry, MeshStandardMaterial>;
  private anchor?: LngLat;
  private anchorElevation = 0;
  private view?: ViewState;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly fields: Fields;
  private readonly footprints = new FootprintIndex(undefined, (key, err) =>
    this.report(`union:${key}`, err),
  );
  /** Built roofs by footprint key, rebuilt when the footprint's pieces change. */
  private roofs = new Map<string, { signature: string; built: BuiltRoof | null }>();
  /** Roofs currently drawn, with the feature-state written for each. */
  private drawn = new Map<string, Drawn>();
  private readonly elevations = new Map<string, number>();
  private readonly reported = new Set<string>();

  constructor(private readonly options: RoofsOptions) {
    this.fields = resolveFields(options.fields);
  }

  onAdd(ctx: ModuleContext): void {
    this.ctx = ctx;
    const geometry = new BufferGeometry();
    const material = new MeshStandardMaterial({
      vertexColors: true,
      side: DoubleSide,
      roughness: 0.9,
    });
    this.mesh = new Mesh(geometry, material);
    ctx.scene.add(this.mesh);
    this.walls = new OwnedPaint(
      ctx.map,
      this.options.extrusionLayer,
      wallRules(this.fields, this.options.wallColors ?? false),
      (message) => this.report('legacy', new Error(message)),
    );
    this.wrapWalls();
    ctx.map.on('sourcedata', this.onSourceData);
    ctx.map.on('terrain', this.onTerrain);
    onExemptionsChanged(ctx.map, this.schedule);
  }

  update(view: ViewState): void {
    this.view = view;
    this.rebuild();
  }

  place(origin: Origin): void {
    if (!this.mesh || !this.anchor) return;
    this.mesh.position.set(...localPosition(origin, this.anchor, this.anchorElevation));
    this.mesh.updateMatrixWorld();
  }

  styleChanged(attached: boolean): void {
    this.walls?.reset();
    const map = this.ctx?.map;
    // A diffed swap keeps sources and their feature-state: clear ours, then rebuild cleanly.
    for (const { footprint } of this.drawn.values()) {
      this.safely(() => map?.removeFeatureState(this.featureOf(footprint), ROOF_STATE));
    }
    this.drawn.clear();
    if (attached) this.rebuild();
  }

  onRemove(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    clearTimeout(this.timer);
    ctx.map.off('sourcedata', this.onSourceData);
    ctx.map.off('terrain', this.onTerrain);
    offExemptionsChanged(ctx.map, this.schedule);
    for (const { footprint } of this.drawn.values()) {
      this.safely(() => ctx.map.removeFeatureState(this.featureOf(footprint), ROOF_STATE));
    }
    this.drawn.clear();
    this.walls?.restore();
    if (this.mesh) {
      ctx.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
    }
    this.mesh = undefined;
    this.ctx = undefined;
  }

  getStats(): { buildings: number; triangles: number } {
    const count = this.mesh?.geometry.getAttribute('position')?.count ?? 0;
    return { buildings: this.drawn.size, triangles: count / 3 };
  }

  private readonly schedule = (): void => {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.rebuild(), REBUILD_DEBOUNCE_MS);
  };

  private readonly onSourceData = (e: { sourceId?: string; sourceDataType?: string }): void => {
    if (e.sourceDataType && e.sourceDataType !== 'content') return;
    const terrain = this.ctx?.map.getTerrain();
    if (terrain && e.sourceId === terrain.source) this.elevations.clear();
    else if (e.sourceId !== this.options.source) return;
    this.schedule();
  };

  private readonly onTerrain = (): void => {
    this.elevations.clear();
    this.schedule();
  };

  /** True when the walls carry our height wrapper, so roofs can sit on shortened walls. */
  private wrapWalls(): boolean {
    if (!this.walls?.wrap()) {
      this.report(
        'extrusion',
        new Error(`extrusion layer "${this.options.extrusionLayer}" not found`),
      );
      return false;
    }
    return this.walls.isApplied('fill-extrusion-height');
  }

  private rebuild(): void {
    const ctx = this.ctx;
    const view = this.view;
    if (!ctx || !view) return;
    const map = ctx.map;
    const wallsReady = this.wrapWalls();
    let next = new Map<string, Drawn>();
    if (!map.getSource(this.options.source)) {
      this.report('source', new Error(`source "${this.options.source}" not found`));
    } else if (wallsReady && view.zoom >= (this.options.minZoom ?? 15)) {
      next = this.collect(map, view);
    }
    this.writeStates(map, next);
    this.drawn = next;
    this.merge(map);
    ctx.requestRepaint();
  }

  private collect(map: MlMap, view: ViewState): Map<string, Drawn> {
    const gable = this.options.gableColor ?? '#d9d4ce';
    const layerIds = (map.getSource(this.options.source) as { vectorLayerIds?: string[] })
      .vectorLayerIds;
    if (this.options.sourceLayer && layerIds && !layerIds.includes(this.options.sourceLayer)) {
      this.report(
        'sourceLayer',
        new Error(`source "${this.options.source}" has no layer "${this.options.sourceLayer}"`),
      );
    }
    // Only roofed buildings: MapLibre skips building GeoJSON for everything else.
    const filter = [
      'in',
      ['downcase', ['to-string', ['get', this.fields.roof_shape]]],
      ['literal', ROOF_SHAPE_VALUES],
    ];
    const features = map.querySourceFeatures(this.options.source, {
      ...(this.options.sourceLayer ? { sourceLayer: this.options.sourceLayer } : {}),
      filter: filter as never,
    }) as unknown as SourceFeatureLike[];
    const footprints = this.footprints.update(
      features,
      (p) => readRoofProps(p, this.fields, gable) !== null,
    );
    if (this.footprints.missingIds) {
      this.report('ids', new Error(`source "${this.options.source}" has buildings without ids`));
    }
    const exempt = exemptionsFor(map);
    const [cx, cy] = view.center;
    const k = Math.cos((cy * Math.PI) / 180);
    const nearest = [...footprints.values()]
      .filter((f) => !pointInPolygons(f.centroid, exempt))
      .map((f) => ({ f, d: Math.hypot((f.centroid[0] - cx) * k, f.centroid[1] - cy) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, this.options.maxBuildings ?? 2000);
    const roofs = new Map<string, { signature: string; built: BuiltRoof | null }>();
    const next = new Map<string, Drawn>();
    for (const { f } of nearest) {
      const props = readRoofProps(f.properties, this.fields, gable)!;
      let entry = this.roofs.get(f.key);
      if (!entry || entry.signature !== f.signature) {
        entry = { signature: f.signature, built: this.build(f, props) };
      }
      roofs.set(f.key, entry);
      if (entry.built) next.set(f.key, { footprint: f, props, built: entry.built });
    }
    this.roofs = roofs;
    return next;
  }

  private build(f: Footprint, props: RoofProps): BuiltRoof | null {
    try {
      const origin = originAt(f.centroid);
      const local: Vec2[][][] = f.polygons.map((rings) =>
        rings.map((ring) =>
          ring.map((p) => {
            const [x, , z] = localPosition(origin, p as LngLat);
            return [x, z] as Vec2;
          }),
        ),
      );
      return buildRoof(props, local, colorVariance(f.id));
    } catch (err) {
      this.report(`roof:${f.key}`, err);
      return null;
    }
  }

  private writeStates(map: MlMap, next: Map<string, Drawn>): void {
    for (const [key, { footprint }] of this.drawn) {
      if (!next.has(key))
        this.safely(() => map.removeFeatureState(this.featureOf(footprint), ROOF_STATE));
    }
    for (const [key, d] of next) {
      if (this.drawn.get(key)?.built.roofHeight === d.built.roofHeight) continue;
      this.safely(() =>
        map.setFeatureState(this.featureOf(d.footprint), { [ROOF_STATE]: d.built.roofHeight }),
      );
    }
  }

  /** One mesh around an anchor (the first roof), each roof lifted to its wall top. */
  private merge(map: MlMap): void {
    const mesh = this.mesh;
    if (!mesh) return;
    const positions: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];
    const drawn = [...this.drawn.values()];
    this.anchor = drawn[0]?.footprint.centroid;
    if (this.anchor) {
      const anchorOrigin = originAt(this.anchor);
      this.anchorElevation = this.elevation(map, 'anchor', this.anchor);
      for (const { footprint, props, built } of drawn) {
        const [ox, , oz] = localPosition(anchorOrigin, footprint.centroid);
        const lift =
          props.height -
          built.roofHeight +
          this.elevation(map, footprint.key, footprint.terrainPoint) -
          this.anchorElevation;
        const p = built.mesh.positions;
        for (let i = 0; i < p.length; i += 3)
          positions.push(p[i]! + ox, p[i + 1]! + lift, p[i + 2]! + oz);
        normals.push(...built.mesh.normals);
        colors.push(...built.mesh.colors);
      }
    }
    const geometry = mesh.geometry;
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
    geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
    geometry.computeBoundingSphere();
  }

  /** Ground under a point as MapLibre draws it (extrusions sit on their centroid's elevation). */
  private elevation(map: MlMap, key: string, lngLat: LngLat): number {
    if (!map.getTerrain()) return 0;
    const cacheKey = key === 'anchor' ? `anchor:${lngLat.join()}` : key;
    let e = this.elevations.get(cacheKey);
    if (e === undefined) {
      e = map.queryTerrainElevation(lngLat) ?? 0;
      this.elevations.set(cacheKey, e);
    }
    return e;
  }

  private featureOf(f: Footprint): FeatureIdentifier {
    return { source: this.options.source, sourceLayer: this.options.sourceLayer, id: f.id };
  }

  private report(key: string, err: unknown): void {
    if (this.reported.has(key)) return;
    this.reported.add(key);
    if (this.options.onError) this.options.onError(err);
    else console.warn('[maplibre-landmarks] roofs', err);
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch {
      // The style was torn down.
    }
  }
}
