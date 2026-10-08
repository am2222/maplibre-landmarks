import type { LayerModule, ModuleContext } from '../core/LayerModule';
import { localPosition } from '../core/mercator';
import type { Theme } from '../core/theme';
import type { Bounds, LngLat, Origin, ViewState } from '../core/types';
import { padBounds, padMetres } from '../landmarks/discovery';
import { TreeBatches } from './batches';
import {
  collectMapped,
  collectPolygons,
  piecesHash,
  PointIndex,
  type MappedTree,
  type PolygonGroup,
} from './collect';
import { createTreeMaterial } from './material';
import { disposePrepared, prepareModel, type PreparedModel } from './models/prepare';
import { birch, conifer, deciduous } from './models/procedural';
import type { TreeModel } from './models/types';
import { scatterPolygon, shouldScatter, type ScatterPoint } from './scatter';
import { selectTrees, type PlacedTree } from './select';

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
}

const DEFAULT_WEIGHTS: Record<string, number> = { deciduous: 0.6, conifer: 0.2, birch: 0.2 };
const DEFAULT_SCATTER: Record<string, number> = { forest: 1 / 60, wood: 1 / 60, park: 1 / 400 };
const SCATTER_CACHE_LIMIT = 512;
const SOURCE_DEBOUNCE_MS = 200;

const inBounds = ([lng, lat]: LngLat, [w, s, e, n]: Bounds) =>
  lng >= w && lng <= e && lat >= s && lat <= n;

export class TreesModule implements LayerModule {
  private ctx?: ModuleContext;
  private readonly look = createTreeMaterial();
  private batches?: TreeBatches;
  private models: { model: TreeModel; prepared: PreparedModel }[] = [];
  private lastView?: ViewState;
  private anchor: LngLat = [0, 0];
  private readonly scatterCache = new Map<string, { hash: string; points: ScatterPoint[] }>();
  private stats: TreeStats = {
    mapped: 0,
    scattered: 0,
    drawn: 0,
    near: 0,
    far: 0,
    updateMs: 0,
    polygonsFilled: 0,
    polygonsSkipped: 0,
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
    if (this.themeOption) ctx.core.setTheme(this.themeOption);
    this.look.setTheme(ctx.core.theme);
    this.batches = new TreeBatches(this.look.material, this.opts.maxTrees ?? 4000);
    ctx.scene.add(this.batches.group);
    ctx.map.on('sourcedata', this.onSourceData);
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
    const scattered = new Map<string, ScatterPoint>();
    let filled = 0;
    let skipped = 0;
    for (const g of polygons) {
      const density = scatter[g.kind]!;
      const inside = index.countInside(g.pieces);
      const hash = `${piecesHash(g.pieces)}|${inside}`;
      let hit = this.scatterCache.get(g.id);
      if (!hit || hit.hash !== hash) {
        const fill = shouldScatter(g.pieces, density, inside, this.opts.scatterSkipRatio ?? 0.25);
        hit = { hash, points: fill ? scatterPolygon(g.kind, g.pieces, density) : [] };
      }
      this.scatterCache.delete(g.id); // LRU: re-insert as most recent
      this.scatterCache.set(g.id, hit);
      if (this.scatterCache.size > SCATTER_CACHE_LIMIT) {
        this.scatterCache.delete(this.scatterCache.keys().next().value as string);
      }
      if (hit.points.length) filled++;
      else skipped++;
      for (const p of hit.points) scattered.set(p.key, p);
    }

    const padded = padBounds(view.bounds, padMetres(view.pitch, 30));
    const candidates = [...mapped, ...scattered.values()].filter((c) => inBounds(c.lngLat, padded));
    const selected = selectTrees(candidates, view.center, {
      maxTrees: this.opts.maxTrees ?? 4000,
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
    if (this.batches) {
      ctx?.scene.remove(this.batches.group);
      this.batches.dispose(); // disposes every prepared geometry it holds
    }
    this.look.material.dispose();
    this.models = [];
    this.scatterCache.clear();
    this.batches = undefined;
    this.ctx = undefined;
  }

  setTheme(theme: Theme): void {
    this.themeOption = theme;
    this.ctx?.core.setTheme(theme);
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

  private readonly onSourceData = (e: { sourceId?: string }): void => {
    if (e.sourceId !== this.opts.source || !this.lastView) return;
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
