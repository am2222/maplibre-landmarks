import { expect, test } from '@playwright/test';
import type {} from '../../demo/e2e';

// Layers build each tile once through MapLibre internals (the tile in `sourcedata` events, the
// source's tile manager). This fails loudly when a MapLibre upgrade changes them: the layers
// would still work, through the slow fallback.
test.use({ viewport: { width: 640, height: 400 } });
test.describe.configure({ timeout: 120_000 });

const LNG = 2.2945;
const LAT = 48.8584;
const square = (d: number) => [
  [LNG - d, LAT - d],
  [LNG + d, LAT - d],
  [LNG + d, LAT + d],
  [LNG - d, LAT + d],
  [LNG - d, LAT - d],
];
const TARGET = {
  anchor: [LNG, LAT],
  footprint: { type: 'Polygon', coordinates: [square(0.0002)] },
  neighbour: { type: 'Polygon', coordinates: [square(0.0001)] },
};

test('tiles arrive one by one from MapLibre, and the feed holds what MapLibre renders', async ({
  page,
}) => {
  await page.route('https://open-landmarks.benmaps.fr/**', (r) => r.abort());
  await page.goto('/e2e.html');
  await page.evaluate((t) => window.__start(t as never, { landmarks: false }), TARGET);
  await page.waitForFunction(() => window.__map?.loaded(), null, { timeout: 20_000 });
  await page.evaluate(
    (c) => window.__map!.jumpTo({ center: c as [number, number], zoom: 16, pitch: 0, bearing: 0 }),
    [LNG, LAT],
  );
  // A large lake: every tile in view has a piece of it.
  await page.evaluate(
    (ring) =>
      window.__addWater({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { kind: 'water', kind_detail: 'lake' },
            geometry: { type: 'Polygon', coordinates: [ring] },
          },
        ],
      }),
    square(0.05),
  );
  await page.evaluate(() => window.__followTiles('w'));
  await page.waitForFunction(() => window.__map!.loaded(), null, { timeout: 20_000 });
  // Move: new tiles load and are announced one by one.
  await page.evaluate(
    (c) => window.__map!.jumpTo({ center: c as [number, number], zoom: 17 }),
    [LNG + 0.01, LAT],
  );
  await page.waitForFunction(() => (window.__tiles?.arrivals.length ?? 0) > 0, null, {
    timeout: 20_000,
  });
  await page.waitForFunction(() => window.__map!.loaded(), null, { timeout: 20_000 });
  expect(await page.evaluate(() => window.__tiles!.fastPath())).toBe(true);
  const near = await page.evaluate(() => window.__tiles!.settle());
  expect(near.length).toBeGreaterThan(0);
  expect(near.every((k) => k.startsWith('17/'))).toBe(true);
  // Zoom out: the feed follows the tile manager, so the z17 tiles go.
  await page.evaluate(() => window.__map!.jumpTo({ zoom: 13 }));
  await page.waitForFunction(() => window.__map!.loaded(), null, { timeout: 20_000 });
  const far = await page.evaluate(() => window.__tiles!.settle());
  expect(far.length).toBeGreaterThan(0);
  expect(far.every((k) => k.startsWith('13/'))).toBe(true);
  expect(await page.evaluate(() => window.__state.errors)).toEqual([]);
});
