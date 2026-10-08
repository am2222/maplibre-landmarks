import type { Object3D } from 'three';
import type { LayerModule, ModuleContext } from '../core/LayerModule';
import type { Theme } from '../core/theme';
import { localPosition } from '../core/mercator';
import type { LngLat, Origin, ViewState } from '../core/types';
import { AttributionSource, attributionText } from './attribution';
import {
  DEFAULT_BASE_URL,
  globalFetch,
  resolveCatalogue,
  type Catalogue,
  type Channel,
  type Fetch,
  type LandmarkEntry,
  type Lod,
} from './catalogue';
import { CellIndex, cellsForView, selectWanted } from './discovery';
import { prepareFade, setModelOpacity, setRenderOrder, Tweens } from './fade';
import { Grounding } from './grounding';
import { fetchGlb, GlbParser, isAbort, ModelCache, type DecoderOptions } from './loader';
import { notifyExemptionsChanged, setExemptionSource } from '../labels/exemptions';
import { BuildingReplacement, footprintOf } from './replacement';
import { Residency, type LoadFn, type ModelStore, type ResidentModel } from './residency';

export const DISCOVERY_MIN_ZOOM = 14;
const TERRAIN_DEBOUNCE_MS = 150;

export interface ErrorContext {
  stage: 'catalogue' | 'cell' | 'model';
  id?: string;
}

export interface LandmarkInfo {
  id: string;
  revision: string;
  name?: string;
  anchor: LngLat;
  lod: Lod;
  attribution: string;
}

export interface LandmarksOptions extends DecoderOptions {
  channel?: Channel;
  catalogueUrl?: string;
  baseUrl?: string;
  replaceBuildings?: string[];
  replacementInsetM?: number;
  maxResident?: number;
  maxCached?: number;
  maxCacheBytes?: number;
  theme?: Theme;
  /** Duration of model fades and building hand-overs; 0 swaps instantly. */
  fadeMs?: number;
  fetch?: Fetch;
  onError?: (err: unknown, ctx: ErrorContext) => void;
  onModelsChanged?: (visible: LandmarkInfo[]) => void;
}

export class LandmarksModule implements LayerModule {
  private ctx?: ModuleContext;
  private catalogue?: Promise<Catalogue | null>;
  private resolved: Catalogue | null = null;
  private index?: CellIndex;
  private replacement?: BuildingReplacement;
  private attribution?: AttributionSource;
  private readonly cache: ModelCache;
  private readonly residency: Residency;
  /** Models in the scene (visible or fading), with the residency key they belong to. */
  private readonly placed = new Map<Object3D, { key: string; entry: LandmarkEntry }>();
  /** Resident models whose shaders are compiling; they join the scene when ready. */
  private readonly warming = new Set<Object3D>();
  /** Models residency released while still on screen; cached once their fade-out ends. */
  private readonly leaving = new Map<string, { object: Object3D; bytes: number }>();
  /** Landmarks whose basemap buildings are being handed over (fade per residency key). */
  private readonly replacing = new Map<string, LandmarkEntry>();
  /** Keys of `replacing` last reported to label occlusion. */
  private exemptKey = '';
  private readonly modelFade: Tweens<Object3D>;
  private readonly buildingFade: Tweens<string>;
  /** Ground elevation per placed model, cached until the terrain or its tiles change. */
  private readonly elevations = new Map<Object3D, number>();
  private terrainTimer?: ReturnType<typeof setTimeout>;
  /** Per-model footing fit to sloping terrain; kept with the model across cache round-trips. */
  private readonly groundings = new WeakMap<Object3D, Grounding>();
  private parser?: GlbParser;
  private readonly fetchFn: Fetch;
  private readonly baseUrl: string;
  private themeOption?: Theme;
  private run = 0;

