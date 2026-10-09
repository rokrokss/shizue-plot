import { seedSession } from '../seedSession.js';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * The safety surfaces for one account: the creator signs up and finds the AI
 * settings in the header → publishes a plot at the only level on offer,
 * all-ages (the adult tier waits for age verification) → the chat carries the
 * AI disclosure once and the badge always.
 *
 * The steps build on each other (the disclosure is stored in the context's
 * localStorage), so the file runs serially. Every run uses a fresh account and
 * its own plot; nothing is deleted, because this hits the dev database.
 */
test.describe.configure({ mode: 'serial' });

const MESSAGES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/messages');

/** Read at run time — the catalogs are owned elsewhere and may change. */
function messages(locale: string): {
  chat: { aiNotice: string };
} {
  return JSON.parse(readFileSync(resolve(MESSAGES_DIR, `${locale}.json`), 'utf8'));
}

const ko = messages('ko');
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const password = 'e2e-password-1234';
const creator = { email: `safety-a-${run}@example.test`, password, name: `제작자 ${run}` };
const plot = {
  name: `전체 이용가 플롯 ${run}`,
  description: `테스트 세계관 ${run}`,
  intro: `문이 닫힌다 ${run}`,
};

const UUID_PATH = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

let creatorContext: BrowserContext;
let creatorPage: Page;
let plotId = '';

test.beforeAll(async ({ browser }) => {
  creatorContext = await browser.newContext();
  creatorPage = await creatorContext.newPage();
});

test.afterAll(async () => {
  await creatorContext.close();
});

async function signUp(page: Page, account: { email: string; password: string; name: string }): Promise<void> {
  await seedSession(page, account);
  await expect(page).toHaveURL(/\/ko$/);
}

test('the product header offers AI settings', async () => {
  await signUp(creatorPage, creator);

  await expect(creatorPage.getByRole('link', { name: 'AI 연결', exact: true })).toBeVisible();
});

test('the creator publishes at the only level on offer, all-ages', async () => {
  // Signup lands on the feed; making things lives under the creator area.
  await creatorPage.goto('/ko/plots');
  await creatorPage.getByRole('button', { name: '새 플롯' }).click();
  await creatorPage.getByPlaceholder('플롯 이름').fill(plot.name);
  await creatorPage.getByRole('button', { name: '만들기', exact: true }).click();
  await expect(creatorPage).toHaveURL(new RegExp(`/ko/plots/${UUID_PATH}$`));
  plotId = new URL(creatorPage.url()).pathname.split('/').pop() ?? '';

  await creatorPage.getByLabel('세계관 설정').fill(plot.description);
  await creatorPage.getByRole('button', { name: '도입부 추가' }).click();
  await creatorPage.getByTestId('plot-intro').fill(plot.intro);
  // A genre chip is an ordinary tag: clicking it is the same as typing it.
  await creatorPage.getByTestId('genre-suggestion').filter({ hasText: '판타지' }).click();
  await creatorPage.getByRole('button', { name: '저장', exact: true }).click();
  await expect(creatorPage.getByText('저장했습니다')).toBeVisible();

  const safety = creatorPage.getByTestId('safety-select');
  await expect(safety.locator('option')).toHaveCount(1);
  await expect(safety).toHaveValue('all');
  await creatorPage.getByRole('button', { name: '공개하기' }).click();
  await expect(creatorPage.getByRole('button', { name: '비공개로 전환' })).toBeVisible();
  await expect(creatorPage.getByTestId('adult-gate-notice')).toHaveCount(0);
});

test('the chat discloses the AI once and badges it always', async () => {
  await creatorPage.goto(`/ko/p/${plotId}`);
  await creatorPage.getByLabel('모델').selectOption('echo/echo');
  await creatorPage.getByRole('button', { name: '대화 시작' }).click();
  await expect(creatorPage).toHaveURL(new RegExp(`/ko/chats/${UUID_PATH}$`));

  await expect(creatorPage.getByTestId('ai-notice')).toContainText(ko.chat.aiNotice);
  await expect(creatorPage.getByTestId('ai-badge')).toBeVisible();

  await creatorPage.getByTestId('ai-notice').getByRole('button', { name: '닫기' }).click();
  await expect(creatorPage.getByTestId('ai-notice')).toHaveCount(0);

  // The dismissal sticks across reloads, and across chats: it is a one-time notice.
  await creatorPage.reload();
  await expect(creatorPage.getByTestId('ai-badge')).toBeVisible();
  await expect(creatorPage.getByTestId('ai-notice')).toHaveCount(0);
});
