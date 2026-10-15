import {
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Mesh,
  MeshStandardMaterial,
} from 'three';
import { farCutoffM, tileNearestM } from '../core/cutoff';
import type { LayerModule, ModuleContext } from '../core/LayerModule';
import { lngLatAt, localPosition, originAt } from '../core/mercator';
import { tileBounds, TileFeed, type FeedFeature, type FeedMap } from '../core/tileFeed';
import type { LngLat, Origin, ViewState } from '../core/types';
import type { RoofMesh } from '../roofs/geometry/mesh';
import { buildRaised, rampFor, type XZ } from './geometry';
import { chainSpans, withApproaches, type Raised } from './network';
import { partsOf, readPiece, type SegmentPiece, type Span } from './segments';

export interface RoadsOptions {
  /** Vector source with Overture's `transportation` schema. */
  source: string;
  /** Source layer of the road and rail segments (default 'segment'). */
  sourceLayer?: string;
  /** Source layer of the segments' connectors, which place bridges along them (default 'connector'). */
  connectorLayer?: string;
  /** Raised roads appear from this zoom (default 15). */
  minZoom?: number;
  /** Nearest bridges (with their approaches) drawn at most (default 400). */
  maxBridges?: number;
  /** Pitched views draw bridges only to about three screen heights away (default true). */
  farCutoff?: boolean;
  /** Railway bridges too (default true). */
  rail?: boolean;
  /**
   * The app's flat bridge layers (e.g. Protomaps' `roads_bridges_*`): hidden while this layer is
   * on, so the decks do not float over a road painted on the river.
   */
  replaceLayers?: string[];
  onError?: (err: unknown) => void;
}

export interface RoadsStats {
  bridges: number;
  /** Bridge ends that ramp down along the road beyond them (the rest ramp on the bridge). */
  approaches: number;
  triangles: number;
  /** Highest deck drawn, metres above the ground. */
  highest: number;
}

const REBUILD_DEBOUNCE_MS = 150;
const M_PER_DEG = 111_320;

interface Built {
  raised: Raised;
  /** Mesh around the chain's first vertex (`origin`), heights above sea level. */
  mesh: RoofMesh;
  top: number;
}

/**
 * Roads and railways off the ground, from Overture's transportation theme: bridges as decks on
 * piers, and the roads leading onto them ramping up as embankments, so overpasses rise from the
 * street instead of within their own length. Roads on the ground stay with the basemap.
 */
export class RoadsModule implements LayerModule {
  private ctx?: ModuleContext;
  private mesh?: Mesh<BufferGeometry, MeshStandardMaterial>;
  private feed?: TileFeed;
  private connectorFeed?: TileFeed;
  /** Each held tile's road and rail pieces. */
  private readonly tiles = new Map<string, SegmentPiece[]>();
  /** Each held tile's connectors, by id. */
  private readonly connectorTiles = new Map<string, Map<string, LngLat>>();
  private raised?: Raised[];
  /** Built structures by key, kept while they and the ground are unchanged. */
  private built = new Map<string, Built>();
  private drawn: Raised[] = [];
  private anchor: LngLat = [0, 0];
  private view?: ViewState;
  private timer?: ReturnType<typeof setTimeout>;
  private stats: RoadsStats = { bridges: 0, approaches: 0, triangles: 0, highest: 0 };
  /** Visibility of the replaced layers before we hid them. */
  private readonly hidden = new Map<string, unknown>();
  private reported = false;
  private slicedReported = false;

  constructor(private readonly options: RoadsOptions) {}

  onAdd(ctx: ModuleContext): void {
    this.ctx = ctx;
    this.mesh = new Mesh(
      new BufferGeometry(),
      new MeshStandardMaterial({ vertexColors: true, side: DoubleSide, roughness: 0.85 }),
    );
    this.mesh.name = 'raised-roads';
    this.mesh.frustumCulled = false;
    ctx.scene.add(this.mesh);
    ctx.map.on('terrain', this.onTerrain);
    ctx.map.on('sourcedata', this.onSourceData);
    this.hideReplaced();
  }

  update(view: ViewState): void {
    this.view = view;
    this.rebuild();
  }

  place(origin: Origin): void {
    if (!this.mesh) return;
    this.mesh.position.set(...localPosition(origin, this.anchor, 0));
    this.mesh.updateMatrixWorld();
  }

  styleChanged(attached: boolean): void {
    this.feed?.reset();
    this.connectorFeed?.reset();
    this.hidden.clear();
    if (attached) {
      this.hideReplaced();
      this.rebuild();
    }
  }

  getStats(): RoadsStats {
    return { ...this.stats };
  }

  onRemove(): void {
    clearTimeout(this.timer);
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.map.off('terrain', this.onTerrain);
    ctx.map.off('sourcedata', this.onSourceData);
    this.feed?.dispose();
    this.feed = undefined;
    this.connectorFeed?.dispose();
    this.connectorFeed = undefined;
    this.restoreReplaced();
    if (this.mesh) {
      ctx.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
    }
    this.mesh = undefined;
    this.ctx = undefined;
  }

