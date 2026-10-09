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
import { TileFeed, type FeedMap } from '../core/tileFeed';
import type { LngLat, Origin, ViewState } from '../core/types';
import { exemptionsFor, offExemptionsChanged, onExemptionsChanged } from '../labels/exemptions';
import { FADE_STATE } from '../landmarks/replacement';
import { colorVariance } from './colors';
import { BuildingPieces } from './buildingPieces';
import type { Footprint } from './footprints';
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
  /** Source layer when an extrusion layer does not name one (GeoJSON sources need none). */
  sourceLayer?: string;
  /**
   * The app's fill-extrusion layer(s) drawing the walls of the same buildings. Each layer's own
   * `source-layer` is read, so buildings and building parts in separate layers (Overture's
   * official tiles) both get roofs.
   */
  extrusionLayer: string | string[];
  fields?: Partial<Fields>;
  minZoom?: number;
  maxBuildings?: number;
  wallColors?: boolean;
  gableColor?: string;
  onError?: (err: unknown) => void;
}

const REBUILD_DEBOUNCE_MS = 150;

interface Drawn {
  /** Source layer the footprint came from (ids repeat across layers). */
  sourceLayer: string | undefined;
  footprint: Footprint;
  props: RoofProps;
  built: BuiltRoof;
}

/** Real roof shapes on top of an app's fill-extrusion buildings. */
export class RoofsModule implements LayerModule {
  private ctx?: ModuleContext;
  /** Our paint wrappers, by extrusion layer id. */
  private readonly walls = new Map<string, OwnedPaint>();
  private readonly extrusionLayers: string[];
  private mesh?: Mesh<BufferGeometry, MeshStandardMaterial>;
  private anchor?: LngLat;
  private anchorElevation = 0;
  private view?: ViewState;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly fields: Fields;
  /** Roofed building pieces of the held tiles, merged per building on demand. */
  private readonly pieces: BuildingPieces;
  /** One tile feed per source layer drawn by a wrapped extrusion layer ('' when none). */
  private readonly feeds = new Map<string, TileFeed>();
  /** Terrain changed since the last merge. */
  private groundChanged = false;
  /** Built roofs by layer-qualified footprint key, rebuilt when the footprint's pieces change. */
  private roofs = new Map<string, { signature: string; built: BuiltRoof | null }>();
  /** Roofs currently drawn, with the feature-state written for each. */
  private drawn = new Map<string, Drawn>();
  private readonly elevations = new Map<string, number>();
  private readonly reported = new Set<string>();

