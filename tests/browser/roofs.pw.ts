import { expect, test } from '@playwright/test';
import type {} from '../../demo/e2e';
import { findTarget } from './target';

const tileX = (lng: number, z: number) => ((lng + 180) / 360) * 2 ** z;

test('a building split by a tile seam gets one roof sized from its whole footprint', async ({
  page,
}) => {
  const target = await findTarget();
  const [lng0, lat0] = target.anchor;
  // A 40 m (east) × 30 m (north) building 200 m south of the landmark, centred on a z16 seam.
  const seam = (Math.round(tileX(lng0, 16)) / 2 ** 16) * 360 - 180;
  const mLng = 1 / (111320 * Math.cos((lat0 * Math.PI) / 180));
  const mLat = 1 / 110574;
  const lat = lat0 - 200 * mLat;
  const w = seam - 20 * mLng;
  const e = seam + 20 * mLng;
  const s = lat - 15 * mLat;
  const n = lat + 15 * mLat;
  const polygon = [
    [
      [w, s],
      [e, s],
      [e, n],
      [w, n],
      [w, s],
    ],
  ];

  await page.goto('/e2e.html');
  await page.evaluate((t) => window.__start(t as never), target);
  await page.waitForFunction(() => window.__state.models.length > 0, null, { timeout: 45_000 });
  await page.evaluate(
    ([c, p]) => {
      window.__map!.jumpTo({ center: c as [number, number], zoom: 16.5 });
      window.__addRoofs(p as number[][][]);
    },
    [[seam, lat], polygon],
  );

  const expected = 15 * Math.tan(Math.PI / 6); // whole footprint W = 15 m; a half alone: 10 m
  await page.waitForFunction(
    () => window.__map!.getFeatureState({ source: 'rb', id: 1 })['landmarks:roof'] !== undefined,
    null,
    { timeout: 10_000 },
  );
  const roof = await page.evaluate(
    () => window.__map!.getFeatureState({ source: 'rb', id: 1 })['landmarks:roof'] as number,
  );
  expect(roof).toBeCloseTo(expected, 0);

  await page.evaluate(() => window.__map!.removeLayer('roofs'));
  expect(
    await page.evaluate(() => window.__map!.getPaintProperty('rb-3d', 'fill-extrusion-height')),
  ).toEqual(['get', 'height']);
  expect(await page.evaluate(() => window.__state.errors)).toEqual([]);
});
