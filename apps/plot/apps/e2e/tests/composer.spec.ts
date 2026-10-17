import { expect, test, type Page, type Request } from '@playwright/test';
import { seedSession } from '../seedSession.js';

/**
 * The composer's Enter, by the screen it is typed on. At a desk Enter sends and
 * Shift+Enter breaks the line. A touch keyboard has no Shift+Enter, so there
 * Enter breaks the line and the round button sends (PocketRisu's
 * `sendKeyMobile`), or Ctrl/⌘+Enter from a keyboard paired to the tablet. The
 * field there is 16px, below which iOS zooms the page in on focus; at a desk it
 * is Zeta's 15px. Both keep a 1.2rem line.
 */

const origin = process.env['E2E_WEB_URL'] ?? 'http://localhost:13000';

/** A chat of the reader's own on the echo model, opened; its id. */
async function openChat(page: Page, name: string): Promise<string> {
  await seedSession(page, { email: `${name}-${Date.now()}@example.test`, password: 'e2e-password-1234', name });
  const headers = { origin };
  const plot = await page.request.post(`${origin}/api/plots`, {
    headers, data: { name: '입력창 테스트', description: '작은 서점', intros: ['문이 열렸다.'] },
  });
  expect(plot.ok()).toBe(true);
  const chat = await page.request.post(`${origin}/api/chats`, {
    headers, data: { plotId: (await plot.json()).id, model: 'echo/echo' },
  });
  expect(chat.ok()).toBe(true);
  const { chat: { id } } = await chat.json();
  await page.goto(`/ko/chats/${id}`);
  return id;
}

/** Every write the page sends to the chat from here on. */
function chatWrites(page: Page, id: string): Request[] {
  const writes: Request[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' && request.url().includes(`/api/chats/${id}/`)) writes.push(request);
  });
  return writes;
}

test.describe('on a touch screen', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('Enter breaks the line and the button sends, in a 16px field', async ({ page }) => {
    const id = await openChat(page, 'touch');
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    const composer = page.getByPlaceholder('메시지를 입력하세요…');
    await expect(composer).toHaveCSS('font-size', '16px');
    await expect(composer).toHaveCSS('line-height', '19.2px');
    const writes = chatWrites(page, id);

    await composer.click();
    await page.keyboard.type('책장 사이로');
    await page.keyboard.press('Enter');
    await page.keyboard.type('걸어간다');
    await expect(composer).toHaveValue('책장 사이로\n걸어간다');
    expect(writes).toEqual([]);

    await page.getByRole('button', { name: '보내기', exact: true }).click();
    await expect(composer).toHaveValue('');
    await expect.poll(() => writes.length).toBeGreaterThan(0);

    await composer.fill('문을 닫는다');
    // Sending waits for the echo reply to end, as it does for the button.
    await expect(page.getByRole('button', { name: '보내기', exact: true })).toBeEnabled();
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(composer).toHaveValue('');
  });
});

test('at a desk Enter sends and Shift+Enter breaks the line, in a 15px field', async ({ page }) => {
  const id = await openChat(page, 'desk');
  const composer = page.getByPlaceholder('메시지를 입력하세요…');
  // 0.938rem, Zeta's 15px.
  await expect(composer).toHaveCSS('font-size', '15.008px');
  await expect(composer).toHaveCSS('line-height', '19.2px');
  const writes = chatWrites(page, id);

  await composer.click();
  await page.keyboard.type('책장 사이로');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('걸어간다');
  await expect(composer).toHaveValue('책장 사이로\n걸어간다');
  expect(writes).toEqual([]);

  await page.keyboard.press('Enter');
  await expect(composer).toHaveValue('');
  await expect.poll(() => writes.length).toBeGreaterThan(0);
});
