import type { LayerModule, ModuleContext } from '../core/LayerModule';
import { localPosition } from '../core/mercator';
import type { Theme } from '../core/theme';
import type { Bounds, LngLat, Origin, ViewState } from '../core/types';
import { padBounds, padMetres } from '../landmarks/discovery';
import { TreeBatches } from './batches';
import {
  collectMapped,
  collectPolygons,
  pieceKey,
  piecesHash,
  PointIndex,
  type MappedTree,
  type PolygonGroup,
} from './collect';
import { hashString } from './hash';
import { createTreeMaterial } from './material';
import { disposePrepared, prepareModel, type PreparedModel } from './models/prepare';
import { birch, conifer, deciduous } from './models/procedural';
import type { TreeModel } from './models/types';
import { bboxOf, scatterPiece, shouldScatter, type ScatterPoint } from './scatter';
import { distanceFrom, kthSmallest, selectTrees, type Candidate, type PlacedTree } from './select';

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
  minZoom?: number;
  lodDistanceM?: number;
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

const DEFAULT_WEIGHTS: Record<string, number> = { deciduous: 0.6, conifer: 0.2, birch: 0.2 };
const DEFAULT_SCATTER: Record<string, number> = { forest: 1 / 60, wood: 1 / 60, park: 1 / 400 };
/** Cached scattered tile pieces (each ≤ one basemap tile). */
const PIECE_CACHE_LIMIT = 2048;
const SOURCE_DEBOUNCE_MS = 200;
const INSIDE_CACHE_LIMIT = 4096;

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
  private readonly pieceCache = new Map<string, ScatterPoint[]>();
  /** Mapped trees inside each polygon, by polygon, its pieces and the mapped trees. */
  private readonly insideCache = new Map<string, number>();
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
    this.look.setWind(this.wind.strength, this.wind.directionDeg);
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
    ctx.map.on('sourcedata', this.onSourceData);
    ctx.map.on('terrain', this.onTerrain);
    void this.loadModels();
  }

  update(view: ViewState): void {
    this.lastView = view;
    const ctx = this.ctx;
    if (!ctx || !this.batches || !this.models.length) return;
    const t0 = performance.now();
    if (view.zoom < (this.opts.minZoom ?? 16)) {
      this.write([], view);
      return;
    }
    if (!ctx.map.getSource(this.opts.source)) {
      this.reportSource(new Error(`Source "${this.opts.source}" not found`));
      this.write([], view);
      return;
    }
    const layers = { points: 'pois', polygons: 'landuse', ...this.opts.sourceLayers };
    const scatter = this.opts.scatter === false ? {} : (this.opts.scatter ?? DEFAULT_SCATTER);
    let mapped: MappedTree[];
    let polygons: PolygonGroup[];
    try {
      mapped = collectMapped(ctx.map, this.opts.source, layers.points);
      polygons = collectPolygons(ctx.map, this.opts.source, layers.polygons, Object.keys(scatter));
    } catch (err) {
      this.reportSource(err);
      this.write([], view);
      return;
    }

    const index = new PointIndex(mapped);
    // Counts change only when a polygon's pieces or the mapped trees change (tiles loading).
    const mappedKey = hashString(
      mapped
        .map((m) => m.key)
        .sort()
        .join(','),
    );
    if (this.insideCache.size > INSIDE_CACHE_LIMIT) this.insideCache.clear();
    const maxTrees = this.opts.maxTrees ?? 4000;
    const padded = padBounds(view.bounds, padMetres(view.pitch, 30));
    const distance = distanceFrom(view.center);
    const candidates: Candidate[] = mapped.filter((c) => inBounds(c.lngLat, padded));
    const scattered = new Map<string, ScatterPoint>();
    let filled = 0;
    let skipped = 0;
    let piecesScattered = 0;
    let usedPieces = 0;
    // Nearest polygons first. Only the nearest maxTrees are drawn, so once that many candidates
    // are in, a polygon whose bounds lie beyond the current maxTrees-th distance cannot add a
    // drawn tree: it and every farther one are skipped (a low camera sees woods to the horizon).
    const groups = polygons
      .map((g) => ({ g, near: nearestDistance(bboxOf(g.pieces), view.center, distance) }))
      .sort((a, b) => a.near - b.near);
    let cutoff = Number.POSITIVE_INFINITY;
    let cutoffAt = maxTrees;
    for (const { g, near } of groups) {
      if (near > cutoff) break;
      const density = scatter[g.kind]!;
      const insideKey = `${g.id}|${piecesHash(g.pieces)}|${mappedKey}`;
      let inside = this.insideCache.get(insideKey);
      if (inside === undefined) {
        inside = index.countInside(g.pieces);
        this.insideCache.set(insideKey, inside);
      }
      const fill = shouldScatter(g.pieces, density, inside, this.opts.scatterSkipRatio ?? 0.25);
      let added = 0;
      if (fill) {
        // Cache per tile piece: a newly loaded tile only scatters its own piece.
        for (const piece of g.pieces) {
          const key = `${g.kind}|${density}|${pieceKey(piece)}`;
          let points = this.pieceCache.get(key);
          if (!points) {
            points = scatterPiece(g.kind, piece, density);
            piecesScattered++;
          }
          this.pieceCache.delete(key); // LRU: re-insert as most recent
          this.pieceCache.set(key, points);
          usedPieces++;
          for (const p of points) {
            if (scattered.has(p.key)) continue;
            scattered.set(p.key, p);
            added++;
            if (inBounds(p.lngLat, padded)) candidates.push(p);
          }
        }
      }
      if (added) filled++;
      else skipped++;
      // Tighten the cutoff as candidates grow (recomputed when their number doubles).
      if (candidates.length >= cutoffAt) {
        cutoff = kthSmallest(
          candidates.map((c) => distance(c.lngLat)),
          maxTrees,
        );
        cutoffAt = candidates.length * 2;
      }
    }
    // Evict after the loop so pieces in use this update are never thrown out mid-way.
    const limit = Math.max(PIECE_CACHE_LIMIT, usedPieces);
    for (const key of this.pieceCache.keys()) {
      if (this.pieceCache.size <= limit) break;
      this.pieceCache.delete(key);
    }

    const selected = selectTrees(candidates, view.center, {
      maxTrees,
      lodDistanceM: this.opts.lodDistanceM ?? 300,
      weights: this.models.map(
        ({ model }) => this.opts.weights?.[model.id] ?? DEFAULT_WEIGHTS[model.id] ?? 1,
      ),
      variants: this.models.map(({ prepared }) => prepared.variants.length),
    });
    this.write(selected, view);
    this.stats = {
      ...this.stats,
      mapped: mapped.length,
      scattered: scattered.size,
      polygonsFilled: filled,
      polygonsSkipped: skipped,
      piecesScattered,
      updateMs: performance.now() - t0,
    };
  }

  place(origin: Origin): void {
    if (!this.batches) return;
    this.batches.group.position.set(...localPosition(origin, this.anchor, 0));
    this.batches.group.updateMatrixWorld(true);
  }

  frame(timeMs: number): boolean {
    this.look.uniforms.uTime.value = timeMs / 1000;
    return this.wind.strength > 0 && (this.batches?.drawn ?? 0) > 0;
  }

  themeChanged(theme: Theme): void {
    this.look.setTheme(theme);
    this.ctx?.requestRepaint();
  }

  styleChanged(attached: boolean): void {
    if (attached && this.lastView) this.update(this.lastView);
  }

  onRemove(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    const ctx = this.ctx;
    ctx?.map.off('sourcedata', this.onSourceData);
    ctx?.map.off('terrain', this.onTerrain);
    if (this.batches) {
      ctx?.scene.remove(this.batches.group);
      this.batches.dispose(); // disposes every prepared geometry it holds
    }
    this.look.material.dispose();
    this.models = [];
    this.pieceCache.clear();
    this.batches = undefined;
    this.ctx = undefined;
  }

  setTheme(theme: Theme): void {
    // Detached: remember it for the next add. Attached: apply map-wide now (nothing to replay).
    if (this.ctx) this.ctx.core.setTheme(theme);
    else this.themeOption = theme;
  }

  setWind(wind: TreesWind): void {
    this.wind = { ...this.wind, ...wind };
    this.look.setWind(this.wind.strength, this.wind.directionDeg);
    this.ctx?.requestRepaint();
  }

  getStats(): TreeStats {
    return { ...this.stats };
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
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.lastView) this.update(this.lastView);
    }, SOURCE_DEBOUNCE_MS);
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
