import { expect, test, type Page } from '@playwright/test';

const WEB_URL = process.env['E2E_WEB_URL'] ?? 'http://localhost:13000';

/** Shizue, as Chrome exposes it to a page it accepts messages from. */
function installShizue(): void {
  const scope = window as unknown as { chrome?: Record<string, unknown> };
  scope.chrome = Object.assign(scope.chrome ?? {}, {
    runtime: {
      sendMessage: (_id: string, _message: unknown, reply: (response: unknown) => void) =>
        reply({ ok: true, version: '0.3.6', features: ['plotSignIn'] }),
    },
  });
}

const STORE_LINK = { name: 'Chrome 웹 스토어에서 Shizue 받기' };
const CONNECT = { name: 'ChatGPT로 계속하기' };
const DISCONNECT = { name: 'ChatGPT 연결 끊기', exact: true };

/** `GET /api/chatgpt` answers `status`, for the browser this page is. */
async function answerStatus(page: Page, status: () => { connected: boolean; email: string | null; local: boolean }): Promise<void> {
  await page.route('**/api/chatgpt', (route) => route.fulfill({ json: status() }));
}

/**
 * The ChatGPT connection in settings, with the extension, the API and OpenAI
 * mocked. API tests cover the real callback; this covers what the owner sees.
 */
test('connecting ChatGPT through Shizue, a callback error, and disconnecting', async ({ page }) => {
  const email = `${'long-account-'.repeat(8)}@example.com`;
  let connected = false;
  let signIn: unknown;
  // Consent, the extension's rewrite and the API's callback, as the one redirect they end in.
  await page.route('https://auth.openai.com/**', (route) => {
    connected = true;
    return route.fulfill({ status: 302, headers: { location: `${WEB_URL}/ko/settings` } });
  });
  await page.route('**/api/chatgpt/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/sign-in')) {
      signIn = route.request().postDataJSON();
      return route.fulfill({ json: { authorizationUrl: 'https://auth.openai.com/api/accounts/authorize?mock=1' } });
    }
    connected = false;
    return route.fulfill({ json: { revocationPending: false } });
  });
  await answerStatus(page, () => ({ connected, email: connected ? email : null, local: true }));

  // Without Shizue the card points at its store page and holds the connection back.
  await page.goto('/ko/settings');
  await expect(page.getByRole('link', STORE_LINK)).toBeVisible();
  await expect(page.getByRole('button', CONNECT)).toBeDisabled();
  await expect(page.locator('input')).toHaveCount(0);
  await page.evaluate(installShizue);
  await page.getByRole('button', { name: '다시 확인' }).click();
  await expect(page.getByRole('button', CONNECT)).toBeFocused();
  await expect(page.getByRole('link', STORE_LINK)).toHaveCount(0);

  // A failed callback comes back with its code; the next attempt goes out in this tab and lands back here.
  await page.addInitScript(installShizue);
  await page.goto('/ko/settings?error=chatgpt_login_declined');
  await expect(page.getByText('ChatGPT 로그인을 허용하지 않았습니다.')).toBeVisible();
  await page.getByRole('button', CONNECT).click();
  await expect(page).toHaveURL(/\/ko\/settings$/);
  expect(signIn).toEqual({ next: '/settings', locale: 'ko' });

  const disconnect = page.locator('section').getByRole('button', DISCONNECT);
  await expect(disconnect).toBeEnabled();
  await expect(page.getByText('ChatGPT 요금제를 사용하고 있습니다.')).toBeVisible();
  await page.setViewportSize({ width: 375, height: 812 });
  const account = page.getByTitle(email);
  await expect(account).toHaveCSS('text-overflow', 'ellipsis');
  expect((await account.boundingBox())?.width).toBe((await disconnect.boundingBox())?.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // Disconnected, the card offers the connection again, and the app stays where it was.
  await disconnect.click();
  await expect(page.getByRole('button', CONNECT)).toBeEnabled();
  await expect(page).toHaveURL(/\/ko\/settings$/);
});

test('a paired phone reads the connection, and connects nothing itself', async ({ page }) => {
  let connected = false;
  await answerStatus(page, () => ({ connected, email: connected ? 'owner@example.com' : null, local: false }));

  await page.goto('/ko/settings');
  await expect(page.getByText('ChatGPT는 shizue를 실행하는 컴퓨터에서 연결합니다.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', CONNECT)).toHaveCount(0);

  connected = true;
  await page.reload();
  await expect(page.getByTitle('owner@example.com')).toBeVisible();
  await expect(page.getByText('ChatGPT 요금제를 사용하고 있습니다.')).toBeVisible();
  await expect(page.getByRole('button', DISCONNECT)).toHaveCount(0);
});
