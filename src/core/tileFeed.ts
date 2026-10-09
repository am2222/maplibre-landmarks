import type { Map as MlMap } from 'maplibre-gl';

/** A source feature as MapLibre returns it (geometry decoded lazily on access). */
export interface FeedFeature {
  id?: number | string | null;
  geometry: { type: string; coordinates: unknown };
  properties?: Record<string, unknown> | null;
  /** The data tile it came from (set by MapLibre's per-tile query). */
  tile?: { z: number; x: number; y: number };
}

export interface TileFeedOptions {
  source: string;
  /** Source layer of a vector source; undefined for GeoJSON sources. */
  sourceLayer?: string;
  /** MapLibre filter applied to the features of each tile. */
  filter?: unknown[];
  /** A tile arrived (or reloaded): its own features only. */
  onTile(key: string, features: FeedFeature[]): void;
  /** A tile is no longer needed: drop what was built from it. */
  onDrop(key: string): void;
  /**
   * Whether the layer needs a tile now. Unwanted tiles are held but neither read nor delivered;
   * `featuresOf` reads them on demand (default: every tile is wanted).
   */
  wants?(key: string): boolean;
  /** Most tiles held at once; the farthest from the view go first (default 256). */
  maxTiles?: number;
}

export type FeedMap = Pick<MlMap, 'on' | 'off' | 'getSource' | 'querySourceFeatures' | 'getBounds'>;

type Canonical = { z: number; x: number; y: number };
type Bbox = [number, number, number, number];

/** The tile object MapLibre passes in `sourcedata` events (internal API). */
interface EventTile {
  tileID?: { canonical?: Canonical };
  querySourceFeatures?: (result: FeedFeature[], params?: object) => void;
}

/** MapLibre's tile manager of a source (internal: `map.style.tileManagers`, once `sourceCaches`). */
interface TileManagerLike {
  getRenderableIds(): unknown[];
  getTileByID(id: unknown): EventTile | undefined;
}

interface Held {
  /** The tile object to re-query (fast path), or the features grouped by the fallback. */
  tile?: EventTile;
  features?: FeedFeature[];
  /** Fallback only: identity of the grouped features, to notice a changed tile. */
  signature?: string;
  bounds: Bbox;
  /** Delivered through `onTile` (false while its layer does not want it). */
  delivered?: boolean;
}

export const tileKey = ({ z, x, y }: Canonical): string => `${z}/${x}/${y}`;

/** Lng/lat bounds `[west, south, east, north]` of a tile key (the whole world for `*`). */
export function tileBounds(key: string): Bbox {
  if (key === '*') return [-180, -90, 180, 90];
  const [z, x, y] = key.split('/').map(Number) as [number, number, number];
  const n = 2 ** z;
  const lng = (t: number) => (t / n) * 360 - 180;
  const lat = (t: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * t) / n))) * 180) / Math.PI;
  return [lng(x), lat(y + 1), lng(x + 1), lat(y)];
}

let fallbackLogged = false;

/** Development builds only (bundlers replace `process.env.NODE_ENV`): say once per page. */
function logFallback(source: string): void {
  if (fallbackLogged) return;
  let development = false;
  try {
    development = process.env.NODE_ENV === 'development';
  } catch {
    // No bundler define: treat as production.
  }
  if (!development) return;
  fallbackLogged = true;
  console.info(
    `[maplibre-landmarks] source "${source}": MapLibre exposes no per-tile access, so layers ` +
      're-read the whole source on each update (slower). See "How layers use tiles" in the docs.',
  );
}

const overlaps = (a: Bbox, b: Bbox) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

/**
 * Turns a source's loading tiles into per-tile callbacks, so layers build each tile once and keep
 * the result while it is loaded (as MapLibre does for its own layers).
 *
 * Fast path: MapLibre fires a `sourcedata` event carrying each loaded tile; that tile alone is
 * queried (`tile.querySourceFeatures`, an internal method). MapLibre fires nothing when it stops
 * using a tile, so departures are decided when the camera settles: from the source's tile manager
 * when reachable (exactly the tiles MapLibre renders, as its own `querySourceFeatures` reads
 * them), otherwise by rule: tiles outside the view (padded by one tile) and parents whose four
 * children are all held are dropped. Fallback (no tile in the events): the public
 * `querySourceFeatures`, grouped by each feature's tile, diffed on settle.
 */
export class TileFeed {
  private readonly held = new Map<string, Held>();
  /** Seed from the public query on the first settle: tiles loaded before this feed existed. */
  private needsFallback = true;
  private fast = false;
  /** The layer is inactive (zoomed out, hidden): nothing is held until the next settle. */
  private suspended = false;
  /** The source's tile manager last seen: another one means the source was replaced. */
  private knownManager?: TileManagerLike;
  /** Keys of tiles with a held descendant (rebuilt after the held set changes). */
  private ancestors?: Set<string>;
  /** The first (seeding) public query ran: later ones mean the slow path. */
  private seeded = false;

  constructor(
    private readonly map: FeedMap,
    private readonly options: TileFeedOptions,
  ) {
    map.on('sourcedata', this.onData);
  }

