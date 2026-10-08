import { expect, test, type Page } from '@playwright/test';
import type {} from '../../demo/e2e'; // brings window.__start / __state / __map types
import { findTarget } from './target';

const LEGACY_FILTER = ['in', 'kind', 'building', 'building_part'];

/** Whether a test building is fully handed over (1 = landmark footprint, 2 = neighbour). */
const hidden = (page: Page, id: number) =>
  page.evaluate(
    (i) => window.__map!.getFeatureState({ source: 'b', id: i })['landmarks:fade'] === 1,
    id,
  );

const idle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        window.__map!.once('idle', () => resolve());
        window.__map!.triggerRepaint();
      }),
  );

test('renders a live landmark and hides only the building under it', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });

  const target = await findTarget();
  await page.goto('/e2e.html');
  await page.evaluate((t) => window.__start(t as never), target);
  await page.waitForFunction(() => window.__state.models.length > 0, null, { timeout: 45_000 });
  // Shaders compile in the background, then the model fades in as the building sinks.
  await page.waitForFunction(
    () => window.__map!.getFeatureState({ source: 'b', id: 1 })['landmarks:fade'] === 1,
    null,
    { timeout: 10_000 },
  );
  await idle(page);

  expect(await hidden(page, 1)).toBe(true);
  expect(await hidden(page, 2)).toBe(false);
  // Replacement uses feature-state only: the filter (and so the tiles) are never touched.
  expect(await page.evaluate(() => window.__map!.getFilter('buildings'))).toEqual(LEGACY_FILTER);

  const coloured = await page.evaluate(() => {
    const src = window.__map!.getCanvas();
    const c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(src, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const white = d[i]! > 245 && d[i + 1]! > 245 && d[i + 2]! > 245;
      const red = d[i]! > 200 && d[i + 1]! < 60 && d[i + 2]! < 60;
      if (!white && !red) n++;
    }
    return n / (d.length / 4);
  });
  expect(coloured).toBeGreaterThan(0.01);

  const after = await page.evaluate(() => {
    window.__map!.removeLayer('landmarks');
    return window.__map!.getPaintProperty('buildings', 'fill-opacity') ?? null;
  });
  expect(after).toBeNull();
  expect(await hidden(page, 1)).toBe(false);

  expect(await page.evaluate(() => window.__state.errors)).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('survives setStyle with and without diff', async ({ page }) => {
  const target = await findTarget();
  await page.goto('/e2e.html');
  await page.evaluate((t) => window.__start(t as never), target);
  await page.waitForFunction(() => window.__state.models.length > 0, null, { timeout: 45_000 });

  // Diffed swap (theme toggle): layer survives, building stays hidden, attribution stays.
  await page.evaluate(() => window.__setStyle('#f4f4f4', true));
  await idle(page);
  expect(await hidden(page, 1)).toBe(true);
  expect(await hidden(page, 2)).toBe(false);
  expect(await page.evaluate(() => !!window.__map!.getSource('landmarks-attribution'))).toBe(true);

  // Full swap: the custom layer is dropped without onRemove; the new style must be untouched.
  await page.evaluate(() => window.__setStyle('#ffffff', false));
  await idle(page);
  expect(await hidden(page, 1)).toBe(false);
  expect(
    await page.evaluate(() => window.__map!.getPaintProperty('buildings', 'fill-opacity') ?? null),
  ).toBeNull();
  expect(await page.evaluate(() => window.__state.errors)).toEqual([]);
});
