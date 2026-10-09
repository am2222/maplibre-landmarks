import { polygonsOf } from '../core/geometry';
import { tileBounds, type FeedFeature } from '../core/tileFeed';
import { pieceKey, PointIndex, type MappedTree } from './collect';
import { hashValues } from './hash';
import { scatterPiece, shouldScatter, type PolygonCoords, type ScatterPoint } from './scatter';

/** A scattered tree with its thinning value (value 5 of its hash: 0-4 pick its look). */
export interface ThinnedPoint extends ScatterPoint {
  thin: number;
}

export interface TreeTile {
  key: string;
  bounds: [number, number, number, number];
  mapped: MappedTree[];
  /** Scattered trees, computed on first call (far tiles a selection never reaches stay unscattered). */
  scatter(): ThinnedPoint[];
}

export interface TreeTilesOptions {
  /** Trees per m² by landuse kind. */
  scatter: Record<string, number>;
  /** A piece holding at least this share of its target as mapped trees is not scattered. */
  skipRatio: number;
}

interface Piece {
  kind: string;
  coords: PolygonCoords;
}

interface Entry {
  mapped: MappedTree[];
  pieces: Piece[];
  /** Scattered trees, computed lazily (undefined when the tile's data changed). */
  scattered?: ThinnedPoint[];
  filled: number;
  skipped: number;
}

/** Scattered pieces kept for reuse (a tile that reloads, or a piece in a parent and a child). */
const PIECE_CACHE_LIMIT = 4096;

/**
 * Trees per tile: each tile's mapped trees and its green polygon pieces, scattered lazily and
 * kept until the tile is dropped. Scattering is deterministic per piece, so a polygon split
 * across tiles comes out the same as a whole one. Whether a piece is filled is decided per
 * piece, from the mapped trees of the same tile inside it.
 */
export class TreeTiles {
  private readonly entries = new Map<string, Entry>();
  private readonly pieceCache = new Map<string, ThinnedPoint[]>();
  /** Pieces scattered so far (cache misses, cumulative). */
  piecesScattered = 0;

  constructor(private readonly options: TreeTilesOptions) {}

  /** Mapped trees (point features) of a tile. */
  setPoints(key: string, features: FeedFeature[]): void {
    const mapped = new Map<string, MappedTree>();
    for (const f of features) {
      if (f.geometry.type !== 'Point') continue;
      const [lng, lat] = f.geometry.coordinates as [number, number];
      const id =
        f.id !== undefined && f.id !== null ? `t:${f.id}` : `t:${lng.toFixed(6)},${lat.toFixed(6)}`;
      if (!mapped.has(id)) mapped.set(id, { key: id, lngLat: [lng, lat] });
    }
    const entry = this.entry(key);
    entry.mapped = [...mapped.values()];
    entry.scattered = undefined;
  }

  /** Green polygon pieces of a tile. */
  setPolygons(key: string, features: FeedFeature[]): void {
    const pieces: Piece[] = [];
    for (const f of features) {
      const kind = String(f.properties?.kind);
      if (!(kind in this.options.scatter)) continue;
      for (const coords of polygonsOf(f.geometry)) pieces.push({ kind, coords });
    }
    const entry = this.entry(key);
    entry.pieces = pieces;
    entry.scattered = undefined;
  }

  /** The points feed dropped the tile: its mapped trees go, its polygons stay. */
  dropPoints(key: string): void {
    this.clear(key, (e) => (e.mapped = []));
  }

  /** The polygons feed dropped the tile: its pieces go, its mapped trees stay. */
  dropPolygons(key: string): void {
    this.clear(key, (e) => (e.pieces = []));
  }

  drop(key: string): void {
    this.entries.delete(key);
  }

  private clear(key: string, part: (e: Entry) => void): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    part(entry);
    entry.scattered = undefined;
    if (!entry.mapped.length && !entry.pieces.length) this.entries.delete(key);
  }

  /** Every held tile; scattering happens when a tile's `scatter()` is first called. */
  tiles(): TreeTile[] {
    return [...this.entries].map(([key, entry]) => ({
      key,
      bounds: tileBounds(key),
      mapped: entry.mapped,
      scatter: () => (entry.scattered ??= this.scatter(entry)),
    }));
  }

  /** Pieces filled and skipped in the tiles scattered so far. */
  pieceCounts(): { filled: number; skipped: number } {
    let filled = 0;
    let skipped = 0;
    for (const e of this.entries.values())
      if (e.scattered) {
        filled += e.filled;
        skipped += e.skipped;
      }
    return { filled, skipped };
  }

  private entry(key: string): Entry {
    let entry = this.entries.get(key);
    if (!entry) this.entries.set(key, (entry = { mapped: [], pieces: [], filled: 0, skipped: 0 }));
    return entry;
  }

  private scatter(entry: Entry): ThinnedPoint[] {
    entry.filled = 0;
    entry.skipped = 0;
    if (!entry.pieces.length) return [];
    const index = new PointIndex(entry.mapped);
    const out: ThinnedPoint[] = [];
    for (const { kind, coords } of entry.pieces) {
      const density = this.options.scatter[kind]!;
      const inside = entry.mapped.length ? index.countInside([coords]) : 0;
      if (!shouldScatter([coords], density, inside, this.options.skipRatio)) {
        entry.skipped++;
        continue;
      }
      entry.filled++;
      const cacheKey = `${kind}|${density}|${pieceKey(coords)}`;
      let points = this.pieceCache.get(cacheKey);
      if (!points) {
        points = scatterPiece(kind, coords, density).map((p) => ({
          ...p,
          thin: hashValues(p.key, 6)[5]!,
        }));
        this.piecesScattered++;
        if (this.pieceCache.size >= PIECE_CACHE_LIMIT)
          this.pieceCache.delete(this.pieceCache.keys().next().value!);
      }
      this.pieceCache.delete(cacheKey); // LRU: most recent last
      this.pieceCache.set(cacheKey, points);
      out.push(...points);
    }
    return out;
  }
}
