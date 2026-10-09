import { expect, test, type Page } from '@playwright/test';
import type {} from '../../demo/e2e-trees';

/** Share of green-dominant pixels and mean luminance of non-white pixels. */
const sample = (page: Page) =>
  page.evaluate(() => {
    const src = window.__map!.getCanvas();
    const c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(src, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let green = 0;
    let lum = 0;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const [r, g, b] = [d[i]!, d[i + 1]!, d[i + 2]!];
      if (r > 245 && g > 245 && b > 245) continue;
      n++;
      lum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (g > r + 8 && g > b + 8) green++;
    }
    return { green: green / (d.length / 4), lum: n ? lum / n : 255 };
  });

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

/** Frames rendered during `ms` (MapLibre fires `idle` even while a custom layer animates). */
const framesWithin = (page: Page, ms: number) =>
  page.evaluate(
    (t) =>
      new Promise<number>((resolve) => {
        const map = window.__map!;
        let n = 0;
        const count = () => n++;
        map.on('render', count);
        setTimeout(() => {
          map.off('render', count);
          resolve(n);
        }, t);
      }),
    ms,
  );

test('draws mapped and scattered trees, animates wind and follows the theme', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  await page.goto('/e2e-trees.html');
  await page.waitForFunction(() => (window.__trees?.getStats().drawn ?? 0) > 0, null, {
    timeout: 30_000,
  });

  const stats = await page.evaluate(() => window.__stats());
  expect(stats.mapped).toBe(50);
  // Counted per tile piece: each polygon here spans four tiles.
  expect(stats.polygonsFilled).toBe(4); // park: no mapped trees
  expect(stats.polygonsSkipped).toBe(4); // forest: already full of mapped trees
  expect(stats.scattered).toBeGreaterThan(8);
  expect(stats.drawn).toBe(stats.mapped + stats.scattered);

  const day = await sample(page);
  expect(day.green).toBeGreaterThan(0.005);

  // Wind keeps frames coming; calm stops the repaint loop.
  expect(await framesWithin(page, 1000)).toBeGreaterThan(10);
  await page.evaluate(() => window.__setWind(0));
  await idleWithin(page, 3000);
  expect(await framesWithin(page, 1000)).toBeLessThan(3);

  await page.evaluate(() => window.__setTheme('night'));
  await idleWithin(page, 3000);
  const night = await sample(page);
  expect(night.lum).toBeLessThan(day.lum * 0.8);
  // Still readable at night (review #2): tree pixels must not collapse to near-black.
  expect(night.lum).toBeGreaterThan(35);

  expect(await page.evaluate(() => window.__errors)).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
