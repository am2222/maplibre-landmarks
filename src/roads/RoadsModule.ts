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
import { buildGround, buildJunction, buildPortal, buildRaised, rampFor, type XZ } from './geometry';
import { groundLeft, junctionsOf, portalsOf, rankOf, type Junction, type Portal } from './ground';
import { chainSpans, raiseLinks, withApproaches, type Raised } from './network';
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
   * Roads and railways on the ground in 3D too, following the terrain, with their markings and a
   * patch over each junction (default false: the basemap draws them). `radius`: how far from the
   * view centre, metres (default 800, within the far cutoff); `maxSegments`: the nearest drawn at
   * most (default 2500).
   */
  groundRoads?: boolean | { radius?: number; maxSegments?: number };
  /** A portal where a road or railway goes into a tunnel (default true). */
  tunnels?: boolean;
  /**
   * The app's flat layers this layer draws instead, hidden while it is on: bridges (e.g.
   * Protomaps' `roads_bridges_*`) so decks do not float over a road painted on the river,
   * tunnels (`roads_tunnels_*`), and with `groundRoads` the roads on the ground.
   */
  replaceLayers?: string[];
  onError?: (err: unknown) => void;
}

export interface RoadsStats {
  bridges: number;
  /** Road and rail stretches drawn on the ground (with `groundRoads`). */
  ground: number;
  junctions: number;
  portals: number;
  /** Bridge ends that ramp down along the road beyond them (the rest ramp on the bridge). */
  approaches: number;
  triangles: number;
  /** Highest deck drawn, metres above the ground. */
  highest: number;
}

const REBUILD_DEBOUNCE_MS = 150;
/**
 * Tiles are read at least this far from the view centre, metres, past the far cutoff: a bridge
 * near the cutoff is placed from its segment's pieces and connectors beyond it.
 */
const MIN_REACH_M = 1000;
/** Tiles no longer in view kept to complete segments still in view (most recent first out last). */
const RETIRED_TILES = 64;
const M_PER_DEG = 111_320;

/** Keep a dropped tile's data, newest last, at most RETIRED_TILES. */
function retire<T>(store: Map<string, T>, key: string, value: T): void {
  store.delete(key);
  store.set(key, value);
  while (store.size > RETIRED_TILES) store.delete(store.keys().next().value!);
}

/** A road or railway the piers must stand clear of, with its bounding box. */
interface Obstacle {
  coords: LngLat[];
  width: number;
  bbox: [number, number, number, number];
}

const bboxOf = (coords: LngLat[]): Obstacle['bbox'] => {
  const xs = coords.map((p) => p[0]);
  const ys = coords.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

/** Distance from a point to a polyline, both in local metres. */
function distanceTo([x, z]: XZ, line: XZ[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const [a, b] = [line[i]!, line[i + 1]!];
    const [dx, dz] = [b[0] - a[0], b[1] - a[1]];
    const len2 = dx * dx + dz * dz;
    const t = len2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / len2)) : 0;
    best = Math.min(best, Math.hypot(a[0] + dx * t - x, a[1] + dz * t - z));
  }
  return best;
}

/** What the held tiles hold, ready to draw. */
interface World {
  raised: Raised[];
  /** Road and rail stretches on the ground, less what the approaches take. */
  ground: Span[];
  junctions: Junction[];
  portals: Portal[];
}

/** Something to draw: its mesh is built around `origin`, once while `source` is unchanged. */
interface Item {
  key: string;
  source: object;
  origin: LngLat;
  make(origin: LngLat): { mesh: RoofMesh; top: number };
}

interface Built {
  source: object;
  /** Mesh around `origin`, heights above sea level. */
  origin: LngLat;
  mesh: RoofMesh;
  top: number;
}

