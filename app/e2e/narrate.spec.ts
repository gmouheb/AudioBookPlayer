/**
 * End-to-end flow against a real Narrate server (`podman compose up` first).
 * Generates real audio, so it takes a few minutes.
 *
 *   NARRATE_API=http://localhost:8000 npx playwright test
 */
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import path from 'node:path';

const API = process.env['NARRATE_API'] ?? 'http://localhost:8000';
const SAMPLES = path.resolve(__dirname, '../../samples');

/** Seconds shown in the player's elapsed-time label ("m:ss"). */
async function elapsed(page: Page): Promise<number> {
  const text = (await page.locator('app-player-bar .times span').first().textContent()) ?? '0:00';
  const [m, s] = text.trim().split(':').map(Number);
  return m * 60 + s;
}

function chapterItem(page: Page, title: string): Locator {
  return page.locator('ion-item').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

test.use({ actionTimeout: 20_000 });

test('upload, generate, play, resume, delete', async ({ page, request }) => {
  test.setTimeout(6 * 60_000);

  // Start from an empty library.
  for (const book of await (await request.get(`${API}/books`)).json()) {
    await request.delete(`${API}/books/${book.id}`);
  }

  await test.step('AC2/AC3: set server URL, test connection, persists across reload', async () => {
    await page.goto('/');
    await expect(page.getByText("Set your server's address")).toBeVisible();
    await page.getByRole('link', { name: 'Open Settings' }).click();
    await page.locator('ion-input input').fill(API);
    await page.getByRole('button', { name: 'Test connection' }).click();
    await expect(page.getByText('Connected')).toBeVisible({ timeout: 15_000 });

    await page.goto('/');
    await expect(page.getByText('No books yet')).toBeVisible();
  });

  await test.step('AC6: unsupported file shows a clear error', async () => {
    await page.locator('input[type=file]').setInputFiles(path.join(SAMPLES, 'notes.txt'));
    await expect(page.getByText('Unsupported file type. Upload a PDF or EPUB.')).toBeVisible();
    await page.getByRole('button', { name: 'OK' }).click();
  });

  await test.step('AC4: EPUB upload shows title, author, chapters', async () => {
    await page.locator('input[type=file]').setInputFiles(path.join(SAMPLES, 'frankenstein.epub'));
    await expect(page.getByRole('heading', { name: 'Frankenstein' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Mary Shelley')).toBeVisible();
    await page.getByRole('heading', { name: 'Frankenstein' }).click();
    await expect(chapterItem(page, 'Letter I')).toBeVisible();
    await expect(chapterItem(page, 'Chapter XXIV')).toBeAttached();
  });

  await test.step('AC7/AC11/AC12: tap a later chapter, it generates next and plays', async () => {
    const tappedAt = Date.now();
    await chapterItem(page, 'Chapter VI').click();
    await expect(chapterItem(page, 'Chapter VI')).toContainText('generating', { timeout: 30_000 });
    await expect.poll(() => elapsed(page), { timeout: 90_000, intervals: [1000] }).toBeGreaterThan(1);
    console.log(`  audio started ${((Date.now() - tappedAt) / 1000).toFixed(1)}s after tap`);
  });

  await test.step('AC9: skip, speed, pause', async () => {
    const before = await elapsed(page);
    await page.getByRole('button', { name: 'Forward 30 seconds' }).click();
    await expect.poll(() => elapsed(page)).toBeGreaterThanOrEqual(before + 29);

    const afterForward = await elapsed(page);
    await page.getByRole('button', { name: 'Back 15 seconds' }).click();
    await expect.poll(() => elapsed(page)).toBeLessThanOrEqual(afterForward - 13);

    await page.getByRole('button', { name: 'Playback speed' }).click();
    await expect(page.locator('app-player-bar ion-button').filter({ hasText: '×' })).toHaveText('1.25×');

    await page.getByRole('button', { name: 'Play or pause' }).click();
    const paused = await elapsed(page);
    await page.waitForTimeout(2500);
    expect(await elapsed(page)).toBe(paused);
  });

  await test.step('AC10: position resumes after reload', async () => {
    const saved = await elapsed(page);
    await page.reload();
    await expect(page.locator('app-player-bar')).toContainText('Chapter VI');
    expect(Math.abs((await elapsed(page)) - saved)).toBeLessThanOrEqual(5);
    await page.getByRole('button', { name: 'Play or pause' }).click();
    await expect.poll(() => elapsed(page), { timeout: 15_000 }).toBeGreaterThan(saved + 1);
    await page.getByRole('button', { name: 'Play or pause' }).click();
  });

  await test.step('AC15: delete from the library', async () => {
    await page.goto('/');
    await page
      .locator('ion-item-sliding')
      .first()
      .evaluate((el) => (el as HTMLElement & { open(side: string): Promise<void> }).open('end'));
    await page.locator('ion-item-option').first().click();
    await page.locator('ion-alert').getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText('No books yet')).toBeVisible({ timeout: 30_000 });
    expect(await (await request.get(`${API}/books`)).json()).toEqual([]);
  });
});