  /**
   * True once tiles are read one by one (from the events' tile objects or the source's tile
   * manager); false while the public-query fallback is in use.
   */
  get fastPath(): boolean {
    return this.fast;
  }

  keys(): string[] {
    return [...this.held.keys()];
  }

  /** Features of a held tile, queried again (nothing decoded is stored between calls). */
  featuresOf(key: string): FeedFeature[] | undefined {
    const held = this.held.get(key);
    if (!held) return undefined;
    if (held.features) return held.features;
    return this.query(held.tile!);
  }

  /**
   * Whether held deeper tiles already cover `bbox` (lng/lat) of a held tile: MapLibre draws a
   * parent only where its children are still missing, so layers skip what they would double.
   */
  shadowed(key: string, bbox: Bbox): boolean {
    if (key === '*') return false;
    if (!this.ancestors) {
      this.ancestors = new Set();
      for (const k of this.held.keys()) {
        if (k === '*') continue;
        let [z, x, y] = k.split('/').map(Number) as [number, number, number];
        while (z > 0) {
          [z, x, y] = [z - 1, x >> 1, y >> 1];
          this.ancestors.add(tileKey({ z, x, y }));
        }
      }
    }
    if (!this.ancestors.has(key)) return false;
    const [z, x, y] = key.split('/').map(Number) as [number, number, number];
    let any = false;
    for (const [dx, dy] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const) {
      const child = tileKey({ z: z + 1, x: 2 * x + dx, y: 2 * y + dy });
      if (!overlaps(tileBounds(child), bbox)) continue;
      any = true;
      if (!this.held.has(child) && !this.shadowed(child, bbox)) return false;
    }
    return any;
  }

  /** The camera settled: run the fallback if needed, then drop tiles no longer in use. */
  settle(): void {
    this.suspended = false;
    if (!this.syncWithManager()) this.settleByRules();
    // Held tiles the layer did not want on arrival, wanted now (its far cutoff moved out).
    if (this.options.wants)
      for (const [key, held] of [...this.held])
        if (!held.delivered && this.options.wants(key)) {
          held.delivered = true;
          this.options.onTile(key, held.features ?? this.query(held.tile!));
        }
  }

  private settleByRules(): void {
    // Without the fast path every settle re-reads the source (what layers did before the feed).
    if (this.needsFallback || !this.fast) this.runFallback();
    const view = this.view();
    if (!view) return;
    const pad = (key: string): Bbox => {
      const [w, s, e, n] = this.held.get(key)!.bounds;
      return [w - (e - w), s - (n - s), e + (e - w), n + (n - s)];
    };
    for (const key of this.keys()) {
      if (key === '*') continue;
      if (!overlaps(pad(key), view) || this.covered(key)) this.drop(key);
    }
    const max = this.options.maxTiles ?? 256;
    if (this.held.size > max) {
      const [cx, cy] = [(view[0] + view[2]) / 2, (view[1] + view[3]) / 2];
      const distance = (key: string) => {
        const [w, s, e, n] = this.held.get(key)!.bounds;
        return Math.hypot((w + e) / 2 - cx, (s + n) / 2 - cy);
      };
      const byDistance = this.keys().sort((a, b) => distance(b) - distance(a));
      for (const key of byDistance.slice(0, this.held.size - max)) this.drop(key);
    }
  }

  /** Style swap or source change: drop every tile; arrivals start again. */
  reset(): void {
    for (const key of this.keys()) this.drop(key);
    this.needsFallback = true;
  }

  /** The layer stopped drawing (zoomed out, no source): drop every tile, ignore arrivals. */
  suspend(): void {
    if (this.suspended) return;
    this.reset();
    this.suspended = true;
  }

  dispose(): void {
    this.map.off('sourcedata', this.onData);
    this.held.clear();
    this.ancestors = undefined;
  }

  private readonly onData = (e: {
    sourceId?: string;
    sourceDataType?: string;
    tile?: EventTile;
  }): void => {
    if (e.sourceId !== this.options.source || this.suspended) return;
    const tile = e.tile;
    const canonical = tile?.tileID?.canonical;
    if (tile && canonical && typeof tile.querySourceFeatures === 'function') {
      this.fast = true;
      this.noticeReplacedSource(this.manager());
      const key = tileKey(canonical);
      const held = this.held.get(key);
      if (held?.tile && held.tile !== tile) {
        // Another overscaled tile object over the same data: nothing new to build.
        held.tile = tile;
        return;
      }
      if (held) this.drop(key); // the same tile reloaded
      this.arrive(key, tile);
      return;
    }
    if (!this.fast && (tile || !e.sourceDataType || e.sourceDataType === 'content'))
      this.needsFallback = true;
  };

  /** Hold a tile; read and deliver it unless its layer does not want it (read on demand then). */
  private arrive(key: string, tile: EventTile): void {
    const held: Held = { tile, bounds: tileBounds(key) };
    this.held.set(key, held);
    this.ancestors = undefined;
    if (this.options.wants && !this.options.wants(key)) return;
    held.delivered = true;
    this.options.onTile(key, this.query(tile));
  }

