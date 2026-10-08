import { describe, expect, it } from 'vitest';
import type { Catalogue } from '../../src/landmarks/catalogue';
import {
  CellIndex,
  cellsForView,
  distanceM,
  entryKey,
  intersectsWrapped,
  lngLatToTile,
  padMetres,
  selectWanted,
} from '../../src/landmarks/discovery';
import { BASE, entry, rawCell } from './fixtures';
import { fakeFetch, view } from './helpers';

function cat(over: Partial<Catalogue> = {}): Catalogue {
  return {
    release: 'r1',
    bounds: [2.2, 48.8, 2.4, 48.9],
    maxHeightM: 330,
    zoom: 12,
    template: '/api/v1/releases/r1/index/12/{x}/{y}.json',
    occupied: new Set(['2074/1409', '2075/1409']),
    attribution: 'Open Landmarks',
    baseUrl: BASE,
    ...over,
  };
}

describe('tiles and padding', () => {
  it('computes z12 tiles for Paris landmarks', () => {
    expect(lngLatToTile(2.2945, 48.8584, 12)).toEqual([2074, 1409]); // Eiffel Tower
    expect(lngLatToTile(2.2395, 48.8927, 12)).toEqual([2073, 1408]); // CNIT
  });

  it('pads more when pitched, capped at 5 km', () => {
    expect(padMetres(0, 330)).toBe(200);
    expect(padMetres(60, 330)).toBeCloseTo(200 + 330 * Math.tan(Math.PI / 3), 6);
    expect(padMetres(89, 1e6)).toBe(5000);
  });

  it('measures great-circle distance', () => {
    expect(distanceM([0, 0], [0, 1])).toBeCloseTo(111195, -1);
  });

  it('intersects across the antimeridian', () => {
    expect(intersectsWrapped([179, -1, 181, 1], [-180, -1, -179.5, 1])).toBe(true);
    expect(intersectsWrapped([10, 10, 11, 11], [12, 12, 13, 13])).toBe(false);
  });
});

describe('cellsForView', () => {
  it('returns occupied cells around the view', () => {
    expect(cellsForView(view(), cat())).toEqual(['2074/1409']);
  });

  it('returns nothing far from the catalogue', () => {
    expect(
      cellsForView(view({ bounds: [-74.02, 40.7, -73.98, 40.72], center: [-74, 40.71] }), cat()),
    ).toEqual([]);
  });

  it('wraps x across the antimeridian with unwrapped longitudes', () => {
    const world = cat({
      bounds: [-180, -85, 180, 85],
      occupied: new Set(['4090/2047', '5/2047', '2000/2047']),
    });
    const v = view({ bounds: [179, -1, 181, 1], center: [180, 0] });
    expect(cellsForView(v, world)).toEqual(['4090/2047', '5/2047']);
  });

  it('does not loop over every cell when zoomed far out', () => {
    const v = view({ bounds: [-540, -85, 540, 85], center: [0, 0], zoom: 0 });
    const world = cat({ bounds: [-180, -85, 180, 85] });
    expect(cellsForView(v, world)).toEqual(['2074/1409', '2075/1409']);
  });
});

describe('selectWanted', () => {
  it('waits for a zoom floor such as the replaced extrusions starting', () => {
    const e = entry('a', { minZoom: 15 });
    expect(selectWanted([e], view({ zoom: 15.5 }), cat(), 8, 16)).toEqual([]);
    expect(selectWanted([e], view({ zoom: 16 }), cat(), 8, 16)).toHaveLength(1);
    expect(selectWanted([e], view({ zoom: 14.5 }), cat(), 8, 14)).toEqual([]); // own minZoom wins
  });

  const near = entry('near');
  const far = entry('far', { anchor: [2.3, 48.86], bounds: [2.299, 48.859, 2.301, 48.861] });
  const late = entry('late', { minZoom: 18 });

  it('filters by minZoom and sorts by distance', () => {
    const wanted = selectWanted([far, late, near], view(), cat(), 8);
    expect(wanted.map((w) => w.entry.id)).toEqual(['near', 'far']);
    expect(wanted[0]!.key).toBe(entryKey(near));
    expect(wanted[0]!.lod).toBe('low');
  });

  it('caps at maxResident and picks the detail LOD at detailZoom', () => {
    const wanted = selectWanted([far, near], view({ zoom: 17 }), cat(), 1);
    expect(wanted.map((w) => w.entry.id)).toEqual(['near']);
    expect(wanted[0]!.lod).toBe('detail');
  });

  it('drops entries outside the padded view', () => {
    const away = entry('away', { anchor: [2.39, 48.89], bounds: [2.389, 48.889, 2.391, 48.891] });
    expect(selectWanted([away], view(), cat(), 8)).toEqual([]);
  });
});

describe('CellIndex', () => {
  const cellA = `${BASE}/api/v1/releases/r1/index/12/2074/1409.json`;
  const cellB = `${BASE}/api/v1/releases/r1/index/12/2075/1409.json`;

  it('merges cells and de-duplicates by id + revision', async () => {
    const shared = entry('shared');
    const f = fakeFetch({ [cellA]: rawCell([shared, entry('a')]), [cellB]: rawCell([shared]) });
    const entries = await new CellIndex(cat(), f).entries(['2074/1409', '2075/1409']);
    expect(entries.map((e) => e.id).sort()).toEqual(['a', 'shared']);
  });

  it('caches cells, including 404s', async () => {
    const f = fakeFetch({ [cellA]: rawCell([entry('a')]) });
    const index = new CellIndex(cat(), f);
    await index.entries(['2074/1409', '2075/1409']);
    await index.entries(['2074/1409', '2075/1409']);
    expect(f.calls).toHaveLength(2);
  });

  it('does not cache failures', async () => {
    const f = fakeFetch({ [cellA]: 500 });
    const index = new CellIndex(cat(), f);
    await expect(index.entries(['2074/1409'])).rejects.toThrow('HTTP 500');
    f.routes[cellA] = rawCell([entry('a')]);
    expect((await index.entries(['2074/1409'])).map((e) => e.id)).toEqual(['a']);
  });
});
