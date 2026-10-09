import { expect, type Page } from '@playwright/test';

/** Legacy multi-user fixtures exist only on the NODE_ENV=test API, never in product UI. */
export async function seedSession(page: Page, account: { email: string; password: string; name: string }): Promise<void> {
  const base = process.env['E2E_WEB_URL'] ?? 'http://localhost:13000';
  const response = await page.request.post(`${base}/api/auth/sign-up/email`, { data: account, headers: { origin: base } });
  expect(response.ok()).toBe(true);
  await page.goto('/ko');
}
