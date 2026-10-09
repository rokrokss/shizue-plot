import { chromium, expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeVariant } from '../../extension/scripts/variant.mjs';

const WEB_URL = process.env['E2E_WEB_URL'] ?? 'http://localhost:13000';
const CALLBACK_PORT = Number(process.env['E2E_CALLBACK_PORT'] ?? 47801);

/**
 * The real sign-in helper, the real login page, the Next rewrite and the API's
 * callback: only OpenAI is stood in for. auth.openai.com is routed here to send
 * the browser to the loopback address, exactly where the real consent screen
 * would; the API exchanges the code with its NODE_ENV=test stand-in
 * (CHATGPT_FAKE_OPENAI), which reads the identity this test packed into it.
 */
test('Sign in with ChatGPT through the companion extension', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shizue-extension-'));
  const extension = join(root, 'extension');
  await writeVariant(extension, [{ origin: WEB_URL, loopbackPort: CALLBACK_PORT }]);
  const context = await chromium.launchPersistentContext(join(root, 'profile'), {
    channel: 'chromium', headless: true, locale: 'ko-KR',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    if (!context.serviceWorkers().length) await context.waitForEvent('serviceworker');
    const email = `e2e-${Date.now()}@chatgpt.test`;
    await context.route('https://auth.openai.com/**', async (route) => {
      const authorize = new URL(route.request().url());
      const identity = { sub: `e2e-${Date.now()}`, email, nonce: authorize.searchParams.get('nonce') };
      const callback = new URL(`http://127.0.0.1:${CALLBACK_PORT}/auth/callback`);
      callback.search = new URLSearchParams({
        code: `fake.${Buffer.from(JSON.stringify(identity)).toString('base64url')}`,
        state: authorize.searchParams.get('state')!, client_id: 'app_e2e',
      }).toString();
      await route.fulfill({ status: 302, headers: { location: callback.href } });
    });

    const page = await context.newPage();
    await page.goto(`${WEB_URL}/ko/login?next=%2Fsettings`);
    await page.getByRole('button', { name: 'ChatGPT로 로그인' }).click();
    await expect(page).toHaveURL(`${WEB_URL}/ko/settings`);
    await expect(page.getByTitle(email)).toBeVisible();
  } finally {
    await context.close();
    await rm(root, { recursive: true, force: true });
  }
});
