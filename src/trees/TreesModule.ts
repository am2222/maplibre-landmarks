import type { LayerModule, ModuleContext } from '../core/LayerModule';
import { farCutoffM, tileNearestM } from '../core/cutoff';
import { localPosition, originAt } from '../core/mercator';
import type { Theme } from '../core/theme';
import type { Bounds, LngLat, Origin, ViewState } from '../core/types';
import { padBounds, padMetres } from '../landmarks/discovery';
import { TileFeed } from '../core/tileFeed';
import { TreeBatches } from './batches';
import { createTreeMaterial } from './material';
import { disposePrepared, prepareModel, type PreparedModel } from './models/prepare';
import { birch, conifer, deciduous } from './models/procedural';
import type { TreeModel } from './models/types';
import { distanceFrom, kthSmallest, selectTrees, type Candidate, type PlacedTree } from './select';
import { TreeTiles } from './tileStore';

export interface TreesWind {
  strength?: number;
  /** Where the wind blows from, degrees clockwise from north. */
  directionDeg?: number;
}

export interface TreesOptions {
  source: string;
  /** Default { points: 'pois', polygons: 'landuse' }; '' means none (GeoJSON sources). */
  sourceLayers?: { points?: string; polygons?: string };
  models?: TreeModel[];
  weights?: Record<string, number>;
  maxTrees?: number;
  /** Trees appear from this zoom (default 14, with the 3D buildings). */
  minZoom?: number;
  /**
   * Scattered trees are thinned below this zoom (default 16): a quarter of them at two zooms
   * below, half at one. A fixed subset per tree, so zooming in only adds trees.
   */
  fullDensityZoom?: number;
  lodDistanceM?: number;
  /**
   * Pitched views (past 45°) draw this layer only to about three screen heights from the view
   * centre and skip tiles beyond, as Mapbox does (default true).
   */
  farCutoff?: boolean;
  /** Milliseconds a newly shown tree takes to rise from the ground (default 400; 0: no rise). */
  riseMs?: number;
  /**
   * Share of trees drawn, 0–1 (default 0.6), mapped and scattered alike: a fixed subset per
   * tree, so changing it only adds or removes trees.
   */
  density?: number;
  /** Trees per m² by landuse kind; false disables scattering. */
  scatter?: Record<string, number> | false;
  scatterSkipRatio?: number;
  wind?: TreesWind;
  theme?: Theme;
  onError?: (err: unknown, ctx: { stage: 'source' | 'model'; id?: string }) => void;
}

export interface TreeStats {
  mapped: number;
  scattered: number;
  drawn: number;
  near: number;
  far: number;
  updateMs: number;
  polygonsFilled: number;
  polygonsSkipped: number;
  /** Tile pieces scattered in the last update (cache misses). */
  piecesScattered: number;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 1));
const DEFAULT_WEIGHTS: Record<string, number> = { deciduous: 0.6, conifer: 0.2, birch: 0.2 };
const DEFAULT_SCATTER: Record<string, number> = { forest: 1 / 60, wood: 1 / 60, park: 1 / 400 };
const SOURCE_DEBOUNCE_MS = 200;

const inBounds = ([lng, lat]: LngLat, [w, s, e, n]: Bounds) =>
  lng >= w && lng <= e && lat >= s && lat <= n;

/** Distance from `center` to the nearest point of a bounding box (0 when inside it). */
const nearestDistance = (
  [w, s, e, n]: [number, number, number, number],
  [lng, lat]: LngLat,
  distance: (p: [number, number]) => number,
) => distance([Math.min(Math.max(lng, w), e), Math.min(Math.max(lat, s), n)]);

