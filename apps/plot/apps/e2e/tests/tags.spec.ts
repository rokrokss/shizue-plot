import { seedSession } from '../seedSession.js';
import { expect, test, type Page } from '@playwright/test';

/** Throwaway check of the tag-hiding UI against the dev stack. */
test.describe.configure({ mode: 'serial' });

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const account = { email: `tags-${run}@example.test`, password: 'e2e-password-1234', name: `태그 ${run}` };
const name = `태그 플롯 ${run}`;

async function signUp(page: Page): Promise<void> {
  await seedSession(page, account);
  await expect(page).toHaveURL(/\/ko$/);
}

test('hides and unhides a tag in the feed', async ({ page }) => {
  await signUp(page);
  // Signup lands on the feed; making things lives under the creator area.
  await page.goto('/ko/plots');
  await page.getByRole('button', { name: '새 플롯' }).click();
  await page.getByPlaceholder('플롯 이름').fill(name);
  await page.getByRole('button', { name: '만들기', exact: true }).click();
  await page.getByLabel('세계관 설정').fill('세계관');
  await page.getByRole('button', { name: '도입부 추가' }).click();
  await page.getByTestId('plot-intro').fill('문이 열린다');
  // A genre chip is an ordinary tag: clicking it is the same as typing it.
  await page.getByTestId('genre-suggestion').filter({ hasText: '판타지' }).click();
  await page.getByTestId('tag-input').fill(`자유${run}`);
  await page.getByTestId('tag-input').press('Enter');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByText('저장했습니다')).toBeVisible();
  await page.getByRole('button', { name: '공개하기' }).click();
  await expect(page.getByRole('button', { name: '비공개로 전환' })).toBeVisible();

  await page.goto('/ko');
  await page.getByPlaceholder('플롯 이름 검색').fill(name);
  const card = page.getByTestId('plot-card').filter({ hasText: name });
  await expect(card).toHaveCount(1);

  // Reserved genres lead the chip row.
  const chips = page.locator('ul li > span button[aria-pressed]');
  await expect(chips.nth(1)).toHaveText('판타지');

  // Hiding the genre takes the plot out of the grid.
  await page.getByRole('button', { name: '판타지 태그 숨기기' }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByText('조건에 맞는 플롯이 없습니다.')).toBeVisible();
  await expect(page.getByTestId('hidden-tags-toggle')).toHaveText('숨긴 태그 1개');

  // …and it survives a reload, because it is stored per browser.
  await page.reload();
  await page.getByPlaceholder('플롯 이름 검색').fill(name);
  await expect(page.getByTestId('hidden-tags-toggle')).toBeVisible();
  await expect(card).toHaveCount(0);

  await page.getByTestId('hidden-tags-toggle').click();
  await page.getByRole('button', { name: '해제' }).click();
  await expect(card).toHaveCount(1);
  await expect(page.getByTestId('hidden-tags-toggle')).toHaveCount(0);
});