  constructor(
    private readonly id: string,
    private readonly opts: LandmarksOptions = {},
    load?: LoadFn,
  ) {
    this.fetchFn = opts.fetch ?? globalFetch;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.themeOption = opts.theme;
    this.cache = new ModelCache(opts.maxCached ?? 12, opts.maxCacheBytes ?? 32 * 1024 * 1024);
    this.modelFade = new Tweens(opts.fadeMs ?? 400);
    this.buildingFade = new Tweens(opts.fadeMs ?? 400);
    const store: ModelStore = {
      take: (key) => this.reclaim(key) ?? this.cache.take(key),
      put: (key, object, bytes) => this.release(key, object, bytes),
      dispose: (object) => this.cache.dispose(object),
    };
    const defaultLoad: LoadFn = async (entry, lod, signal) => {
      const buffer = await fetchGlb(entry.lods[lod], this.baseUrl, this.fetchFn, signal);
      this.parser ??= new GlbParser(opts);
      return { object: await this.parser.parse(buffer), bytes: buffer.byteLength };
    };
    this.residency = new Residency({
      load: load ?? defaultLoad,
      cache: store,
      onChange: () => this.modelsChanged(),
      onError: (err, entry) => this.report(err, { stage: 'model', id: entry.id }),
    });
  }

  onAdd(ctx: ModuleContext): void {
    this.ctx = ctx;
    if (this.themeOption) ctx.core.setTheme(this.themeOption);
    this.parser = new GlbParser(this.opts, ctx.core.renderer);
    ctx.map.on('terrain', this.onTerrain);
    ctx.map.on('sourcedata', this.onTerrainData);
    this.replacement = new BuildingReplacement(
      ctx.map,
      this.opts.replaceBuildings ?? [],
      this.opts.replacementInsetM ?? 1.5,
    );
    this.attribution = new AttributionSource(ctx.map, `${this.id}-attribution`);
    setExemptionSource(ctx.map, this.id, () =>
      [...this.replacing.values()].flatMap((entry) => footprintOf(entry, 0)),
    );
  }

  update(view: ViewState): void {
    const run = ++this.run;
    if (view.zoom < DISCOVERY_MIN_ZOOM) {
      this.residency.setWanted([]);
      return;
    }
    void this.discover(view, run);
  }

  place(origin: Origin): void {
    for (const [object, { entry }] of this.placed) {
      const [x, y, z] = localPosition(origin, entry.anchor, this.elevationOf(object, entry));
      object.position.set(x, y, z);
      object.updateMatrixWorld();
    }
  }

  onRemove(): void {
    this.run++;
    clearTimeout(this.terrainTimer);
    this.ctx?.map.off('terrain', this.onTerrain);
    this.ctx?.map.off('sourcedata', this.onTerrainData);
    this.elevations.clear();
    this.parser?.dispose();
    this.parser = undefined;
    for (const object of this.placed.keys()) this.ctx?.scene.remove(object);
    this.placed.clear();
    this.warming.clear();
    for (const [key, { object, bytes }] of this.leaving) this.cache.put(key, object, bytes);
    this.leaving.clear();
    this.modelFade.clear();
    this.buildingFade.clear();
    this.replacing.clear();
    this.residency.clear();
    this.cache.clear();
    this.replacement?.restore();
    this.attribution?.remove();
    if (this.ctx) setExemptionSource(this.ctx.map, this.id, null);
    this.exemptKey = '';
    this.ctx = undefined;
  }

  styleChanged(attached: boolean): void {
    this.elevations.clear();
    this.replacement?.reset();
    this.attribution?.reset();
    if (attached) this.syncStyle();
  }

  setTheme(theme: Theme): void {
    this.themeOption = theme;
    this.ctx?.core.setTheme(theme);
  }

  getVisibleModels(): LandmarkInfo[] {
    const fallback = this.resolved?.attribution ?? '';
    return this.residency.models().map(({ entry, lod }) => ({
      id: entry.id,
      revision: entry.revision,
      name: entry.name,
      anchor: entry.anchor,
      lod,
      attribution: entry.attribution ?? fallback,
    }));
  }

  getAttribution(): string {
    return attributionText(this.getVisibleModels(), this.resolved?.attribution);
  }

