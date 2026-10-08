import type { Bounds, LngLat } from '../core/types';

export type Channel = 'latest' | 'preview';
export type Fetch = typeof fetch;
export type Lod = 'low' | 'detail';

export interface LodRef {
  url: string;
  bytes: number;
  gzip?: { url: string; bytes: number };
}

export type Footprint =
  | { type: 'Polygon'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] };

/** Basemap feature ids this model replaces, computed by Open Landmarks for a tileset snapshot. */
export interface BasemapReplacement {
  tileset: string;
  featureIds: (number | string)[];
}

export interface LandmarkEntry {
  id: string;
  revision: string;
  name?: string;
  anchor: LngLat;
  minZoom: number;
  detailZoom: number;
  bounds: Bounds;
  lods: { low: LodRef; detail: LodRef };
  replacementFootprint: Footprint | null;
  basemapReplacement: BasemapReplacement | null;
  attribution?: string;
}

export interface Catalogue {
  release: string;
  bounds: Bounds;
  maxHeightM: number;
  zoom: number;
  template: string;
  occupied: Set<string>;
  attribution: string;
  baseUrl: string;
}

export const DEFAULT_BASE_URL = 'https://open-landmarks.benmaps.fr';

/** Calls the global fetch without a `this` binding problem when stored on objects. */
export const globalFetch: Fetch = (input, init) => fetch(input, init);

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
  }
}

export function absoluteUrl(baseUrl: string, path: string): string {
  return new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).href;
}

async function getJson(fetchFn: Fetch, url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetchFn(url, { signal });
  if (!res.ok) throw new HttpError(res.status, url);
  return res.json();
}

interface RawCatalogue {
  release?: string | null;
  bounds?: Bounds;
  maxHeightM?: number;
  attribution?: string;
  index?: { zoom: number; template: string; occupied: string[] };
}

export async function resolveCatalogue(opts: {
  baseUrl?: string;
  channel?: Channel;
  catalogueUrl?: string;
  fetch?: Fetch;
  signal?: AbortSignal;
}): Promise<Catalogue | null> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const fetchFn = opts.fetch ?? globalFetch;
  let url = opts.catalogueUrl;
  if (!url) {
    const pointer = (await getJson(
      fetchFn,
      absoluteUrl(baseUrl, `/api/v1/${opts.channel ?? 'latest'}.json`),
      opts.signal,
    )) as { catalogue?: string | null };
    if (!pointer.catalogue) return null;
    url = pointer.catalogue;
  }
  const raw = (await getJson(fetchFn, absoluteUrl(baseUrl, url), opts.signal)) as RawCatalogue;
  if (!raw.release || !raw.index) return null;
  return {
    release: raw.release,
    bounds: raw.bounds ?? [-180, -85.0511, 180, 85.0511],
    maxHeightM: raw.maxHeightM ?? 0,
    zoom: raw.index.zoom,
    template: raw.index.template,
    occupied: new Set(raw.index.occupied),
    attribution: raw.attribution ?? 'Open Landmarks; © OpenStreetMap contributors',
    baseUrl,
  };
}

export function cellUrl(cat: Catalogue, x: number, y: number): string {
  return absoluteUrl(cat.baseUrl, cat.template.replace('{x}', String(x)).replace('{y}', String(y)));
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPair = (v: unknown): v is LngLat => Array.isArray(v) && v.length === 2 && v.every(isNum);
const isBounds = (v: unknown): v is Bounds => Array.isArray(v) && v.length === 4 && v.every(isNum);

function parseLod(v: unknown): LodRef | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { url?: unknown; bytes?: unknown; gzip?: { url?: unknown; bytes?: unknown } };
  if (typeof o.url !== 'string') return null;
  const lod: LodRef = { url: o.url, bytes: isNum(o.bytes) ? o.bytes : 0 };
  if (o.gzip && typeof o.gzip.url === 'string') {
    lod.gzip = { url: o.gzip.url, bytes: isNum(o.gzip.bytes) ? o.gzip.bytes : 0 };
  }
  return lod;
}

function parseFootprint(v: unknown): Footprint | null {
  if (!v || typeof v !== 'object') return null;
  const g = v as { type?: unknown; coordinates?: unknown };
  if ((g.type === 'Polygon' || g.type === 'MultiPolygon') && Array.isArray(g.coordinates)) {
    return g as Footprint;
  }
  return null;
}

function parseBasemapReplacement(v: unknown): BasemapReplacement | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { tileset?: unknown; featureIds?: unknown };
  if (!Array.isArray(o.featureIds)) return null;
  const featureIds = o.featureIds.filter(
    (id): id is number | string => isNum(id) || typeof id === 'string',
  );
  return { tileset: typeof o.tileset === 'string' ? o.tileset : '', featureIds };
}

export function parseEntry(raw: unknown): LandmarkEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const lods = (r.lods ?? {}) as Record<string, unknown>;
  const low = parseLod(lods.low);
  const detail = parseLod(lods.detail) ?? low;
  if (typeof r.id !== 'string' || typeof r.revision !== 'string' || !isPair(r.anchor)) return null;
  if (!low || !detail) return null;
  const anchor = r.anchor;
  return {
    id: r.id,
    revision: r.revision,
    name: typeof r.name === 'string' ? r.name : undefined,
    anchor,
    minZoom: isNum(r.minZoom) ? r.minZoom : 15,
    detailZoom: isNum(r.detailZoom) ? r.detailZoom : 17,
    bounds: isBounds(r.bounds) ? r.bounds : [anchor[0], anchor[1], anchor[0], anchor[1]],
    lods: { low, detail },
    replacementFootprint: parseFootprint(r.replacementFootprint),
    basemapReplacement: parseBasemapReplacement(r.basemapReplacement),
    attribution: typeof r.attribution === 'string' ? r.attribution : undefined,
  };
}
