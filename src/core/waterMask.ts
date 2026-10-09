import { pointInPolygons, polygonsOf } from './geometry';
import { TileFeed, type FeedMap } from './tileFeed';
import type { LngLat } from './types';

export interface WaterMaskOptions {
  source: string;
  /** Source layer with water polygons (undefined for a GeoJSON source). */
  sourceLayer?: string;
  /** Water arrived or left: decisions made from the mask may change. */
  onChange?: () => void;
  /** Tiles the layer does not need now (see TileFeed `wants`). */
  wants?: (key: string) => boolean;
}

type Polygon = number[][][];
interface Entry {
  polygon: Polygon;
  bbox: [number, number, number, number];
}

/** Grid cell for the lookup of tiles without coordinates, degrees (about 1 km). */
const CELL = 0.01;
/** Raster cells across a tile (a z15 tile: about 3 m each). */
const RASTER = 256;

const mercX = (lng: number) => (lng + 180) / 360;
const mercY = (lat: number) => {
  const r = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
};

/** A tile's water as a bitmap over the tile (rows north to south), filled once on arrival. */
function rasterise(z: number, x: number, y: number, polygons: Polygon[]): Uint8Array {
  const out = new Uint8Array(RASTER * RASTER);
  const n = 2 ** z;
  const toTile = ([lng, lat]: number[]): [number, number] => [
    (mercX(lng!) * n - x) * RASTER,
    (mercY(lat!) * n - y) * RASTER,
  ];
  const row = new Uint8Array(RASTER);
  for (const polygon of polygons) {
    const rings = polygon.map((ring) => ring.map(toTile));
    for (let r = 0; r < RASTER; r++) {
      const v = r + 0.5;
      // Even-odd fill of this polygon (holes included) along the row's centre line.
      const xs: number[] = [];
      for (const ring of rings)
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [xi, yi] = ring[i]!;
          const [xj, yj] = ring[j]!;
          if (yi > v !== yj > v) xs.push(xi + ((v - yi) * (xj - xi)) / (yj - yi));
        }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      row.fill(0);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const from = Math.max(0, Math.ceil(xs[k]! - 0.5));
        const to = Math.min(RASTER - 1, Math.floor(xs[k + 1]! - 0.5));
        for (let c = from; c <= to; c++) row[c] = 1;
      }
      const offset = r * RASTER;
      for (let c = 0; c < RASTER; c++) if (row[c]) out[offset + c] = 1;
    }
  }
  return out;
}

/**
 * Water polygons of the held tiles, to keep things that stand on the ground (scattered trees,
 * poles placed on line vertices) out of lakes and rivers.
 */
export class WaterMask {
  private readonly feed: TileFeed;
  /** Tiles without coordinates (the fallback's pseudo-tile): their polygons. */
  private readonly tiles = new Map<string, Entry[]>();
  /** Tiles with coordinates: their water as a bitmap (null: no water), by zoom then x·2^z + y. */
  private readonly rasters = new Map<number, Map<number, Uint8Array | null>>();
  private grid?: Map<string, Entry[]>;
  /** Zooms of the rasters held, deepest first. */
  private zooms: number[] = [];

  constructor(
    map: FeedMap,
    private readonly options: WaterMaskOptions,
  ) {
    this.feed = new TileFeed(map, {
      source: options.source,
      ...(options.sourceLayer ? { sourceLayer: options.sourceLayer } : {}),
      filter: ['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]],
      ...(options.wants ? { wants: options.wants } : {}),
      onTile: (key, features) => {
        const polygons = features.flatMap((f) => polygonsOf(f.geometry));
        const [z, x, y] = key.split('/').map(Number);
        if (key !== '*' && z !== undefined && x !== undefined && y !== undefined) {
          let byZoom = this.rasters.get(z);
          if (!byZoom) this.rasters.set(z, (byZoom = new Map()));
          const raster = polygons.length ? rasterise(z, x, y, polygons) : null;
          byZoom.set(x * 2 ** z + y, raster && raster.includes(1) ? raster : null);
        } else {
          this.tiles.set(
            key,
            polygons.map((polygon) => ({ polygon, bbox: bboxOf(polygon) })),
          );
        }
        this.changed();
      },
      onDrop: (key) => {
        const [z, x, y] = key.split('/').map(Number);
        const dropped = this.tiles.delete(key) || !!this.rasters.get(z!)?.delete(x! * 2 ** z! + y!);
        if (dropped) this.changed();
      },
    });
  }

  settle(): void {
    this.feed.settle();
  }

  suspend(): void {
    this.feed.suspend();
  }

  reset(): void {
    this.feed.reset();
  }

  dispose(): void {
    this.feed.dispose();
    this.tiles.clear();
    this.rasters.clear();
    this.zooms = [];
    this.grid = undefined;
  }

  /** True when the point lies in water (islands excluded). */
  contains(p: LngLat): boolean {
    // The deepest held tile over the point answers, from its raster.
    if (this.zooms.length) {
      const [mx, my] = [mercX(p[0]), mercY(p[1])];
      for (const z of this.zooms) {
        const n = 2 ** z;
        const fx = mx * n;
        const fy = my * n;
        const raster = this.rasters.get(z)!.get(Math.floor(fx) * n + Math.floor(fy));
        if (raster === undefined) continue; // no tile here at this zoom
        if (raster === null) return false; // a dry tile
        const c = Math.min(RASTER - 1, Math.floor((fx - Math.floor(fx)) * RASTER));
        const r = Math.min(RASTER - 1, Math.floor((fy - Math.floor(fy)) * RASTER));
        return raster[r * RASTER + c] === 1;
      }
    }
    const near = this.index().get(cellKey(p[0], p[1]));
    if (!near) return false;
    for (const { polygon, bbox } of near) {
      if (p[0] < bbox[0] || p[0] > bbox[2] || p[1] < bbox[1] || p[1] > bbox[3]) continue;
      if (pointInPolygons(p, [polygon])) return true;
    }
    return false;
  }

  private changed(): void {
    this.grid = undefined;
    this.zooms = [...this.rasters]
      .filter(([, tiles]) => tiles.size)
      .map(([z]) => z)
      .sort((a, b) => b - a);
    this.options.onChange?.();
  }

  private index(): Map<string, Entry[]> {
    if (this.grid) return this.grid;
    const grid = new Map<string, Entry[]>();
    for (const entries of this.tiles.values())
      for (const e of entries) {
        const [x0, y0, x1, y1] = e.bbox;
        for (let x = Math.floor(x0 / CELL); x <= Math.floor(x1 / CELL); x++)
          for (let y = Math.floor(y0 / CELL); y <= Math.floor(y1 / CELL); y++) {
            const k = `${x},${y}`;
            const list = grid.get(k);
            if (list) list.push(e);
            else grid.set(k, [e]);
          }
      }
    return (this.grid = grid);
  }
}

const cellKey = (x: number, y: number) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;

function bboxOf(polygon: Polygon): [number, number, number, number] {
  const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of polygon[0] ?? []) {
    b[0] = Math.min(b[0], x!);
    b[1] = Math.min(b[1], y!);
    b[2] = Math.max(b[2], x!);
    b[3] = Math.max(b[3], y!);
  }
  return b;
}
