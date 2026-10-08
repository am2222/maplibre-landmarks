import type { LandmarkEntry } from '../../src/landmarks/catalogue';

export const BASE = 'https://ol.test';

export const POINTER = {
  schemaVersion: 1,
  channel: 'approved',
  release: 'r1',
  count: 2,
  catalogue: '/api/v1/releases/r1/catalogue.json',
};

export const CATALOGUE = {
  schemaVersion: 1,
  release: 'r1',
  bounds: [2.2, 48.8, 2.4, 48.9],
  maxHeightM: 330,
  attribution: 'Open Landmarks; © OpenStreetMap contributors',
  index: {
    zoom: 12,
    template: '/api/v1/releases/r1/index/12/{x}/{y}.json',
    occupied: ['2074/1409', '2075/1409'],
  },
};

export function entry(id: string, over: Partial<LandmarkEntry> = {}): LandmarkEntry {
  return {
    id,
    revision: `${id}-r1`,
    name: id,
    anchor: [2.2945, 48.8584],
    minZoom: 15,
    detailZoom: 17,
    bounds: [2.2935, 48.8574, 2.2955, 48.8594],
    lods: {
      low: {
        url: `/models/${id}/low.glb`,
        bytes: 100,
        gzip: { url: `/models/${id}/low.glb.gz`, bytes: 50 },
      },
      detail: {
        url: `/models/${id}/detail.glb`,
        bytes: 200,
        gzip: { url: `/models/${id}/detail.glb.gz`, bytes: 80 },
      },
    },
    replacementFootprint: null,
    basemapReplacement: null,
    attribution: `${id} attribution`,
    ...over,
  };
}

export function rawCell(entries: LandmarkEntry[]) {
  return { schemaVersion: 1, release: 'r1', assets: entries };
}
