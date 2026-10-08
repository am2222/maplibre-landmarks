import { expect, test, type Page } from '@playwright/test';
import type {} from '../../demo/e2e';

// CI runners render WebGL in software (SwiftShader) on a few cores: full-screen water and fog
// shaders take seconds per frame there, so draw a smaller canvas and allow more time.
test.use({ viewport: { width: 640, height: 400 } });
test.describe.configure({ timeout: 180_000 });

const LNG = 2.2945;
const LAT = 48.8584;
const KX = 111_195 * Math.cos((LAT * Math.PI) / 180);
/** w × d metre rectangle ring, south-west corner (east, north) metres from LNG/LAT. */
const rect = (east: number, north: number, w: number, d: number) => {
  const [x0, y0] = [LNG + east / KX, LAT + north / 111_195];
  const [x1, y1] = [x0 + w / KX, y0 + d / 111_195];
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0],
  ];
};
const square = (east: number, north: number, m: number) => ({
  type: 'Polygon',
  coordinates: [rect(east, north, m, m)],
});
// The e2e page's fixed scene (no Open Landmarks API), far from the lake.
const TARGET = { anchor: [LNG, LAT], footprint: square(0, 0, 30), neighbour: square(70, 0, 30) };
const LAKE_CENTRE: [number, number] = [LNG - 500 / KX, LAT];
const WATER = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { kind: 'water', kind_detail: 'lake' },
      geometry: { type: 'Polygon', coordinates: [rect(-700, -200, 400, 400)] },
    },
  ],
};

async function start(page: Page) {
  // Fixed local scene: CI must not depend on the Open Landmarks API (rate limits, outages).
  await page.route('https://open-landmarks.benmaps.fr/**', (r) => r.abort());
  await page.goto('/e2e.html');
  await page.evaluate((t) => window.__start(t as never, { landmarks: false }), TARGET);
  await page.waitForFunction(() => window.__map?.loaded(), null, { timeout: 20_000 });
  await page.evaluate(
    // Zoom 18: the 400 m lake fills the view.
    (c) => window.__map!.jumpTo({ center: c, zoom: 18, pitch: 0, bearing: 0 }),
    LAKE_CENTRE,
  );
}

/** Share of canvas pixels that are clearly magenta (the test water fill). */
const magenta = (page: Page) =>
  page.evaluate(() => {
    const src = window.__map!.getCanvas();
    const c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(src, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4)
      if (d[i]! > d[i + 1]! + 60 && d[i + 2]! > d[i + 1]! + 60) n++;
    return n / (d.length / 4);
  });

/** Sum of the centre 64 × 64 pixels' channels: changes when the water animates. */
const centre = (page: Page) =>
  page.evaluate(() => {
    const src = window.__map!.getCanvas();
    const c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(src, 0, 0);
    const d = ctx.getImageData(c.width / 2 - 32, c.height / 2 - 32, 64, 64).data;
    return d.reduce((s, v) => s + v, 0);
  });

test('animated water covers the water fill, and removing it restores the fill', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await start(page);
  await page.evaluate((w) => window.__addWater(w), WATER);
  await page.waitForTimeout(1500);
  expect(await magenta(page)).toBeLessThan(0.01);
  const a = await centre(page);
  await page.waitForTimeout(700);
  const b = await centre(page);
  expect(a).not.toBe(b); // waves move
  await page.evaluate(() => window.__map!.removeLayer('water-3d'));
  await page.waitForTimeout(500);
  expect(await magenta(page)).toBeGreaterThan(0.5);
  expect(await page.evaluate(() => window.__state.errors)).toEqual([]);
  expect(errors.filter((e) => /WebGL|THREE|shader/i.test(e))).toEqual([]);
});