  private readonly schedule = (): void => {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.rebuild(), REBUILD_DEBOUNCE_MS);
  };

  /** New ground: the abutments and piers stand elsewhere. */
  private readonly onTerrain = (): void => {
    this.built.clear();
    this.drawn = [];
    this.schedule();
  };

  private readonly onSourceData = (e: { sourceId?: string; sourceDataType?: string }): void => {
    const terrain = this.ctx?.map.getTerrain()?.source;
    if (terrain && e.sourceId === terrain && e.sourceDataType !== 'metadata') this.onTerrain();
  };

  private hideReplaced(): void {
    const map = this.ctx?.map;
    if (!map) return;
    for (const id of this.options.replaceLayers ?? []) {
      if (this.hidden.has(id) || !map.getLayer(id)) continue;
      this.hidden.set(id, map.getLayoutProperty(id, 'visibility'));
      map.setLayoutProperty(id, 'visibility', 'none');
    }
  }

  private restoreReplaced(): void {
    const map = this.ctx?.map;
    for (const [id, visibility] of this.hidden)
      if (map?.getLayer(id))
        map.setLayoutProperty(id, 'visibility', (visibility ?? 'visible') as 'visible');
    this.hidden.clear();
  }

  private report(err: Error): void {
    if (this.reported) return;
    this.reported = true;
    if (this.options.onError) this.options.onError(err);
    else console.warn('[maplibre-landmarks] roads', err);
  }

  private rebuild(): void {
    const ctx = this.ctx;
    const view = this.view;
    if (!ctx || !view) return;
    const source = ctx.map.getSource(this.options.source);
    if (!source) this.report(new Error(`source "${this.options.source}" not found`));
    if (!source || view.zoom < (this.options.minZoom ?? 15)) {
      this.feed?.suspend();
      this.connectorFeed?.suspend();
      this.draw(view, []);
      return;
    }
    this.connectorFeedFor(ctx).settle();
    this.feedFor(ctx).settle();
    this.raised ??= this.raisedOfTiles();
    const cutoff = this.options.farCutoff === false ? Infinity : farCutoffM(view);
    const k = M_PER_DEG * Math.cos((view.center[1] * Math.PI) / 180);
    const distance = (c: Raised) =>
      Math.min(
        ...c.coords.map(([lng, lat]) =>
          Math.hypot((lng - view.center[0]) * k, (lat - view.center[1]) * M_PER_DEG),
        ),
      );
    const chosen = this.raised
      .map((c) => ({ c, d: distance(c) }))
      .filter(({ d }) => d <= cutoff)
      .sort((a, b) => a.d - b.d)
      .slice(0, this.options.maxBridges ?? 400)
      .map(({ c }) => c);
    this.draw(view, chosen);
  }

  /**
   * The raised roads of the held tiles: each segment's pieces together, split into bridges and
   * ground; bridges joined end to end, then given the ground roads that lead onto them.
   */
  private raisedOfTiles(): Raised[] {
    const bySegment = new Map<string, SegmentPiece[]>();
    for (const pieces of this.tiles.values())
      for (const p of pieces) bySegment.set(p.id, [...(bySegment.get(p.id) ?? []), p]);
    const connectors = new Map<string, LngLat>();
    for (const tile of this.connectorTiles.values())
      for (const [id, p] of tile) connectors.set(id, p);
    const bridges: Span[] = [];
    const ground: Span[] = [];
    for (const pieces of bySegment.values()) {
      try {
        const parts = partsOf(pieces, (id) => connectors.get(id));
        bridges.push(...parts.bridges);
        ground.push(...parts.ground);
      } catch (err) {
        this.report(err instanceof Error ? err : new Error(String(err)));
      }
    }
    return withApproaches(chainSpans(bridges), ground, rampFor);
  }

  private feedFor(ctx: ModuleContext): TileFeed {
    const kinds = this.options.rail === false ? ['road'] : ['road', 'rail'];
    this.feed ??= new TileFeed(ctx.map as unknown as FeedMap, {
      source: this.options.source,
      sourceLayer: this.options.sourceLayer ?? 'segment',
      // All of them: bridges, and the roads that lead onto them.
      filter: ['in', ['get', 'subtype'], ['literal', kinds]],
      wants: (key) =>
        key === '*' ||
        !this.view ||
        this.options.farCutoff === false ||
        tileNearestM(key, this.view.center) <= farCutoffM(this.view),
      onTile: (key, features) => {
        this.noteSliced(ctx, key);
        this.tiles.set(key, this.read(key, features));
        this.raised = undefined;
        this.schedule();
      },
      onDrop: (key) => {
        if (this.tiles.delete(key)) this.raised = undefined;
        this.schedule();
      },
    });
    return this.feed;
  }

  /**
   * MapLibre 6 slices a source's tiles over the first zooms past its last one
   * (`zoomLevelsToOverscale`, 4 by default): segments come in short pieces, and bridges on long
   * ones are placed only where their connectors are in view. Say so once.
   */
  private noteSliced(ctx: ModuleContext, key: string): void {
    if (this.slicedReported) return;
    const maxzoom = (ctx.map.getSource(this.options.source) as { maxzoom?: number } | undefined)
      ?.maxzoom;
    const z = Number(key.split('/')[0]);
    if (maxzoom === undefined || !(z > maxzoom)) return;
    this.slicedReported = true;
    const err = new Error(
      `source "${this.options.source}" tiles are sliced past zoom ${maxzoom}: some bridges on long ` +
        'segments are left out. Create the map with a high `zoomLevelsToOverscale` (e.g. 30) to ' +
        'overscale them whole.',
    );
    if (this.options.onError) this.options.onError(err);
    else console.warn('[maplibre-landmarks] roads', err);
  }

  /** The connectors: where each sits, to place bridges along segments only partly held. */
  private connectorFeedFor(ctx: ModuleContext): TileFeed {
    this.connectorFeed ??= new TileFeed(ctx.map as unknown as FeedMap, {
      source: this.options.source,
      sourceLayer: this.options.connectorLayer ?? 'connector',
      wants: (key) =>
        key === '*' ||
        !this.view ||
        this.options.farCutoff === false ||
        tileNearestM(key, this.view.center) <= farCutoffM(this.view),
      onTile: (key, features) => {
        const points = new Map<string, LngLat>();
        for (const f of features) {
          const id = f.properties?.id;
          if (f.geometry.type === 'Point' && id !== undefined && id !== null)
            points.set(String(id), f.geometry.coordinates as LngLat);
        }
        this.connectorTiles.set(key, points);
        this.raised = undefined;
        this.schedule();
      },
      onDrop: (key) => {
        if (this.connectorTiles.delete(key)) this.raised = undefined;
        this.schedule();
      },
    });
    return this.connectorFeed;
  }

  private read(key: string, features: FeedFeature[]): SegmentPiece[] {
    const tile = tileBounds(key);
    const pieces: SegmentPiece[] = [];
    features.forEach((f, i) => {
      const lines =
        f.geometry.type === 'LineString'
          ? [f.geometry.coordinates as LngLat[]]
          : f.geometry.type === 'MultiLineString'
            ? (f.geometry.coordinates as LngLat[][])
            : [];
      for (const coords of lines) {
        const piece = readPiece(f.properties ?? {}, coords, tile, String(f.id ?? `${key}#${i}`));
        if (piece) pieces.push(piece);
      }
    });
    return pieces;
  }

  /** The chosen structures in one mesh around the view centre (rebuilt only when they change). */
  private draw(view: ViewState, chosen: Raised[]): void {
    const ctx = this.ctx;
    if (!ctx || !this.mesh) return;
    // The same objects: unchanged (new tiles make new ones, even for the same bridge).
    if (chosen.length === this.drawn.length && chosen.every((r, i) => r === this.drawn[i])) return;
    this.drawn = chosen;
    const ground = (p: LngLat) =>
      ctx.map.getTerrain() ? (ctx.map.queryTerrainElevation(p) ?? 0) : 0;
    const built = new Map<string, Built>();
    for (const raised of chosen) {
      let b = this.built.get(raised.key);
      if (!b || b.raised !== raised) b = this.build(raised, ground);
      built.set(raised.key, b);
    }
    this.built = built;
    this.anchor = view.center;
    const anchorOrigin = originAt(this.anchor);
    const positions: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];
    let highest = 0;
    for (const b of built.values()) {
      const [ox, , oz] = localPosition(anchorOrigin, b.raised.coords[0]!);
      const p = b.mesh.positions;
      for (let i = 0; i < p.length; i += 3) positions.push(p[i]! + ox, p[i + 1]!, p[i + 2]! + oz);
      normals.push(...b.mesh.normals);
      colors.push(...b.mesh.colors);
      highest = Math.max(highest, b.top);
    }
    const geometry = this.mesh.geometry;
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
    geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
    geometry.computeBoundingSphere();
    const approaches = chosen.reduce((n, r) => n + r.approaches.filter((a) => a > 0).length, 0);
    this.stats = { bridges: built.size, approaches, triangles: positions.length / 9, highest };
    ctx.requestRepaint();
  }

  private build(raised: Raised, ground: (p: LngLat) => number): Built {
    const origin = originAt(raised.coords[0]!);
    const local = (p: LngLat): XZ => {
      const [x, , z] = localPosition(origin, p);
      return [x, z];
    };
    const { mesh, top } = buildRaised({
      points: raised.coords.map(local),
      widths: raised.widths,
      level: raised.level,
      kind: raised.kind,
      cls: raised.cls,
      approaches: raised.approaches,
      ground: ([x, z]) => ground(lngLatAt(origin, x, z)),
    });
    return { raised, mesh, top };
  }
}
