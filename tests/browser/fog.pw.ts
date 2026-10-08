import { expect, test, type Page } from '@playwright/test';
import type {} from '../../demo/e2e';

// CI runners render WebGL in software (SwiftShader) on a few cores: full-screen water and fog
// shaders take seconds per frame there, so draw a smaller canvas and allow more time.
test.use({ viewport: { width: 640, height: 400 } });
test.describe.configure({ timeout: 180_000 });

/**
 * A fixed scene (no Open Landmarks API: fog does not need models, and the API rate-limits test
 * runs): a 30 m square footprint and the red flat neighbour 70 m east of it.
 */
const square = (lng: number, lat: number, m: number) => {
  const dx = m / (111_195 * Math.cos((lat * Math.PI) / 180));
  const dy = m / 111_195;
  return {
    type: 'Polygon',
    coordinates: [
      [
        [lng, lat],
        [lng + dx, lat],
        [lng + dx, lat + dy],
        [lng, lat + dy],
        [lng, lat],
      ],
    ],
  };
};
const TARGET = {
  anchor: [2.2945, 48.8584] as [number, number],
  footprint: square(2.2945, 48.8584, 30),
  neighbour: square(2.2945 + 70 / (111_195 * Math.cos((48.8584 * Math.PI) / 180)), 48.8584, 30),
};

async function start(page: Page) {
  await page.goto('/e2e.html');
  await page.evaluate((t) => window.__start(t as never, { landmarks: false }), TARGET);
  await page.waitForFunction(() => window.__map?.loaded(), null, { timeout: 20_000 });
  await page.waitForTimeout(500);
}

/** Share of canvas pixels in the lower half that are clearly magenta (the test fog colour). */
const magenta = (page: Page) =>
  page.evaluate(() => {
    const src = window.__map!.getCanvas();
    const c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(src, 0, 0);
    const d = ctx.getImageData(0, c.height / 2, c.width, c.height / 2).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i]! > d[i + 1]! + 30 && d[i + 2]! > d[i + 1]! + 30) n++;
    }
    return n / (d.length / 4);
  });

/** Share of canvas pixels that are clearly red (the e2e page's flat neighbour building). */
const red = (page: Page) =>
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
      if (d[i]! > 150 && d[i + 1]! < 110 && d[i + 2]! < 110) n++;
    return n / (d.length / 4);
  });

test('default fog leaves street-level detail visible (no fog below the ground)', async ({
  page,
}) => {
  await start(page);
  const before = await red(page);
  expect(before).toBeGreaterThan(0.0005);
  await page.evaluate(() => window.__addFog({ wind: { speed: 0 } }));
  await page.waitForTimeout(500);
  expect(await red(page)).toBeGreaterThan(before * 0.3);
});

test('fog compiles, tints the street level and gives the sky back', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await start(page);
  expect(await magenta(page)).toBeLessThan(0.001);

  await page.evaluate(() =>
    window.__addFog({ color: '#ff00ff', density: 3, height: 60, wind: { speed: 0 } }),
  );
  await page.waitForFunction(
    () =>
      (window.__map!.getSky() as Record<string, unknown> | undefined)?.['fog-color'] === '#ff00ff',
  );
  await page.waitForTimeout(500);
  expect(await magenta(page)).toBeGreaterThan(0.05);

  await page.evaluate(() => window.__map!.removeLayer('fog'));
  expect(await page.evaluate(() => window.__map!.getSky()?.['fog-color'])).toBeUndefined();
  expect(errors.filter((e) => /WebGL|shader|THREE/i.test(e))).toEqual([]);
});

/** Share of magenta pixels in the bottom tenth of the canvas. */
const magentaBottom = (page: Page) =>
  page.evaluate(() => {
    const src = window.__map!.getCanvas();
    const c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(src, 0, 0);
    const h = Math.floor(c.height / 10);
    const d = ctx.getImageData(0, c.height - h, c.width, h).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i]! > d[i + 1]! + 30 && d[i + 2]! > d[i + 1]! + 30) n++;
    }
    return n / (d.length / 4);
  });

test('covers the whole screen with an off-centre view (map padding)', async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    window.__map!.jumpTo({ padding: { top: 0, bottom: 450, left: 0, right: 0 }, pitch: 60 });
    window.__addFog({ color: '#ff00ff', density: 3, height: 60, wind: { speed: 0 } });
  });
  await page.waitForTimeout(800);
  expect(await magentaBottom(page)).toBeGreaterThan(0.3);
});

test('restores a style sky that had no fog keys', async ({ page }) => {
  await start(page);
  await page.evaluate(() => window.__map!.setSky({ 'sky-color': '#88aaff' }));
  await page.evaluate(() => window.__addFog({ wind: { speed: 0 } }));
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__map!.removeLayer('fog'));
  expect(await page.evaluate(() => window.__map!.getSky())).toEqual({
    'fog-color': '#ffffff',
    'fog-ground-blend': 0.5,
    'horizon-fog-blend': 0.8,
    'sky-color': '#88aaff',
  });
});