export class TreesModule implements LayerModule {
  private ctx?: ModuleContext;
  private readonly look = createTreeMaterial();
  private batches?: TreeBatches;
  private models: { model: TreeModel; prepared: PreparedModel }[] = [];
  private lastView?: ViewState;
  private anchor: LngLat = [0, 0];
  private lastDrawn: string[] = [];
  /** Trees per tile, fed by the source's tiles as they load. */
  private tiles?: TreeTiles;
  private feeds: TileFeed[] = [];
  /** Pieces scattered before this update (stats report the new ones). */
  private scatteredBefore = 0;
  private stats: TreeStats = {
    mapped: 0,
    scattered: 0,
    drawn: 0,
    near: 0,
    far: 0,
    updateMs: 0,
    polygonsFilled: 0,
    polygonsSkipped: 0,
    piecesScattered: 0,
  };
  private wind: Required<TreesWind>;
  private density: number;
  /** Far cutoff of the last update (metres from the view centre; Infinity when off). */
  private cutoff = Number.POSITIVE_INFINITY;
  private themeOption?: Theme;
  private sourceErrorReported = false;
  private disposed = false;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly opts: TreesOptions) {
    this.wind = {
      strength: opts.wind?.strength ?? 1,
      directionDeg: opts.wind?.directionDeg ?? 250,
    };
    this.themeOption = opts.theme;
    this.density = clamp01(opts.density ?? 0.6);
    this.look.setWind(this.wind.strength, this.wind.directionDeg);
    this.look.uniforms.uRise.value = Math.max(0, opts.riseMs ?? 400) / 1000;
  }

  onAdd(ctx: ModuleContext): void {
    this.ctx = ctx;
    this.disposed = false;
    // Apply the option once: on re-add, the map-wide theme (setTheme(map, …)) wins.
    if (this.themeOption) {
      ctx.core.setTheme(this.themeOption);
      this.themeOption = undefined;
    }
    this.look.setTheme(ctx.core.theme);
    this.batches = new TreeBatches(this.look.material, this.opts.maxTrees ?? 4000);
    ctx.scene.add(this.batches.group);
    this.createFeeds(ctx);
    ctx.map.on('sourcedata', this.onSourceData);
    ctx.map.on('terrain', this.onTerrain);
    void this.loadModels();
  }

  update(view: ViewState): void {
    this.lastView = view;
    const ctx = this.ctx;
    if (!ctx || !this.batches || !this.models.length) return;
    const t0 = performance.now();
    if (view.zoom < (this.opts.minZoom ?? 14)) {
      for (const feed of this.feeds) feed.suspend();
      this.write([], view);
      return;
    }
    if (!ctx.map.getSource(this.opts.source)) {
      this.reportSource(new Error(`Source "${this.opts.source}" not found`));
      for (const feed of this.feeds) feed.suspend();
      this.write([], view);
      return;
    }
    this.cutoff = this.opts.farCutoff === false ? Number.POSITIVE_INFINITY : farCutoffM(view);
    const u = this.look.uniforms;
    u.uCutoff.value = Number.isFinite(this.cutoff) ? this.cutoff : 1e9;
    u.uCutoffFade.value = Number.isFinite(this.cutoff) ? this.cutoff * 0.25 : 1;
    try {
      for (const feed of this.feeds) feed.settle();
    } catch (err) {
      this.reportSource(err);
      this.write([], view);
      return;
    }
    this.scatteredBefore = this.tiles!.piecesScattered;
    const tiles = this.tiles!.tiles();
    const zoomKeep = Math.min(
      1,
      Math.max(0.25, 2 ** (view.zoom - (this.opts.fullDensityZoom ?? 16))),
    );
    const keep = zoomKeep * this.density;
    const maxTrees = this.opts.maxTrees ?? 4000;
    const padded = padBounds(view.bounds, padMetres(view.pitch, 30));
    const distance = distanceFrom(view.center);
    const candidates: Candidate[] = [];
    const seen = new Set<string>();
    let mapped = 0;
    let scattered = 0;
    // Nearest tiles first. Only the nearest maxTrees are drawn, so once that many candidates are
    // in, a tile whose bounds lie beyond the current maxTrees-th distance cannot add a drawn tree:
    // it and every farther one are skipped (a low camera sees woods to the horizon).
    const ordered = tiles
      .map((t) => ({ t, near: nearestDistance(t.bounds, view.center, distance) }))
      .sort((a, b) => a.near - b.near);
    let cutoff = Number.POSITIVE_INFINITY;
    let cutoffAt = maxTrees;
    const far = this.cutoff;
    const add = (c: Candidate) => {
      if (seen.has(c.key)) return false; // the same tree in a parent and a child tile
      seen.add(c.key);
      if (far !== Number.POSITIVE_INFINITY && distance(c.lngLat) > far) return true;
      if (inBounds(c.lngLat, padded)) candidates.push(c);
      return true;
    };
    for (const { t, near } of ordered) {
      if (near > cutoff || near > far) break;
      for (const m of t.mapped) if (m.thin < this.density && add(m)) mapped++;
      for (const p of t.scatter()) if (p.thin < keep && add(p)) scattered++;
      // Tighten the cutoff as candidates grow (recomputed when their number doubles).
      if (candidates.length >= cutoffAt) {
        cutoff = kthSmallest(
          candidates.map((c) => distance(c.lngLat)),
          maxTrees,
        );
        cutoffAt = candidates.length * 2;
      }
    }

    const selected = selectTrees(candidates, view.center, {
      maxTrees,
      lodDistanceM: this.opts.lodDistanceM ?? 300,
      weights: this.models.map(
        ({ model }) => this.opts.weights?.[model.id] ?? DEFAULT_WEIGHTS[model.id] ?? 1,
      ),
      variants: this.models.map(({ prepared }) => prepared.variants.length),
    });
    this.lastDrawn = selected.map((t) => t.key);
    const counts = this.tiles!.pieceCounts();
    this.write(selected, view);
    this.stats = {
      ...this.stats,
      mapped,
      scattered,
      polygonsFilled: counts.filled,
      polygonsSkipped: counts.skipped,
      piecesScattered: this.tiles!.piecesScattered - this.scatteredBefore,
      updateMs: performance.now() - t0,
    };
  }

  place(origin: Origin): void {
    if (!this.batches) return;
    // Like zoom-interpolated building heights: full size one zoom after minZoom.
    const zoom = this.ctx?.map.getZoom() ?? Number.POSITIVE_INFINITY;
    const grow = Math.min(1, Math.max(0, zoom - (this.opts.minZoom ?? 14)));
    this.look.uniforms.uGrow.value = grow;
    this.batches.group.position.set(...localPosition(origin, this.anchor, 0));
    const centre = this.ctx?.map.getCenter?.();
    if (centre) {
      const [x, , z] = localPosition(originAt(this.anchor), [centre.lng, centre.lat], 0);
      this.look.uniforms.uCenter.value.set(x, z);
    }
    this.batches.group.updateMatrixWorld(true);
  }

  frame(timeMs: number): boolean {
    const t = timeMs / 1000;
    this.look.uniforms.uTime.value = t;
    if (!(this.batches?.drawn ?? 0)) return false;
    const rising = t < this.batches!.lastBorn + this.look.uniforms.uRise.value;
    return rising || this.wind.strength > 0;
  }

  themeChanged(theme: Theme): void {
    this.look.setTheme(theme);
    this.ctx?.requestRepaint();
  }

  styleChanged(attached: boolean): void {
    // A swapped style may carry other tiles: start the feeds over.
    for (const feed of this.feeds) feed.reset();
    if (attached && this.lastView) this.update(this.lastView);
  }

  onRemove(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    const ctx = this.ctx;
    ctx?.map.off('sourcedata', this.onSourceData);
    ctx?.map.off('terrain', this.onTerrain);
    for (const feed of this.feeds) feed.dispose();
    this.feeds = [];
    this.tiles = undefined;
    if (this.batches) {
      ctx?.scene.remove(this.batches.group);
      this.batches.dispose(); // disposes every prepared geometry it holds
    }
    this.look.material.dispose();
    this.models = [];
    this.batches = undefined;
    this.ctx = undefined;
  }

  setTheme(theme: Theme): void {
    // Detached: remember it for the next add. Attached: apply map-wide now (nothing to replay).
    if (this.ctx) this.ctx.core.setTheme(theme);
    else this.themeOption = theme;
  }

  /** Share of trees drawn, 0–1 (see `density`). */
  setDensity(density: number): void {
    this.density = clamp01(density);
    if (this.lastView) this.update(this.lastView);
  }

  setWind(wind: TreesWind): void {
    this.wind = { ...this.wind, ...wind };
    this.look.setWind(this.wind.strength, this.wind.directionDeg);
    this.ctx?.requestRepaint();
  }

  /** Keys of the trees drawn by the last update. */
  drawnKeys(): string[] {
    return this.lastDrawn;
  }

  getStats(): TreeStats {
    return { ...this.stats };
  }

  /** Mapped trees and green polygons, delivered tile by tile into the per-tile store. */
  private createFeeds(ctx: ModuleContext): void {
    const layers = { points: 'pois', polygons: 'landuse', ...this.opts.sourceLayers };
    const scatter = this.opts.scatter === false ? {} : (this.opts.scatter ?? DEFAULT_SCATTER);
    const tiles = (this.tiles = new TreeTiles({
      scatter,
      skipRatio: this.opts.scatterSkipRatio ?? 0.25,
    }));
    const changed = () => this.schedule();
    // Two feeds share each tile key: each one sets and drops only its own half of the tile.
    const feed = (
      sourceLayer: string,
      filter: unknown[],
      set: (k: string, f: never) => void,
      drop: (k: string) => void,
    ) =>
      new TileFeed(ctx.map, {
        source: this.opts.source,
        ...(sourceLayer ? { sourceLayer } : {}),
        filter,
        // Tiles wholly beyond the far cutoff are not read until it reaches them.
        wants: (key) =>
          key === '*' || !this.lastView || tileNearestM(key, this.lastView.center) <= this.cutoff,
        onTile: (key, features) => {
          set(key, features as never);
          changed();
        },
        onDrop: (key) => {
          drop(key);
          changed();
        },
      });
    this.feeds = [
      feed(
        layers.points,
        ['==', ['get', 'kind'], 'tree'],
        (k, f) => tiles.setPoints(k, f),
        (k) => tiles.dropPoints(k),
      ),
    ];
    const kinds = Object.keys(scatter);
    if (kinds.length)
      this.feeds.push(
        feed(
          layers.polygons,
          ['in', ['get', 'kind'], ['literal', kinds]],
          (k, f) => tiles.setPolygons(k, f),
          (k) => tiles.dropPolygons(k),
        ),
      );
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.lastView) this.update(this.lastView);
    }, SOURCE_DEBOUNCE_MS);
  }

  private async loadModels(): Promise<void> {
    const models = this.opts.models ?? [deciduous, conifer, birch];
    const results = await Promise.allSettled(models.map((m) => prepareModel(m)));
    if (this.disposed || !this.batches) {
      for (const r of results) if (r.status === 'fulfilled') disposePrepared(r.value);
      return;
    }
    this.models = [];
    results.forEach((r, i) => {
      const model = models[i]!;
      if (r.status === 'fulfilled') this.models.push({ model, prepared: r.value });
      else this.report(r.reason, { stage: 'model', id: model.id });
    });
    this.batches.setModels(this.models.map((m) => m.prepared));
    if (this.lastView) this.update(this.lastView);
  }

  private write(trees: PlacedTree[], view: ViewState): void {
    const ctx = this.ctx;
    if (!ctx || !this.batches) return;
    this.anchor = view.center;
    const elevation = ctx.map.getTerrain()
      ? (p: LngLat) => ctx.map.queryTerrainElevation(p) ?? 0
      : undefined;
    const counts = this.batches.write(trees, this.anchor, elevation);
    this.stats = { ...this.stats, ...counts };
    if (!trees.length) this.stats = { ...this.stats, mapped: 0, scattered: 0 };
    ctx.requestRepaint();
  }

  /** Terrain switched on/off or changed: re-plant at the new ground height. */
  private readonly onTerrain = (): void => {
    if (this.lastView) this.update(this.lastView);
  };

  /** Our source's tiles, or the terrain's elevation tiles, arrived: refresh (debounced). */
  private readonly onSourceData = (e: { sourceId?: string }): void => {
    const terrainSource = this.ctx?.map.getTerrain()?.source;
    const relevant =
      e.sourceId === this.opts.source || (!!terrainSource && e.sourceId === terrainSource);
    if (!relevant || !this.lastView) return;
    this.schedule();
  };

  private reportSource(err: unknown): void {
    if (this.sourceErrorReported) return;
    this.sourceErrorReported = true;
    this.report(err, { stage: 'source' });
  }

  private report(err: unknown, ctx: { stage: 'source' | 'model'; id?: string }): void {
    if (this.opts.onError) this.opts.onError(err, ctx);
    else console.warn('[maplibre-landmarks trees]', ctx, err);
  }
}
