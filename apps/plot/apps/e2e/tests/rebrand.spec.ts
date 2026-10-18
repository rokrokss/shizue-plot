import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // Layout checks must not depend on the developer's local ChatGPT connection.
  await page.route('**/api/chatgpt', (route) => route.fulfill({
    json: { connected: false, email: null, local: true },
  }));
});

// Check every translation at the narrowest supported width, plus one desktop.
const screens = [
  { locale: 'ko', width: 320 },
  { locale: 'en', width: 320 },
  { locale: 'ja', width: 320 },
  { locale: 'ko', width: 1440 },
] as const;

for (const { locale, width } of screens) {
  test(`${locale} library and settings fit a ${width}px screen`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    // The library has its title; the settings page, the cards that connect ChatGPT and a phone.
    for (const [path, level] of [[`/${locale}`, 1], [`/${locale}/settings`, 2]] as const) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level }).first()).toBeVisible();
      await expect(page).toHaveTitle(/shizue$/);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    // There is no way in to offer: the browser on this computer is the owner.
    await expect(page.getByRole('link', { name: /Sign up|회원가입|新規登録/ })).toHaveCount(0);
    await expect(page.locator('a[href*="/login"]')).toHaveCount(0);
  });
}