  private query(tile: EventTile): FeedFeature[] {
    const result: FeedFeature[] = [];
    tile.querySourceFeatures!(result, this.params());
    return result;
  }

  private params(): { sourceLayer?: string; filter?: unknown[] } {
    const { sourceLayer, filter } = this.options;
    return { ...(sourceLayer ? { sourceLayer } : {}), ...(filter ? { filter } : {}) };
  }

  /**
   * Hold exactly the tiles the source's tile manager renders: new ones arrive, gone ones drop
   * (a zoom-out drops the children a parent replaced). False when the manager is unreachable.
   */
  private syncWithManager(): boolean {
    const manager = this.manager();
    if (!manager) return false;
    this.noticeReplacedSource(manager);
    const live = new Map<string, EventTile>();
    try {
      for (const id of manager.getRenderableIds()) {
        const tile = manager.getTileByID(id);
        const canonical = tile?.tileID?.canonical;
        if (!tile || !canonical || typeof tile.querySourceFeatures !== 'function') return false;
        const key = tileKey(canonical);
        if (!live.has(key)) live.set(key, tile);
      }
    } catch {
      return false;
    }
    this.fast = true;
    this.needsFallback = false;
    for (const key of this.keys()) if (!live.has(key)) this.drop(key);
    for (const [key, tile] of live) {
      const held = this.held.get(key);
      if (held?.tile) {
        held.tile = tile;
        continue;
      }
      if (held) this.drop(key); // grouped by an earlier fallback: take the tile instead
      this.arrive(key, tile);
    }
    return true;
  }

  /**
   * A source removed and added again under the same id (a diffed `setStyle` changing its
   * definition) brings new tiles under the same keys: drop everything held from the old one.
   */
  private noticeReplacedSource(manager: TileManagerLike | undefined): void {
    if (!manager) return;
    if (this.knownManager && this.knownManager !== manager)
      for (const key of this.keys()) this.drop(key);
    this.knownManager = manager;
  }

  private manager(): TileManagerLike | undefined {
    const style = (this.map as { style?: Record<string, unknown> }).style;
    const managers = (style?.tileManagers ?? style?.sourceCaches) as
      Record<string, Partial<TileManagerLike>> | undefined;
    const m = managers?.[this.options.source];
    return typeof m?.getRenderableIds === 'function' && typeof m.getTileByID === 'function'
      ? (m as TileManagerLike)
      : undefined;
  }

  /** Public query, grouped by each feature's tile, diffed against what is held. */
  private runFallback(): void {
    this.needsFallback = false;
    if (this.seeded && !this.fast) logFallback(this.options.source);
    this.seeded = true;
    const features = this.map.querySourceFeatures(
      this.options.source,
      this.params() as never,
    ) as unknown as FeedFeature[];
    const groups = new Map<string, FeedFeature[]>();
    for (const f of features) {
      const internal = f as { _z?: number; _x?: number; _y?: number };
      const tile =
        f.tile ??
        (typeof internal._z === 'number'
          ? { z: internal._z, x: internal._x!, y: internal._y! }
          : undefined);
      const key = tile ? tileKey(tile) : '*';
      const group = groups.get(key);
      if (group) group.push(f);
      else groups.set(key, [f]);
    }
    // Tiles followed through events stay; grouped ones are diffed.
    for (const [key, held] of this.held) if (!held.tile && !groups.has(key)) this.drop(key);
    for (const [key, group] of groups) {
      const held = this.held.get(key);
      if (held?.tile) continue;
      // Ids, or where id-less features start: enough to notice a changed tile.
      const signature = `${group.length}|${group
        .map(
          (f) =>
            // Reading geometry decodes it: only for features without ids.
            f.id ?? JSON.stringify((f.geometry.coordinates as unknown[])?.[0]).slice(0, 80),
        )
        .join(',')}`;
      if (held && held.signature === signature) continue;
      if (held) this.drop(key);
      const entry: Held = { features: group, signature, bounds: tileBounds(key) };
      this.held.set(key, entry);
      this.ancestors = undefined;
      if (this.options.wants && !this.options.wants(key)) continue;
      entry.delivered = true;
      this.options.onTile(key, group);
    }
  }

  /** All four children held (or covered themselves): the parent is no longer drawn. */
  private covered(key: string): boolean {
    const [z, x, y] = key.split('/').map(Number) as [number, number, number];
    const maxzoom = (this.map.getSource(this.options.source) as { maxzoom?: number } | undefined)
      ?.maxzoom;
    if (z >= (maxzoom ?? 22)) return false;
    for (const [dx, dy] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const) {
      const child = tileKey({ z: z + 1, x: 2 * x + dx, y: 2 * y + dy });
      if (!this.held.has(child) && !this.covered(child)) return false;
    }
    return true;
  }

  private view(): Bbox | undefined {
    try {
      const b = this.map.getBounds();
      return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    } catch {
      return undefined;
    }
  }

  private drop(key: string): void {
    if (!this.held.delete(key)) return;
    this.ancestors = undefined;
    this.options.onDrop(key);
  }
}
