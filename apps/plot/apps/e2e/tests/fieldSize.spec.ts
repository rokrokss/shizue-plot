import { expect, test, type Page } from '@playwright/test';
import { seedSession } from '../seedSession.js';

/**
 * A `control-box` field on a touch screen is 16px, below which iOS zooms the page
 * in when a text field gets focus, whatever size its caller wrote. A desk keeps
 * the 14px field and a caller's own 12px.
 */

const origin = process.env['E2E_WEB_URL'] ?? 'http://localhost:13000';

/** A chat of the reader's own on the echo model, opened. */
async function openChat(page: Page, name: string): Promise<void> {
  await seedSession(page, { email: `${name}-${Date.now()}@example.test`, password: 'e2e-password-1234', name });
  const headers = { origin };
  const plot = await page.request.post(`${origin}/api/plots`, {
    headers, data: { name: '입력칸 테스트', description: '작은 서점', intros: ['문이 열렸다.'] },
  });
  expect(plot.ok()).toBe(true);
  const chat = await page.request.post(`${origin}/api/chats`, {
    headers, data: { plotId: (await plot.json()).id, model: 'echo/echo' },
  });
  expect(chat.ok()).toBe(true);
  await page.goto(`/ko/chats/${(await chat.json()).chat.id}`);
}

test.describe('on a touch screen', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('every field is 16px', async ({ page }) => {
    await page.goto('/ko/plots');
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    await page.getByRole('button', { name: '새 플롯' }).click();
    await expect(page.getByPlaceholder('플롯 이름')).toHaveCSS('font-size', '16px');

    await openChat(page, 'touch-fields');
    await page.getByRole('button', { name: '대화 설정' }).click();
    const sheet = page.getByRole('dialog', { name: '대화 설정' });
    await expect(sheet.getByLabel('모델', { exact: true })).toHaveCSS('font-size', '16px');
    // A caller's own `text-xs` gives way too.
    await sheet.getByRole('button', { name: '노트' }).click();
    await expect(page.getByRole('combobox', { name: '넣는 깊이' })).toHaveCSS('font-size', '16px');
  });
});

test('at a desk the fields keep their sizes', async ({ page }) => {
  await page.goto('/ko/plots');
  await page.getByRole('button', { name: '새 플롯' }).click();
  await expect(page.getByPlaceholder('플롯 이름')).toHaveCSS('font-size', '14px');

  await page.setViewportSize({ width: 390, height: 844 });
  await openChat(page, 'desk-fields');
  await page.getByRole('button', { name: '대화 설정' }).click();
  const sheet = page.getByRole('dialog', { name: '대화 설정' });
  await expect(sheet.getByLabel('모델', { exact: true })).toHaveCSS('font-size', '14px');
  await sheet.getByRole('button', { name: '노트' }).click();
  await expect(page.getByRole('combobox', { name: '넣는 깊이' })).toHaveCSS('font-size', '12px');
});
