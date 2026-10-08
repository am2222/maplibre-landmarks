import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  absoluteUrl,
  cellUrl,
  HttpError,
  parseEntry,
  resolveCatalogue,
} from '../../src/landmarks/catalogue';
import { BASE, CATALOGUE, POINTER } from './fixtures';
import { fakeFetch } from './helpers';

const realCell = JSON.parse(
  readFileSync(new URL('../fixtures/cell-2073-1408.json', import.meta.url), 'utf8'),
) as { assets: unknown[] };

describe('resolveCatalogue', () => {
  it('follows the channel pointer to the catalogue', async () => {
    const f = fakeFetch({
      [`${BASE}/api/v1/latest.json`]: POINTER,
      [`${BASE}/api/v1/releases/r1/catalogue.json`]: CATALOGUE,
    });
    const cat = await resolveCatalogue({ baseUrl: BASE, fetch: f });
    expect(cat).not.toBeNull();
    expect(cat!.release).toBe('r1');
    expect(cat!.zoom).toBe(12);
    expect(cat!.maxHeightM).toBe(330);
    expect(cat!.occupied.has('2074/1409')).toBe(true);
    expect(cat!.baseUrl).toBe(BASE);
    expect(cat!.attribution).toContain('OpenStreetMap');
  });

  it('uses the preview channel when asked', async () => {
    const f = fakeFetch({
      [`${BASE}/api/v1/preview.json`]: POINTER,
      [`${BASE}/api/v1/releases/r1/catalogue.json`]: CATALOGUE,
    });
    await resolveCatalogue({ baseUrl: BASE, channel: 'preview', fetch: f });
    expect(f.calls[0]).toBe(`${BASE}/api/v1/preview.json`);
  });

  it('returns null when nothing is published', async () => {
    const f = fakeFetch({
      [`${BASE}/api/v1/latest.json`]: { ...POINTER, release: null, catalogue: null, count: 0 },
    });
    expect(await resolveCatalogue({ baseUrl: BASE, fetch: f })).toBeNull();
    expect(f.calls).toHaveLength(1);
  });

  it('skips the pointer when a catalogue URL is pinned', async () => {
    const f = fakeFetch({ [`${BASE}/api/v1/releases/r1/catalogue.json`]: CATALOGUE });
    const cat = await resolveCatalogue({
      baseUrl: BASE,
      catalogueUrl: '/api/v1/releases/r1/catalogue.json',
      fetch: f,
    });
    expect(cat!.release).toBe('r1');
    expect(f.calls).toEqual([`${BASE}/api/v1/releases/r1/catalogue.json`]);
  });

  it('rejects with HttpError on server errors', async () => {
    const f = fakeFetch({ [`${BASE}/api/v1/latest.json`]: 500 });
    await expect(resolveCatalogue({ baseUrl: BASE, fetch: f })).rejects.toBeInstanceOf(HttpError);
  });
});

describe('parseEntry', () => {
  it('parses every entry of a recorded live cell', () => {
    const entries = realCell.assets.map(parseEntry);
    expect(entries.every((e) => e !== null)).toBe(true);
    const cnit = entries.find((e) => e!.id === 'cnit')!;
    expect(cnit.anchor).toHaveLength(2);
    expect(cnit.bounds).toHaveLength(4);
    expect(cnit.lods.low.gzip?.url).toMatch(/low\.glb\.gz$/);
    expect(cnit.replacementFootprint?.type).toMatch(/Polygon/);
    expect(typeof cnit.revision).toBe('string');
  });

  it('parses the basemap replacement feature ids', () => {
    const e = parseEntry({
      id: 'x',
      revision: 'r',
      anchor: [1, 2],
      lods: { low: { url: '/a.glb' } },
      basemapReplacement: { tileset: 'protomaps-20260911', featureIds: [35184377102196, 7] },
    });
    expect(e!.basemapReplacement).toEqual({
      tileset: 'protomaps-20260911',
      featureIds: [35184377102196, 7],
    });
    const none = parseEntry({
      id: 'x',
      revision: 'r',
      anchor: [1, 2],
      lods: { low: { url: '/a' } },
    });
    expect(none!.basemapReplacement).toBeNull();
  });

  it('rejects entries without id, revision, anchor or lods', () => {
    expect(parseEntry(null)).toBeNull();
    expect(parseEntry({ id: 'x', revision: 'r', lods: { low: { url: '/a' } } })).toBeNull();
    expect(parseEntry({ id: 'x', revision: 'r', anchor: [1, 2], lods: {} })).toBeNull();
  });

  it('falls back to the low LOD and default zooms', () => {
    const e = parseEntry({
      id: 'x',
      revision: 'r',
      anchor: [1, 2],
      lods: { low: { url: '/a.glb' } },
    });
    expect(e!.lods.detail.url).toBe('/a.glb');
    expect(e!.minZoom).toBe(15);
    expect(e!.detailZoom).toBe(17);
    expect(e!.bounds).toEqual([1, 2, 1, 2]);
    expect(e!.replacementFootprint).toBeNull();
  });
});

describe('urls', () => {
  it('resolves root-relative paths against the base', () => {
    expect(absoluteUrl(BASE, '/models/a.glb')).toBe(`${BASE}/models/a.glb`);
    expect(absoluteUrl('https://x.test/', '/a')).toBe('https://x.test/a');
  });

  it('fills the cell template', async () => {
    const f = fakeFetch({
      [`${BASE}/api/v1/latest.json`]: POINTER,
      [`${BASE}/api/v1/releases/r1/catalogue.json`]: CATALOGUE,
    });
    const cat = (await resolveCatalogue({ baseUrl: BASE, fetch: f }))!;
    expect(cellUrl(cat, 2074, 1409)).toBe(`${BASE}/api/v1/releases/r1/index/12/2074/1409.json`);
  });
});
