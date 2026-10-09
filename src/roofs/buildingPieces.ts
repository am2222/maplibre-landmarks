import { polygonsOf } from '../core/geometry';
import type { FeedFeature } from '../core/tileFeed';
import { mergeFootprint, signatureOf, type Footprint, type Union } from './footprints';

interface Piece {
  id: number | string;
  properties: Record<string, unknown>;
  polygons: number[][][][];
}

interface Building {
  sourceLayer: string;
  /** Pieces by the tile (and source layer) they came from. */
  pieces: Map<string, Piece>;
  /** Whole footprint, merged on first request after a piece changed. */
  footprint?: Footprint | null;
}

/**
 * Building pieces per tile, merged per building on demand. Buildings are keyed by source layer
 * and id (`building|7`, `building_part|7`): ids repeat across layers. A tile arriving or leaving
 * changes only the buildings it holds pieces of; only those are merged again.
 */
export class BuildingPieces {
  private readonly buildings = new Map<string, Building>();
  /** Buildings with pieces in each tile (`sourceLayer@z/x/y`). */
  private readonly byTile = new Map<string, string[]>();
  /** Pieces skipped for lacking an id (cumulative). */
  missingIds = 0;

  constructor(
    /** Which buildings to hold, from their properties (read before the geometry is decoded). */
    private readonly keep: (properties: Record<string, unknown>) => boolean,
    private readonly union?: Union,
    private readonly onError?: (key: string, err: unknown) => void,
  ) {}

  /** A tile's buildings arrived (or reloaded): returns the buildings that changed. */
  add(tileKey: string, sourceLayer: string, features: FeedFeature[]): Set<string> {
    const changed = this.drop(tileKey, sourceLayer);
    const tile = `${sourceLayer}@${tileKey}`;
    const pieces = new Map<string, Piece>();
    for (const f of features) {
      // Properties first: reading `geometry` decodes and projects the tile geometry.
      const properties = f.properties ?? {};
      if (!this.keep(properties)) continue;
      const polygons = polygonsOf(f.geometry);
      if (!polygons.length) continue;
      if (f.id === undefined || f.id === null) {
        this.missingIds++;
        continue;
      }
      const key = `${sourceLayer}|${f.id}`;
      const p = pieces.get(key);
      if (p) p.polygons.push(...polygons);
      else pieces.set(key, { id: f.id, properties, polygons: [...polygons] });
    }
    for (const [key, p] of pieces) {
      let building = this.buildings.get(key);
      if (!building) this.buildings.set(key, (building = { sourceLayer, pieces: new Map() }));
      building.pieces.set(tile, p);
      building.footprint = undefined;
      changed.add(key);
    }
    if (pieces.size) this.byTile.set(tile, [...pieces.keys()]);
    return changed;
  }

  /** A tile left: returns the buildings that changed (lost a piece, or every piece). */
  drop(tileKey: string, sourceLayer: string): Set<string> {
    const tile = `${sourceLayer}@${tileKey}`;
    const changed = new Set<string>();
    for (const key of this.byTile.get(tile) ?? []) {
      const building = this.buildings.get(key);
      if (!building?.pieces.delete(tile)) continue;
      changed.add(key);
      building.footprint = undefined;
      if (!building.pieces.size) this.buildings.delete(key);
    }
    this.byTile.delete(tile);
    return changed;
  }

  keys(): string[] {
    return [...this.buildings.keys()];
  }

  sourceLayerOf(key: string): string | undefined {
    return this.buildings.get(key)?.sourceLayer;
  }

  /** The building's whole footprint: the union of all its held pieces. */
  footprint(key: string): Footprint | undefined {
    const building = this.buildings.get(key);
    if (!building) return undefined;
    if (building.footprint === undefined) {
      const all = [...building.pieces.values()];
      const polygons = all.flatMap((p) => p.polygons);
      const { id, properties } = all[0]!;
      building.footprint =
        mergeFootprint(
          String(id),
          id,
          polygons,
          properties,
          signatureOf(polygons),
          this.union,
          this.onError && ((_, err) => this.onError!(key, err)),
        ) ?? null;
    }
    return building.footprint ?? undefined;
  }
}
