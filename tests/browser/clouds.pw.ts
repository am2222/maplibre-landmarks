import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type {} from '../../demo/e2e-trees';

/** The library's entry, served by the Vite dev server (the e2e page doesn't add clouds). */
const LIBRARY = `/@fs${resolve('src/index.ts')}`;

const idleWithin = (page: Page, ms: number) =>
  page.evaluate(
    (t) =>
      new Promise<boolean>((resolve) => {
        const map = window.__map!;
        const timer = setTimeout(() => resolve(false), t);
        map.once('idle', () => {
          clearTimeout(timer);
          resolve(true);
        });
        map.triggerRepaint();
      }),
    ms,
  );

/** Mean luminance of every pixel (background included). */
const meanLum = (page: Page) =>
  page.evaluate(() => {
    const src = window.__map!.getCanvas();
    const c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(src, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let lum = 0;
    for (let i = 0; i < d.length; i += 4)
      lum += 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;
    return lum / (d.length / 4);
  });

test('cloud shadows darken the map below without errors', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  await page.goto('/e2e-trees.html');
  await page.waitForFunction(() => (window.__trees?.getStats().drawn ?? 0) > 0, null, {
    timeout: 30_000,
  });
  await page.evaluate(() => window.__setWind(0));
  await page.waitForTimeout(800);
  await idleWithin(page, 3000);
  const clear = await meanLum(page);
  await page.evaluate(async (path) => {
    const { CloudsLayer } = (await import(path)) as typeof import('../../src/index');
    window.__map!.addLayer(
      new CloudsLayer({ id: 'clouds', coverage: 1, shadows: 1, wind: { speed: 0 } }),
    );
  }, LIBRARY);
  await idleWithin(page, 3000);
  // Overcast with full shadows: the whole scene darkens.
  expect(await meanLum(page)).toBeLessThan(clear * 0.85);
  expect(await page.evaluate(() => window.__errors)).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
