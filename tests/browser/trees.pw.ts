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
    let warm = 0;
    let lum = 0;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const [r, g, b] = [d[i]!, d[i + 1]!, d[i + 2]!];
      if (r > 245 && g > 245 && b > 245) continue;
      n++;
      lum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (g > r + 8 && g > b + 8) green++;
      if (r > g + 15 && r > b + 40) warm++;
    }
    const px = d.length / 4;
    return { green: green / px, warm: warm / px, lum: n ? lum / n : 255 };
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

  await page.waitForTimeout(800); // new trees rise from the ground over riseMs (400 ms)
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

test('turns trees through the seasons: autumn colours, then bare in winter', async ({ page }) => {
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
  const summer = await sample(page);

  await page.evaluate(() => window.__trees!.setSeason('autumn', { durationMs: 0 }));
  await idleWithin(page, 3000);
  const autumn = await sample(page);
  expect(autumn.warm).toBeGreaterThan(summer.warm + 0.002);
  expect(autumn.green).toBeLessThan(summer.green * 0.7);

  // Bare and snowless: only the conifers stay green.
  await page.evaluate(() => {
    window.__trees!.setSnow(false);
    window.__trees!.setSeason('winter', { durationMs: 0 });
  });
  await idleWithin(page, 3000);
  const winter = await sample(page);
  expect(winter.green).toBeLessThan(summer.green * 0.6);

  expect(await page.evaluate(() => window.__errors)).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

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

test('rain darkens the scene and lightning lights it up', async ({ page }) => {
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
  const dry = await meanLum(page);

  await page.evaluate(() => window.__addRain());
  await page.waitForFunction(() => (window.__rain?.getStats().drops ?? 0) > 0);
  await page.waitForTimeout(300);
  expect(await meanLum(page)).toBeLessThan(dry * 0.8);

  // Hold the flash up for the sample: strike, then sample within its first flicker.
  const flash = await page.evaluate(async () => {
    window.__rain!.strike(false);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return window.__rain!.getStats().flash;
  });
  expect(flash).toBeGreaterThan(0.3);

  expect(await page.evaluate(() => window.__errors)).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('snow falls and hazes the scene without errors', async ({ page }) => {
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
  const clear = await sample(page);
  await page.evaluate(() => window.__addSnow());
  await page.waitForFunction(() => (window.__snow?.getStats().flakes ?? 0) > 0);
  await page.waitForTimeout(300);
  const snowy = await sample(page);
  // The pale haze washes out the trees' green.
  expect(snowy.green).toBeLessThan(clear.green);
  expect(await page.evaluate(() => window.__snow!.getStats().cover)).toBe(1);
  expect(await page.evaluate(() => window.__errors)).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
