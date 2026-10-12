import { Group, InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import { farCutoffM, tileNearestM } from '../core/cutoff';
import type { LayerModule, ModuleContext } from '../core/LayerModule';
import { localPosition, originAt } from '../core/mercator';
import { TileFeed, type FeedFeature, type FeedMap } from '../core/tileFeed';
import type { LngLat, Origin, ViewState } from '../core/types';
import {
  directionDeg,
  hashedTurnDeg,
  PROP_COLOURS,
  PROP_KINDS,
  propGeometry,
  type PropKind,
} from './props';

export interface StreetFurnitureOptions {
  /** Vector source with Overture's `base` schema (`infrastructure` layer). */
  source: string;
  /** Source layer holding the props (default 'infrastructure'). */
  sourceLayer?: string;
  /** Props appear from this zoom (default 16: they are under 2 m tall). */
  minZoom?: number;
  /** Nearest props drawn per kind at most (default 1500). */
  maxPerKind?: number;
  /** Kinds to draw (default all). */
  kinds?: PropKind[];
  /** Pitched views draw props only to about three screen heights away (default true). */
  farCutoff?: boolean;
  onError?: (err: unknown) => void;
}

export interface StreetFurnitureStats {
  total: number;
  byKind: Partial<Record<PropKind, number>>;
}

interface Prop {
  kind: PropKind;
  /** Overture's id: the same prop in every tile and zoom (its position is quantised per tile). */
  id?: string;
  lngLat: LngLat;
  /** Degrees clockwise from north the prop's front faces. */
  facing: number;
}

const REBUILD_DEBOUNCE_MS = 150;

const tagsOf = (f: FeedFeature): Record<string, unknown> => {
  try {
    return JSON.parse(String(f.properties?.source_tags ?? '{}')) as Record<string, unknown>;
  } catch {
    return {};
  }
};

/** Benches, bins, bollards, hydrants and other street furniture, instanced per kind. */
export class StreetFurnitureModule implements LayerModule {
  private ctx?: ModuleContext;
  private readonly group = new Group();
  private readonly meshes = new Map<PropKind, InstancedMesh>();
  private feed?: TileFeed;
  private readonly tiles = new Map<string, Prop[]>();
  private anchor: LngLat = [0, 0];
  private view?: ViewState;
  private timer?: ReturnType<typeof setTimeout>;
  private stats: StreetFurnitureStats = { total: 0, byKind: {} };
  private reported = false;
  private readonly kinds: PropKind[];

  constructor(private readonly options: StreetFurnitureOptions) {
    this.group.name = 'street-furniture';
    // Once each: a kind listed twice would get two meshes and overfill one.
    this.kinds = [...new Set(options.kinds ?? PROP_KINDS)];
  }

  onAdd(ctx: ModuleContext): void {
    this.ctx = ctx;
    for (const kind of this.kinds) {
      const material = new MeshStandardMaterial({ color: PROP_COLOURS[kind], roughness: 0.8 });
      const mesh = new InstancedMesh(propGeometry(kind), material, this.maxPerKind);
      mesh.name = kind;
      mesh.count = 0;
      mesh.frustumCulled = false;
      this.meshes.set(kind, mesh);
      this.group.add(mesh);
    }
    ctx.scene.add(this.group);
    ctx.map.on('terrain', this.schedule);
    ctx.map.on('sourcedata', this.onSourceData);
  }

  update(view: ViewState): void {
    this.view = view;
    this.rebuild();
  }

  place(origin: Origin): void {
    this.group.position.set(...localPosition(origin, this.anchor, 0));
    this.group.updateMatrixWorld(true);
  }

  getStats(): StreetFurnitureStats {
    return { total: this.stats.total, byKind: { ...this.stats.byKind } };
  }

  styleChanged(attached: boolean): void {
    this.feed?.reset();
    if (attached) this.rebuild();
  }

  onRemove(): void {
    clearTimeout(this.timer);
    this.ctx?.map.off('terrain', this.schedule);
    this.ctx?.map.off('sourcedata', this.onSourceData);
    this.feed?.dispose();
    this.feed = undefined;
    this.ctx?.scene.remove(this.group);
    for (const mesh of this.meshes.values()) {
      mesh.geometry.dispose();
      (mesh.material as MeshStandardMaterial).dispose();
      mesh.dispose();
    }
    this.meshes.clear();
    this.ctx = undefined;
  }

  private get maxPerKind(): number {
    return this.options.maxPerKind ?? 1500;
  }

  private readonly schedule = (): void => {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.rebuild(), REBUILD_DEBOUNCE_MS);
  };

  private rebuild(): void {
    const ctx = this.ctx;
    const view = this.view;
    if (!ctx || !view) return;
    const hasSource = !!ctx.map.getSource(this.options.source);
    if (!hasSource && !this.reported) {
      this.reported = true;
      const err = new Error(`source "${this.options.source}" not found`);
      if (this.options.onError) this.options.onError(err);
      else console.warn('[maplibre-landmarks] street furniture', err);
    }
    if (!hasSource || view.zoom < (this.options.minZoom ?? 16)) {
      this.feed?.suspend();
      this.draw(view, []);
      return;
    }
    this.feedFor(ctx).settle();
    const cutoff = this.options.farCutoff === false ? Infinity : farCutoffM(view);
    const k = 111_320 * Math.cos((view.center[1] * Math.PI) / 180);
    const distance = ([lng, lat]: LngLat) =>
      Math.hypot((lng - view.center[0]) * k, (lat - view.center[1]) * 111_320);
    // A prop near a tile edge is in both tiles' buffers, and in a parent and a child tile while
    // zooming: once each, by id (by position when the data has none).
    const unique = new Map<string, Prop>();
    for (const props of this.tiles.values())
      for (const p of props)
        unique.set(p.id ?? `${p.kind}|${p.lngLat[0].toFixed(7)},${p.lngLat[1].toFixed(7)}`, p);
    const byKind = new Map<PropKind, { p: Prop; d: number }[]>();
    for (const p of unique.values()) {
      const d = distance(p.lngLat);
      if (d > cutoff) continue;
      const list = byKind.get(p.kind);
      if (list) list.push({ p, d });
      else byKind.set(p.kind, [{ p, d }]);
    }
    const chosen = [...byKind.values()].flatMap((list) =>
      list
        .sort((a, b) => a.d - b.d)
        .slice(0, this.maxPerKind)
        .map(({ p }) => p),
    );
    this.draw(view, chosen);
  }

  /** The terrain's elevation tiles arrived: stand the props on the ground they now have. */
  private readonly onSourceData = (e: { sourceId?: string }): void => {
    const terrain = this.ctx?.map.getTerrain()?.source;
    if (terrain && e.sourceId === terrain) this.schedule();
  };

  private feedFor(ctx: ModuleContext): TileFeed {
    this.feed ??= new TileFeed(ctx.map as unknown as FeedMap, {
      source: this.options.source,
      sourceLayer: this.options.sourceLayer ?? 'infrastructure',
      filter: ['in', ['get', 'class'], ['literal', this.kinds]],
      wants: (key) =>
        key === '*' ||
        !this.view ||
        this.options.farCutoff === false ||
        tileNearestM(key, this.view.center) <= farCutoffM(this.view),
      onTile: (key, features) => {
        this.tiles.set(key, this.read(features));
        this.schedule();
      },
      onDrop: (key) => {
        this.tiles.delete(key);
        this.schedule();
      },
    });
    return this.feed;
  }

  private read(features: FeedFeature[]): Prop[] {
    const props: Prop[] = [];
    for (const f of features) {
      const kind = String(f.properties?.class) as PropKind;
      if (!this.kinds.includes(kind) || f.geometry.type !== 'Point') continue;
      const lngLat = f.geometry.coordinates as LngLat;
      const id = f.properties?.id;
      props.push({
        kind,
        ...(id !== undefined && id !== null && id !== '' ? { id: String(id) } : {}),
        lngLat,
        facing: directionDeg(tagsOf(f)) ?? hashedTurnDeg(lngLat),
      });
    }
    return props;
  }

  /** Write the chosen props into their meshes, around the view centre. */
  private draw(view: ViewState, chosen: Prop[]): void {
    const ctx = this.ctx!;
    this.anchor = view.center;
    const origin = originAt(this.anchor);
    const ground = (p: LngLat) =>
      ctx.map.getTerrain() ? (ctx.map.queryTerrainElevation(p) ?? 0) : 0;
    const counts = new Map<PropKind, number>();
    const m = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    const one = new Vector3(1, 1, 1);
    for (const p of chosen) {
      const mesh = this.meshes.get(p.kind);
      if (!mesh) continue;
      const i = counts.get(p.kind) ?? 0;
      const base = new Vector3(...localPosition(origin, p.lngLat, ground(p.lngLat)));
      // Front is −Z (north); turning clockwise seen from above is negative about +Y.
      q.setFromAxisAngle(up, (-p.facing * Math.PI) / 180);
      mesh.setMatrixAt(i, m.compose(base, q, one));
      counts.set(p.kind, i + 1);
    }
    const byKind: Partial<Record<PropKind, number>> = {};
    for (const [kind, mesh] of this.meshes) {
      mesh.count = counts.get(kind) ?? 0;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.count) byKind[kind] = mesh.count;
    }
    this.stats = { total: chosen.length, byKind };
    ctx.requestRepaint();
  }
}