  constructor(private readonly options: RoofsOptions) {
    this.fields = resolveFields(options.fields);
    this.extrusionLayers = [options.extrusionLayer].flat();
    const gable = options.gableColor ?? '#d9d4ce';
    this.pieces = new BuildingPieces(
      (p) => readRoofProps(p, this.fields, gable) !== null,
      undefined,
      (key, err) => this.report(`union:${key}`, err),
    );
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
    for (const id of this.extrusionLayers)
      this.walls.set(
        id,
        new OwnedPaint(
          ctx.map,
          id,
          wallRules(this.fields, this.options.wallColors ?? false),
          (message) => this.report(`legacy:${id}`, new Error(message)),
        ),
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
    for (const walls of this.walls.values()) walls.reset();
    const map = this.ctx?.map;
    // A diffed swap keeps sources and their feature-state: clear ours, then rebuild cleanly.
    for (const d of this.drawn.values()) {
      if (map) this.unsetState(map, d);
    }
    this.drawn.clear();
    // A swapped style may carry other tiles: start the feeds over.
    for (const feed of this.feeds.values()) feed.reset();
    if (attached) this.rebuild();
  }

  onRemove(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    clearTimeout(this.timer);
    for (const layer of [...this.feeds.keys()]) this.removeFeed(layer);
    ctx.map.off('sourcedata', this.onSourceData);
    ctx.map.off('terrain', this.onTerrain);
    offExemptionsChanged(ctx.map, this.schedule);
    for (const d of this.drawn.values()) {
      this.unsetState(ctx.map, d);
    }
    this.drawn.clear();
    for (const walls of this.walls.values()) walls.restore();
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
    if (terrain && e.sourceId === terrain.source) this.forgetGround();
    else if (e.sourceId !== this.options.source) return;
    this.schedule();
  };

  private readonly onTerrain = (): void => {
    this.forgetGround();
    this.schedule();
  };

  private forgetGround(): void {
    this.elevations.clear();
    this.groundChanged = true;
  }

  /**
   * Source layers whose walls carry our height wrapper, so their roofs can sit on shortened
   * walls (`undefined` for a source without layers).
   */
  private wrapWalls(): (string | undefined)[] {
    const ready = new Set<string | undefined>();
    for (const [id, walls] of this.walls) {
      if (!walls.wrap()) {
        this.report(`extrusion:${id}`, new Error(`extrusion layer "${id}" not found`));
        continue;
      }
      if (walls.isApplied('fill-extrusion-height')) ready.add(this.sourceLayerOf(id));
    }
    return [...ready];
  }

  /** The source layer an extrusion layer draws (its own, else the `sourceLayer` option). */
  private sourceLayerOf(extrusionLayer: string): string | undefined {
    const layer = this.ctx?.map.getLayer(extrusionLayer) as
      { sourceLayer?: string; 'source-layer'?: string } | undefined;
    return layer?.sourceLayer ?? layer?.['source-layer'] ?? this.options.sourceLayer;
  }

  private rebuild(): void {
    const ctx = this.ctx;
    const view = this.view;
    if (!ctx || !view) return;
    const map = ctx.map;
    const ready = this.wrapWalls();
    let next = new Map<string, Drawn>();
    const source = map.getSource(this.options.source) as { vectorLayerIds?: string[] } | undefined;
    if (!source) this.report('source', new Error(`source "${this.options.source}" not found`));
    const active = source && view.zoom >= (this.options.minZoom ?? 15) ? ready : [];
    const feeds = this.syncFeeds(active, source?.vectorLayerIds);
    if (feeds.length) {
      try {
        for (const feed of feeds) feed.settle();
      } catch (err) {
        this.report('settle', err);
      }
      next = this.collect(map, view);
    }
    this.writeStates(map, next);
    const same =
      !this.groundChanged &&
      next.size === this.drawn.size &&
      [...next].every(([key, d]) => {
        const old = this.drawn.get(key);
        return old?.built === d.built && old.footprint === d.footprint;
      });
    this.drawn = next;
    if (same) return;
    this.groundChanged = false;
    this.merge(map);
    ctx.requestRepaint();
  }

  /**
   * One feed per source layer to roof; feeds of layers no longer drawn (zoomed out, walls not
   * wrapped) are suspended: they hold no tiles until they are drawn again. Returns the active ones.
   */
  private syncFeeds(
    sourceLayers: (string | undefined)[],
    layerIds: string[] | undefined,
  ): TileFeed[] {
    const wanted = new Set<string>();
    for (const sourceLayer of sourceLayers) {
      if (sourceLayer && layerIds && !layerIds.includes(sourceLayer)) {
        this.report(
          `sourceLayer:${sourceLayer}`,
          new Error(`source "${this.options.source}" has no layer "${sourceLayer}"`),
        );
        continue;
      }
      wanted.add(sourceLayer ?? '');
    }
    for (const [layer, feed] of this.feeds) if (!wanted.has(layer)) feed.suspend();
    for (const layer of wanted) if (!this.feeds.has(layer)) this.addFeed(layer);
    return [...wanted].map((layer) => this.feeds.get(layer)!);
  }

  private addFeed(layer: string): void {
    // Only roofed buildings: MapLibre skips building GeoJSON for everything else.
    const filter = [
      'in',
      ['downcase', ['to-string', ['get', this.fields.roof_shape]]],
      ['literal', ROOF_SHAPE_VALUES],
    ];
    const feed = new TileFeed(this.ctx!.map as unknown as FeedMap, {
      source: this.options.source,
      ...(layer ? { sourceLayer: layer } : {}),
      filter,
      onTile: (key, features) => {
        this.pieces.add(key, layer, features);
        if (this.pieces.missingIds)
          this.report(
            'ids',
            new Error(`source "${this.options.source}" has buildings without ids`),
          );
        this.schedule();
      },
      onDrop: (key) => {
        this.pieces.drop(key, layer);
        this.schedule();
      },
    });
    this.feeds.set(layer, feed);
  }

  private removeFeed(layer: string): void {
    const feed = this.feeds.get(layer);
    if (!feed) return;
    feed.reset(); // drops its pieces
    feed.dispose();
    this.feeds.delete(layer);
  }

  /** The nearest roofed buildings of the held tiles (built roofs reused while unchanged). */
  private collect(map: MlMap, view: ViewState): Map<string, Drawn> {
    const gable = this.options.gableColor ?? '#d9d4ce';
    const exempt = exemptionsFor(map);
    const [cx, cy] = view.center;
    const k = Math.cos((cy * Math.PI) / 180);
    const found: { key: string; f: Footprint; sourceLayer: string | undefined; d: number }[] = [];
    for (const key of this.pieces.keys()) {
      const f = this.pieces.footprint(key);
      if (!f) continue;
      const layer = this.pieces.sourceLayerOf(key);
      const sourceLayer = layer || undefined;
      // Buildings a landmark model replaces lose their roof along with their walls.
      if (this.replacedByLandmark(map, sourceLayer, f.id)) continue;
      if (pointInPolygons(f.centroid, exempt)) continue;
      const d = Math.hypot((f.centroid[0] - cx) * k, f.centroid[1] - cy);
      found.push({ key, f, sourceLayer, d });
    }
    const nearest = found.sort((a, b) => a.d - b.d).slice(0, this.options.maxBuildings ?? 2000);
    const roofs = new Map<string, { signature: string; built: BuiltRoof | null }>();
    const next = new Map<string, Drawn>();
    for (const { sourceLayer, key, f } of nearest) {
      const props = readRoofProps(f.properties, this.fields, gable)!;
      let entry = this.roofs.get(key);
      if (!entry || entry.signature !== f.signature) {
        entry = { signature: f.signature, built: this.build(f, props) };
      }
      roofs.set(key, entry);
      if (entry.built) next.set(key, { sourceLayer, footprint: f, props, built: entry.built });
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
    for (const [key, d] of this.drawn) {
      if (!next.has(key)) this.unsetState(map, d);
    }
    for (const [key, d] of next) {
      if (this.drawn.get(key)?.built.roofHeight === d.built.roofHeight) continue;
      this.safely(() =>
        map.setFeatureState(this.featureOf(d), { [ROOF_STATE]: d.built.roofHeight }),
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
      for (const { sourceLayer, footprint, props, built } of drawn) {
        const [ox, , oz] = localPosition(anchorOrigin, footprint.centroid);
        const lift =
          props.height -
          built.roofHeight +
          this.elevation(map, `${sourceLayer ?? ''}|${footprint.key}`, footprint.terrainPoint) -
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

  private replacedByLandmark(
    map: MlMap,
    sourceLayer: string | undefined,
    id: number | string,
  ): boolean {
    try {
      const state = map.getFeatureState({ source: this.options.source, sourceLayer, id });
      return ((state?.[FADE_STATE] as number | undefined) ?? 0) > 0;
    } catch {
      return false;
    }
  }

  /**
   * Clear a drawn roof's feature-state, only where the map still holds it. A style swap can
   * remove the source (MapLibre reports an error event per call) or replace it with an empty
   * state store, where removing a key breaks MapLibre's next render.
   */
  private unsetState(map: MlMap, d: Drawn): void {
    if (!map.getSource(this.options.source)) return;
    const feature = this.featureOf(d);
    this.safely(() => {
      if (map.getFeatureState(feature)?.[ROOF_STATE] !== undefined)
        map.removeFeatureState(feature, ROOF_STATE);
    });
  }

  private featureOf(d: Drawn): FeatureIdentifier {
    return { source: this.options.source, sourceLayer: d.sourceLayer, id: d.footprint.id };
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
