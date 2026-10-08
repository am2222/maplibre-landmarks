import { EARTH_RADIUS_M } from '../core/mercator';
import type { Bounds, LngLat, ViewState } from '../core/types';
import {
  cellUrl,
  HttpError,
  parseEntry,
  type Catalogue,
  type Fetch,
  type LandmarkEntry,
  type Lod,
} from './catalogue';

const MAX_LAT = 85.0511;
const METRES_PER_DEG = (2 * Math.PI * EARTH_RADIUS_M) / 360;

export function lngLatToTile(lng: number, lat: number, z: number): [number, number] {
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n); // not wrapped: callers wrap
  const r = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  return [x, Math.max(0, Math.min(n - 1, y))];
}

export function padMetres(pitch: number, maxHeightM: number): number {
  const p = (Math.min(pitch, 85) * Math.PI) / 180;
  return Math.min(5000, 200 + maxHeightM * Math.tan(p));
}

export function padBounds([w, s, e, n]: Bounds, padM: number): Bounds {
  const dLat = padM / METRES_PER_DEG;
  const midLat = ((s + n) / 2) * (Math.PI / 180);
  const dLng = padM / (METRES_PER_DEG * Math.max(0.01, Math.cos(midLat)));
  return [w - dLng, Math.max(-MAX_LAT, s - dLat), e + dLng, Math.min(MAX_LAT, n + dLat)];
}

function intersects(a: Bounds, b: Bounds): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/** `a` may hold unwrapped longitudes (MapLibre bounds); `b` is in [-180, 180]. */
export function intersectsWrapped(a: Bounds, b: Bounds): boolean {
  return [-360, 0, 360].some((o) => intersects(a, [b[0] + o, b[1], b[2] + o, b[3]]));
}

export function cellsForView(view: ViewState, cat: Catalogue): string[] {
  const padded = padBounds(view.bounds, padMetres(view.pitch, cat.maxHeightM));
  if (!intersectsWrapped(padded, cat.bounds)) return [];
  const n = 2 ** cat.zoom;
  const [x0, y0] = lngLatToTile(padded[0], padded[3], cat.zoom);
  const [x1, y1] = lngLatToTile(padded[2], padded[1], cat.zoom);
  const span = x1 - x0;
  const out: string[] = [];
  // Iterate the (small) occupied set instead of the view's cells.
  for (const key of cat.occupied) {
    const [xs, ys] = key.split('/');
    const x = Number(xs);
    const y = Number(ys);
    if (y < y0 || y > y1) continue;
    const dx = (((x - x0) % n) + n) % n;
    if (span >= n - 1 || dx <= span) out.push(key);
  }
  return out.sort();
}

export function distanceM([lng1, lat1]: LngLat, [lng2, lat2]: LngLat): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const entryKey = (e: LandmarkEntry): string => `${e.id}@${e.revision}`;

export interface Wanted {
  key: string;
  entry: LandmarkEntry;
  lod: Lod;
}

export function selectWanted(
  entries: LandmarkEntry[],
  view: ViewState,
  cat: Catalogue,
  maxResident: number,
  /** Never show models below this zoom (e.g. where the extrusions they replace start). */
  minZoom = 0,
): Wanted[] {
  const padded = padBounds(view.bounds, padMetres(view.pitch, cat.maxHeightM));
  return entries
    .filter((e) => view.zoom >= Math.max(e.minZoom, minZoom) && intersectsWrapped(padded, e.bounds))
    .map((e) => ({ e, d: distanceM(view.center, e.anchor) }))
    .sort((a, b) => a.d - b.d || a.e.id.localeCompare(b.e.id))
    .slice(0, maxResident)
    .map(({ e }) => ({
      key: entryKey(e),
      entry: e,
      lod: view.zoom >= e.detailZoom ? 'detail' : 'low',
    }));
}

export class CellIndex {
  private readonly cache = new Map<string, Promise<LandmarkEntry[]>>();

  constructor(
    private readonly cat: Catalogue,
    private readonly fetchFn: Fetch,
  ) {}

  async entries(cells: string[]): Promise<LandmarkEntry[]> {
    const lists = await Promise.all(cells.map((c) => this.cell(c)));
    const seen = new Map<string, LandmarkEntry>();
    for (const list of lists) for (const e of list) seen.set(entryKey(e), e);
    return [...seen.values()];
  }

  private cell(key: string): Promise<LandmarkEntry[]> {
    const cached = this.cache.get(key);
    if (cached) return cached;
    const [x, y] = key.split('/').map(Number) as [number, number];
    const url = cellUrl(this.cat, x, y);
    const p = this.fetchFn(url).then(async (res) => {
      if (res.status === 404) return [];
      if (!res.ok) throw new HttpError(res.status, url);
      const body = (await res.json()) as { assets?: unknown[] };
      return (body.assets ?? []).map(parseEntry).filter((e): e is LandmarkEntry => e !== null);
    });
    this.cache.set(key, p);
    p.catch(() => this.cache.delete(key));
    return p;
  }
}