const GROUND_RADIUS_M = 800;
const MAX_GROUND = 2500;

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
  /**
   * Pieces and connectors of tiles that left the view, newest last: a segment still in view whose
   * other end is in no loaded tile is completed from them.
   */
  private readonly retired = new Map<string, SegmentPiece[]>();
  private readonly retiredConnectors = new Map<string, Map<string, LngLat>>();
  private world?: World;
  /** Roads, railways and bridges of the held tiles, for placing piers clear of them. */
  private obstacles: Obstacle[] = [];
  /** Built structures by key, kept while they and the ground are unchanged. */
  private built = new Map<string, Built>();
  private drawn: Item[] = [];
  private anchor: LngLat = [0, 0];
  private view?: ViewState;
  private timer?: ReturnType<typeof setTimeout>;
  private stats: RoadsStats = {
    bridges: 0,
    ground: 0,
    junctions: 0,
    portals: 0,
    approaches: 0,
    triangles: 0,
    highest: 0,
  };
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
    this.retired.clear();
    this.retiredConnectors.clear();
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

  private reach(view: ViewState): number {
    return Math.max(farCutoffM(view), MIN_REACH_M);
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
    const world = (this.world ??= this.worldOfTiles());
    const cutoff = this.options.farCutoff === false ? Infinity : farCutoffM(view);
    const k = M_PER_DEG * Math.cos((view.center[1] * Math.PI) / 180);
    const away = ([lng, lat]: LngLat) =>
      Math.hypot((lng - view.center[0]) * k, (lat - view.center[1]) * M_PER_DEG);
    const distance = (c: { coords: LngLat[] }) => Math.min(...c.coords.map(away));
    const nearest = <T>(list: T[], d: (t: T) => number, within: number, max: number) =>
      list
        .map((t) => ({ t, d: d(t) }))
        .filter((x) => x.d <= within)
        .sort((a, b) => a.d - b.d)
        .slice(0, max)
        .map(({ t }) => t);
    const items: Item[] = nearest(
      world.raised,
      distance,
      cutoff,
      this.options.maxBridges ?? 400,
    ).map((r) => ({
      key: `raised:${r.key}`,
      source: r,
      origin: r.coords[0]!,
      make: (o) => this.build(r, o),
    }));
    const surfaces = this.options.groundRoads;
    if (surfaces) {
      const opts = typeof surfaces === 'object' ? surfaces : {};
      const within = Math.min(cutoff, opts.radius ?? GROUND_RADIUS_M);
      const ground = nearest(world.ground, distance, within, opts.maxSegments ?? MAX_GROUND);
      for (const g of ground)
        items.push({
          key: `ground:${g.key}`,
          source: g,
          origin: g.coords[0]!,
          make: (o) => ({ mesh: this.buildGroundSpan(g, o, world.junctions), top: 0 }),
        });
      for (const j of nearest(world.junctions, (j) => away(j.at), within, Infinity))
        items.push({
          key: `junction:${j.at.join()}`,
          source: j,
          origin: j.at,
          make: () => ({
            mesh: buildJunction([0, 0], j.radius, j.rank, this.groundAt(j.at)),
            top: 0,
          }),
        });
    }
    if (this.options.tunnels !== false)
      for (const p of nearest(world.portals, (p) => away(p.at), cutoff, Infinity))
        items.push({
          key: `portal:${p.at.join()}`,
          source: p,
          origin: p.at,
          // Into the tunnel in (east, south) local axes.
          make: () => ({
            mesh: buildPortal(
              [0, 0],
              [p.heading[0], -p.heading[1]],
              p.width,
              p.kind,
              this.groundAt(p.at),
            ),
            top: 0,
          }),
        });
    this.draw(view, items);
  }

  private groundAt(p: LngLat): number {
    const map = this.ctx?.map;
    return map?.getTerrain() ? (map.queryTerrainElevation(p) ?? 0) : 0;
  }

  private buildGroundSpan(g: Span, origin: LngLat, junctions: Junction[]): RoofMesh {
    const o = originAt(origin);
    const local = (p: LngLat): XZ => {
      const [x, , z] = localPosition(o, p);
      return [x, z];
    };
    const pad = 30 / M_PER_DEG;
    const [w, s, e, n] = bboxOf(g.coords);
    const near = junctions
      .filter(({ at: [x, y] }) => x >= w - pad && x <= e + pad && y >= s - pad && y <= n + pad)
      .map((j) => ({ at: local(j.at), radius: j.radius }));
    return buildGround({
      points: g.coords.map(local),
      width: g.width,
      kind: g.kind,
      cls: g.cls,
      rank: rankOf(g),
      ground: ([x, z]) => this.groundAt(lngLatAt(o, x, z)),
      junctions: near,
    });
  }

  /**
   * The raised roads of the held tiles: each segment's pieces together, split into bridges and
   * ground; bridges joined end to end, then given the ground roads that lead onto them.
   */
  private worldOfTiles(): World {
    const bySegment = new Map<string, SegmentPiece[]>();
    for (const pieces of this.tiles.values())
      for (const p of pieces) bySegment.set(p.id, [...(bySegment.get(p.id) ?? []), p]);
    // Only for segments in view: the retired tiles complete them, they add none.
    for (const pieces of this.retired.values())
      for (const p of pieces) {
        const held = bySegment.get(p.id);
        if (held) held.push(p);
      }
    const connectors = new Map<string, LngLat>();
    for (const tile of [...this.retiredConnectors.values(), ...this.connectorTiles.values()])
      for (const [id, p] of tile) connectors.set(id, p);
    const bridges: Span[] = [];
    const tunnels: Span[] = [];
    const ground: Span[] = [];
    for (const pieces of bySegment.values()) {
      try {
        const parts = partsOf(pieces, (id) => connectors.get(id));
        bridges.push(...parts.bridges);
        tunnels.push(...parts.tunnels);
        ground.push(...parts.ground);
      } catch (err) {
        this.report(err instanceof Error ? err : new Error(String(err)));
      }
    }
    // Underpasses are below ground: piers may stand over them.
    this.obstacles = [...bridges, ...ground.filter((g) => g.level >= 0)].map((g) => ({
      coords: g.coords,
      width: g.width,
      bbox: bboxOf(g.coords),
    }));
    const linked = raiseLinks(bridges, ground, rampFor);
    const raised = withApproaches(chainSpans(linked.bridges), linked.ground, rampFor);
    const segments = [...bySegment.values()].map((pieces) => pieces[0]!);
    return {
      raised,
      ground: groundLeft(linked.ground, raised),
      junctions: this.options.groundRoads
        ? junctionsOf(segments, (id) => connectors.get(id), raised)
        : [],
      portals: portalsOf(tunnels, ground),
    };
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
        tileNearestM(key, this.view.center) <= this.reach(this.view),
      onTile: (key, features) => {
        this.noteSliced(ctx, key);
        this.tiles.set(key, this.read(key, features));
        this.world = undefined;
        this.schedule();
      },
      onDrop: (key) => {
        const pieces = this.tiles.get(key);
        if (pieces) retire(this.retired, key, pieces);
        if (this.tiles.delete(key)) this.world = undefined;
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
        tileNearestM(key, this.view.center) <= this.reach(this.view),
      onTile: (key, features) => {
        const points = new Map<string, LngLat>();
        for (const f of features) {
          const id = f.properties?.id;
          if (f.geometry.type === 'Point' && id !== undefined && id !== null)
            points.set(String(id), f.geometry.coordinates as LngLat);
        }
        this.connectorTiles.set(key, points);
        this.world = undefined;
        this.schedule();
      },
      onDrop: (key) => {
        const points = this.connectorTiles.get(key);
        if (points) retire(this.retiredConnectors, key, points);
        if (this.connectorTiles.delete(key)) this.world = undefined;
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

  /** The chosen items in one mesh around the view centre (rebuilt only when they change). */
  private draw(view: ViewState, chosen: Item[]): void {
    const ctx = this.ctx;
    if (!ctx || !this.mesh) return;
    // The same objects: unchanged (new tiles make new ones, even for the same bridge).
    if (
      chosen.length === this.drawn.length &&
      chosen.every((r, i) => r.source === this.drawn[i]!.source)
    )
      return;
    this.drawn = chosen;
    const built = new Map<string, Built>();
    for (const item of chosen) {
      let b = this.built.get(item.key);
      if (!b || b.source !== item.source)
        b = { source: item.source, origin: item.origin, ...item.make(item.origin) };
      built.set(item.key, b);
    }
    this.built = built;
    this.anchor = view.center;
    const anchorOrigin = originAt(this.anchor);
    const positions: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];
    let highest = 0;
    for (const b of built.values()) {
      const [ox, , oz] = localPosition(anchorOrigin, b.origin);
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
    const of = (prefix: string) => chosen.filter((i) => i.key.startsWith(prefix));
    const raised = of('raised:').map((i) => i.source as Raised);
    this.stats = {
      bridges: raised.length,
      ground: of('ground:').length,
      junctions: of('junction:').length,
      portals: of('portal:').length,
      approaches: raised.reduce((n, r) => n + r.approaches.filter((a) => a > 0).length, 0),
      triangles: positions.length / 9,
      highest,
    };
    ctx.requestRepaint();
  }

  /**
   * Whether a pier column would stand on another road: the obstacles near this structure, less
   * the ones running along it (its own segments, and roads under its deck lengthwise).
   */
  private blockerFor(raised: Raised, local: (p: LngLat) => XZ): (p: XZ, r: number) => boolean {
    const pad = 40 / M_PER_DEG;
    const [w, s, e, n] = bboxOf(raised.coords);
    const own = raised.coords.map(local);
    const halfWidth = Math.max(...raised.widths) / 2 + 1.5;
    const near = this.obstacles
      .filter(
        (o) =>
          o.bbox[0] <= e + pad &&
          o.bbox[2] >= w - pad &&
          o.bbox[1] <= n + pad &&
          o.bbox[3] >= s - pad,
      )
      .map((o) => ({ line: o.coords.map(local), width: o.width }))
      .filter(({ line }) => !line.every((p) => distanceTo(p, own) <= halfWidth));
    return (p, r) => near.some(({ line, width }) => distanceTo(p, line) < width / 2 + r);
  }

  private build(raised: Raised, at: LngLat): { mesh: RoofMesh; top: number } {
    const origin = originAt(at);
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
      ground: ([x, z]) => this.groundAt(lngLatAt(origin, x, z)),
      blocked: this.blockerFor(raised, local),
    });
    return { mesh, top };
  }
}
