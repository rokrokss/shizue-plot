import { expect, test } from '@playwright/test';

const signIn = { ko: 'ChatGPT로 로그인', en: 'Sign in with ChatGPT', ja: 'ChatGPTでログイン' };

test.beforeEach(async ({ page }) => {
  // Layout checks must not depend on the developer's local ChatGPT connection.
  await page.route('**/api/auth/get-session', (route) => route.fulfill({ json: null }));
  await page.route('**/api/chatgpt', (route) => route.fulfill({
    json: { connected: false, email: null, pending: false, errorCode: null },
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
  test(`${locale} discovery and login fit a ${width}px screen`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const paths = [`/${locale}`, `/${locale}/login`];
    // The legacy signup URL serves the same ChatGPT entrance.
    if (locale === 'ko' && width === 320) paths.push('/ko/signup');
    for (const path of paths) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page).toHaveTitle(/shizue$/);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    await expect(page.locator('input, form')).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Sign up|회원가입|新規登録/ })).toHaveCount(0);
    // The invitation must not push the actual login action below the fold.
    await expect(page.getByRole('button', { name: signIn[locale] })).toBeInViewport();
  });
}

test('an empty search offers a working route back to the catalogue', async ({ page }) => {
  await page.goto('/ko?q=shizue-no-matching-plot-941827');
  await page.getByRole('button', { name: '검색과 필터 초기화' }).click();
  await expect(page.getByRole('searchbox')).toHaveValue('');
  await expect(page).toHaveURL(/\/ko$/);
  await expect(page.getByRole('button', { name: '검색과 필터 초기화' })).toHaveCount(0);
});
