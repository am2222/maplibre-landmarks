const BASE = 'https://open-landmarks.benmaps.fr';
const M_PER_DEG = 111_195;

async function json<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  return (await res.json()) as T;
}

interface Asset {
  anchor: [number, number];
  bounds: [number, number, number, number];
  replacementFootprint: { type: string; coordinates: unknown } | null;
}

/** First approved landmark with a footprint, plus a 30 m neighbour square 40 m east of its bounds. */
export async function findTarget() {
  const ptr = await json<{ catalogue: string | null }>('/api/v1/latest.json');
  if (!ptr.catalogue) throw new Error('latest channel has no release');
  const cat = await json<{ index: { template: string; occupied: string[] } }>(ptr.catalogue);
  for (const cell of cat.index.occupied) {
    const [x, y] = cell.split('/');
    const body = await json<{ assets: Asset[] }>(
      cat.index.template.replace('{x}', x!).replace('{y}', y!),
    );
    const a = body.assets.find((e) => e.replacementFootprint);
    if (!a) continue;
    const lat = a.anchor[1];
    const kx = M_PER_DEG * Math.cos((lat * Math.PI) / 180);
    const w = a.bounds[2] + 40 / kx;
    const e = w + 30 / kx;
    const s = lat - 15 / M_PER_DEG;
    const n = lat + 15 / M_PER_DEG;
    return {
      anchor: a.anchor,
      footprint: a.replacementFootprint,
      neighbour: {
        type: 'Polygon',
        coordinates: [
          [
            [w, s],
            [e, s],
            [e, n],
            [w, n],
            [w, s],
          ],
        ],
      },
    };
  }
  throw new Error('no approved landmark with a replacement footprint');
}
