import { expect, test } from '@playwright/test';

const WEB_URL = process.env['E2E_WEB_URL'] ?? 'http://localhost:13000';

/** The sign-in helper extension, as Chrome exposes it to a page it accepts messages from. */
function installHelper(): void {
  const scope = window as unknown as { chrome?: Record<string, unknown> };
  scope.chrome = Object.assign(scope.chrome ?? {}, {
    runtime: { sendMessage: (_id: string, _message: unknown, reply: (response: unknown) => void) => reply({ ok: true, version: '0.1.0' }) },
  });
}

/**
 * The ChatGPT-only entrance and settings with the extension, the API and OpenAI
 * mocked. API tests cover the real callback; this covers what the reader sees.
 */
test('ChatGPT sign-in through the helper extension, a callback error, and sign-out', async ({ page }) => {
  const email = `${'long-account-'.repeat(8)}@example.com`;
  let connected = false;
  let signIn: unknown;
  // Consent, the extension's rewrite and the API's callback, as the one redirect they end in.
  await page.route('https://auth.openai.com/**', (route) => {
    connected = true;
    return route.fulfill({ status: 302, headers: { location: `${WEB_URL}/ko/settings` } });
  });
  await page.route('**/api/auth/get-session', (route) => route.fulfill({ json: connected ? { user: { id: 'usr_1', name: 'You', email, image: null } } : null }));
  await page.route('**/api/chatgpt**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/sign-in')) {
      signIn = route.request().postDataJSON();
      return route.fulfill({ json: { authorizationUrl: 'https://auth.openai.com/api/accounts/authorize?mock=1' } });
    }
    if (path.endsWith('/sign-out')) {
      connected = false;
      return route.fulfill({ json: { revocationPending: false } });
    }
    return route.fulfill({ json: { connected, email: connected ? email : null } });
  });

  // Without the helper the entrance explains it and holds the sign-in back.
  await page.goto('/ko/login?next=%2Fsettings');
  await expect(page.getByText('chrome://extensions', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'ChatGPT로 로그인' })).toBeDisabled();
  await expect(page.locator('input')).toHaveCount(0);
  await page.evaluate(installHelper);
  await page.getByRole('button', { name: '다시 확인' }).click();
  await expect(page.getByRole('button', { name: 'ChatGPT로 로그인' })).toBeFocused();
  await expect(page.getByText('chrome://extensions', { exact: true })).toHaveCount(0);

  // A failed callback comes back with its code; the next attempt goes out in this tab and lands on `next`.
  await page.addInitScript(installHelper);
  await page.goto('/ko/login?error=chatgpt_login_declined&next=%2Fsettings');
  await expect(page.getByText('ChatGPT 로그인을 허용하지 않았습니다.')).toBeVisible();
  await page.getByRole('button', { name: 'ChatGPT로 로그인' }).click();
  await expect(page).toHaveURL(/\/ko\/settings$/);
  expect(signIn).toEqual({ next: '/settings', locale: 'ko' });

  const signOut = page.locator('section').getByRole('button', { name: '로그아웃', exact: true });
  await expect(signOut).toBeEnabled();
  await page.setViewportSize({ width: 375, height: 812 });
  const account = page.getByTitle(email);
  await expect(account).toHaveCSS('text-overflow', 'ellipsis');
  expect((await account.boundingBox())?.width).toBe((await signOut.boundingBox())?.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await signOut.click();
  await expect(page).toHaveURL(/\/ko\/login/);
  await expect(page.getByRole('button', { name: 'ChatGPT로 로그인' })).toBeEnabled();
});
