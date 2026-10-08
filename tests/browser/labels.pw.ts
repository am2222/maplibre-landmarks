import { expect, test, type Page } from '@playwright/test';
import type {} from '../../demo/e2e';
import { findTarget } from './target';

const labelState = (page: Page, id: number) =>
  page.evaluate(
    (i) => window.__map!.getFeatureState({ source: 'labels', id: i })['landmarks:label'],
    id,
  );

test('hides a label behind the landmark and keeps the one in front', async ({ page }) => {
  const target = await findTarget();
  const lats = (target.footprint as { coordinates: number[][][] }).coordinates[0]!.map(
    (p) => p[1]!,
  );
  const [lng] = target.anchor;
  // The camera looks north (bearing 0, pitch 50): north of the landmark is behind it.
  const behind: [number, number] = [lng, Math.max(...lats) + 0.0004];
  const front: [number, number] = [lng, Math.min(...lats) - 0.0004];

  await page.goto('/e2e.html');
  await page.evaluate((t) => window.__start(t as never), target);
  await page.waitForFunction(() => window.__state.models.length > 0, null, { timeout: 45_000 });
  await page.waitForFunction(
    () => window.__map!.getFeatureState({ source: 'b', id: 1 })['landmarks:fade'] === 1,
    null,
    { timeout: 10_000 },
  );
  await page.evaluate((pts) => window.__addLabels(pts as [number, number][]), [behind, front]);

  await page.waitForFunction(
    () => window.__map!.getFeatureState({ source: 'labels', id: 1 })['landmarks:label'] === 0,
    null,
    { timeout: 10_000 },
  );
  expect(await labelState(page, 2)).toBe(1);

  await page.evaluate(() => window.__map!.removeLayer('label-occlusion'));
  expect(await labelState(page, 1)).toBeUndefined();
  expect(
    await page.evaluate(() => window.__map!.getPaintProperty('labels', 'icon-opacity')),
  ).toBeUndefined();
  expect(await page.evaluate(() => window.__state.errors)).toEqual([]);
});