  private getCatalogue(): Promise<Catalogue | null> {
    if (!this.catalogue) {
      const p = resolveCatalogue({
        baseUrl: this.baseUrl,
        channel: this.opts.channel,
        catalogueUrl: this.opts.catalogueUrl,
        fetch: this.fetchFn,
      });
      this.catalogue = p;
      p.then(
        (cat) => (this.resolved = cat),
        () => {
          if (this.catalogue === p) this.catalogue = undefined;
        },
      );
    }
    return this.catalogue;
  }

  private async discover(view: ViewState, run: number): Promise<void> {
    let stage: ErrorContext['stage'] = 'catalogue';
    try {
      const cat = await this.getCatalogue();
      if (!cat || run !== this.run) return;
      stage = 'cell';
      this.index ??= new CellIndex(cat, this.fetchFn);
      const entries = await this.index.entries(cellsForView(view, cat));
      if (run !== this.run) return;
      const floor = this.replacement?.extrusionMinZoom() ?? 0;
      this.residency.setWanted(selectWanted(entries, view, cat, this.opts.maxResident ?? 8, floor));
    } catch (err) {
      if (!isAbort(err)) this.report(err, { stage });
    }
  }

  /** Advance fades; true while anything is still animating. */
  frame(timeMs: number): boolean {
    if (!this.modelFade.active() && !this.buildingFade.active()) return false;
    this.modelFade.step(timeMs);
    this.buildingFade.step(timeMs);
    this.applyFades();
    // A finished fade can start another (a model leaving hands its building back).
    return this.modelFade.active() || this.buildingFade.active();
  }

  private modelsChanged(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const models = this.residency.models();
    for (const m of models) {
      if (this.placed.has(m.object))
        this.modelFade.to(m.object, 1); // reclaimed mid fade-out
      else if (!this.warming.has(m.object)) this.warmUp(m);
    }
    this.retireStale();
    this.syncBuildings();
    this.syncStyle();
    this.opts.onModelsChanged?.(this.getVisibleModels());
    ctx.requestRepaint();
  }

  /** Compile a new model's shaders off-screen, then fade it in. */
  private warmUp(m: ResidentModel): void {
    const ctx = this.ctx!;
    prepareFade(m.object);
    this.warming.add(m.object);
    void ctx.core.warmUp(m.object, ctx.scene).then(() => {
      if (this.ctx !== ctx || !this.warming.delete(m.object)) return;
      if (!this.isResident(m.object)) return; // released while compiling: already cached
      this.modelFade.set(m.object, 0);
      setModelOpacity(m.object, 0);
      setRenderOrder(m.object, 1); // over the LOD it replaces
      ctx.scene.add(m.object);
      this.placed.set(m.object, { key: m.key, entry: m.entry });
      this.modelFade.to(m.object, 1, () => {
        setRenderOrder(m.object, 0);
        this.retireStale();
      });
      this.syncBuildings();
      this.applyFades();
      ctx.requestRepaint();
    });
  }

  /**
   * Fade out placed models that are no longer resident. One being replaced by another LOD
   * stays fully visible underneath until the newcomer has faded in, so nothing shows through.
   */
  private retireStale(): void {
    for (const [object, { key }] of [...this.placed]) {
      if (this.isResident(object)) continue;
      const successor = this.residency.models().find((m) => m.key === key);
      if (successor && (this.warming.has(successor.object) || this.isFading(successor.object))) {
        continue;
      }
      if (successor) this.remove(object);
      else this.modelFade.to(object, 0, () => this.remove(object));
    }
  }

  /** Buildings hand over once a landmark's first model shows, and come back when it leaves. */
  private syncBuildings(): void {
    const shown = new Map<string, LandmarkEntry>();
    for (const { key, entry } of this.placed.values()) {
      if (this.objectFor(key)) shown.set(key, entry);
    }
    for (const [key, entry] of shown) {
      this.replacing.set(key, entry);
      this.buildingFade.to(key, 1);
    }
    for (const key of this.replacing.keys()) {
      if (shown.has(key)) continue;
      this.buildingFade.to(key, 0, () => {
        this.replacing.delete(key);
        this.buildingFade.delete(key);
        this.applyFades();
      });
    }
  }

  private applyFades(): void {
    for (const object of this.placed.keys()) setModelOpacity(object, this.modelFade.value(object));
    this.replacement?.update(
      [...this.replacing].map(([key, entry]) => ({ entry, fade: this.buildingFade.value(key) })),
    );
    const exemptKey = [...this.replacing.keys()].sort().join('|');
    if (exemptKey !== this.exemptKey && this.ctx) {
      this.exemptKey = exemptKey;
      notifyExemptionsChanged(this.ctx.map);
    }
  }

  private remove(object: Object3D): void {
    this.ctx?.scene.remove(object);
    this.placed.delete(object);
    this.elevations.delete(object);
    this.modelFade.delete(object);
    setModelOpacity(object, 1);
    setRenderOrder(object, 0);
    for (const [key, l] of this.leaving) {
      if (l.object !== object) continue;
      this.leaving.delete(key);
      this.cache.put(key, l.object, l.bytes);
    }
    this.syncBuildings();
  }

  /** Residency let go of a model: keep it out of the cache while it is still fading out. */
  private release(key: string, object: Object3D, bytes: number): void {
    if (this.placed.has(object)) this.leaving.set(key, { object, bytes });
    else this.cache.put(key, object, bytes);
  }

  /** Residency wants a model back: one still fading out is reused as-is. */
  private reclaim(key: string): { object: Object3D; bytes: number } | undefined {
    const l = this.leaving.get(key);
    if (l) this.leaving.delete(key);
    return l;
  }

  private isResident(object: Object3D | undefined): boolean {
    return !!object && this.residency.models().some((m) => m.object === object);
  }

  private isFading(object: Object3D): boolean {
    const target = this.modelFade.target(object);
    return target !== undefined && this.modelFade.value(object) !== target;
  }

  private objectFor(key: string): Object3D | undefined {
    return this.residency.models().find((m) => m.key === key)?.object;
  }

  private elevationOf(object: Object3D, entry: LandmarkEntry): number {
    let elevation = this.elevations.get(object);
    if (elevation === undefined) {
      const map = this.ctx?.map;
      const terrain = !!map?.getTerrain();
      elevation = terrain ? (map!.queryTerrainElevation(entry.anchor) ?? 0) : 0;
      this.elevations.set(object, elevation);
      // Refit the footing whenever the elevation is (re)computed: same triggers, same cost.
      let grounding = this.groundings.get(object);
      if (!grounding && terrain) {
        grounding = new Grounding(object, entry.anchor);
        this.groundings.set(object, grounding);
      }
      grounding?.update(terrain ? (ll) => map!.queryTerrainElevation(ll) : null, elevation);
    }
    return elevation;
  }

  private readonly onTerrain = (): void => {
    clearTimeout(this.terrainTimer);
    this.elevations.clear();
    this.ctx?.requestRepaint();
  };

  /** DEM tiles arriving refine elevations; batch them like the camera debounce. */
  private readonly onTerrainData = (e: { sourceId?: string; sourceDataType?: string }): void => {
    const terrain = this.ctx?.map.getTerrain();
    if (!terrain || !this.placed.size || e.sourceId !== terrain.source) return;
    if (e.sourceDataType && e.sourceDataType !== 'content') return;
    clearTimeout(this.terrainTimer);
    this.terrainTimer = setTimeout(this.onTerrain, TERRAIN_DEBOUNCE_MS);
  };

  /** Apply the resident set to the style: replaced basemap buildings and attribution. */
  private syncStyle(): void {
    this.applyFades();
    this.attribution?.set(this.getVisibleModels().length ? this.getAttribution() : '');
  }

  private report(err: unknown, ctx: ErrorContext): void {
    if (this.opts.onError) this.opts.onError(err, ctx);
    else console.warn('[maplibre-landmarks]', ctx, err);
  }
}
