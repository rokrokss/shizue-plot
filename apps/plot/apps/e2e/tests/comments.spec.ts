import { seedSession } from '../seedSession.js';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * Comment section of a public plot page across two accounts: A publishes a
 * plot → B comments on it → A replies → B leaves a spoiler comment, which stays
 * collapsed until it is clicked → A moderates B's first comment away and only
 * the placeholder holding the reply is left.
 *
 * A and B live in separate browser contexts (separate session cookies) and the
 * steps build on each other, so the file runs serially. Every run uses fresh
 * accounts and its own plot; nothing is deleted, because this hits the dev
 * database.
 */
test.describe.configure({ mode: 'serial' });

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const password = 'e2e-password-1234';
const creator = { email: `comment-a-${run}@example.test`, password, name: `작가 ${run}` };
const reader = { email: `comment-b-${run}@example.test`, password, name: `독자 ${run}` };
const plot = {
  name: `댓글 플롯 ${run}`,
  description: `댓글 테스트 세계관 ${run}`,
  intro: `문이 열린다 ${run}`,
};
const comment = `정말 재밌게 봤어요 ${run}`;
const reply = `읽어주셔서 고마워요 ${run}`;
const spoiler = `사실 범인은 집사였습니다 ${run}`;

const UUID_PATH = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

let creatorContext: BrowserContext;
let creatorPage: Page;
let readerContext: BrowserContext;
let readerPage: Page;
let plotId = '';

test.beforeAll(async ({ browser }) => {
  creatorContext = await browser.newContext();
  creatorPage = await creatorContext.newPage();
  readerContext = await browser.newContext();
  readerPage = await readerContext.newPage();
});

test.afterAll(async () => {
  await creatorContext.close();
  await readerContext.close();
});

async function signUp(page: Page, account: { email: string; password: string; name: string }): Promise<void> {
  await seedSession(page, account);
  await expect(page).toHaveURL(/\/ko$/);
}

/** Writes into the top-level form, or into the reply form once one is open. */
async function write(page: Page, form: 'comment-form' | 'reply-form', text: string): Promise<void> {
  const box = page.getByTestId(form);
  await box.getByRole('textbox').fill(text);
  await box.getByRole('button', { name: '등록' }).click();
}

test('user A publishes a plot to comment on', async () => {
  await signUp(creatorPage, creator);

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
  await creatorPage.getByRole('button', { name: '저장', exact: true }).click();
  await expect(creatorPage.getByText('저장했습니다')).toBeVisible();

  await creatorPage.getByRole('button', { name: '공개하기' }).click();
  await expect(creatorPage.getByRole('button', { name: '비공개로 전환' })).toBeVisible();
});

test('user B comments on the public plot', async () => {
  await signUp(readerPage, reader);
  await readerPage.goto(`/ko/p/${plotId}`);

  await expect(readerPage.getByRole('heading', { name: '댓글 0' })).toBeVisible();
  await expect(readerPage.getByText('아직 댓글이 없습니다.')).toBeVisible();

  await write(readerPage, 'comment-form', comment);

  const posted = readerPage.getByTestId('comment');
  await expect(posted).toHaveCount(1);
  await expect(posted).toContainText(comment);
  await expect(posted).toContainText(reader.name);
  await expect(readerPage.getByRole('heading', { name: '댓글 1' })).toBeVisible();
});

test('user A replies to it from their own page', async () => {
  await creatorPage.goto(`/ko/p/${plotId}`);
  await expect(creatorPage.getByTestId('comment')).toContainText(comment);

  await creatorPage.getByRole('button', { name: '답글', exact: true }).click();
  await write(creatorPage, 'reply-form', reply);

  await expect(creatorPage.getByTestId('comment-reply')).toHaveCount(1);
  await expect(creatorPage.getByTestId('comment-reply')).toContainText(reply);
  await expect(creatorPage.getByTestId('comment-reply')).toContainText(creator.name);
  await expect(creatorPage.getByRole('heading', { name: '댓글 2' })).toBeVisible();
});

test("user B's spoiler stays hidden until it is clicked", async () => {
  await readerPage.reload();
  await readerPage.getByTestId('comment-form').getByRole('textbox').fill(spoiler);
  await readerPage.getByTestId('comment-form').getByLabel('스포일러', { exact: true }).check();
  await readerPage.getByTestId('comment-form').getByRole('button', { name: '등록' }).click();
  await expect(readerPage.getByTestId('comment')).toHaveCount(2);

  // A sees it collapsed: the text is not on the page at all until asked for.
  await creatorPage.reload();
  await expect(creatorPage.getByTestId('spoiler-toggle')).toHaveCount(1);
  await expect(creatorPage.getByText(spoiler)).toHaveCount(0);

  await creatorPage.getByTestId('spoiler-toggle').click();
  await expect(creatorPage.getByText(spoiler)).toBeVisible();
  await expect(creatorPage.getByTestId('spoiler-toggle')).toHaveCount(0);
});

test('user A deletes the commented-on comment and a placeholder is left', async () => {
  const commented = creatorPage.getByTestId('comment').filter({ hasText: comment });
  // Deleting asks first, and Playwright dismisses dialogs unless told otherwise.
  creatorPage.once('dialog', (dialog) => void dialog.accept());
  await commented.getByTestId('comment-delete').click();

  // The reply keeps its place in the thread, so the deleted comment stays as a
  // placeholder — without its author and without a word of what it said.
  await expect(creatorPage.getByTestId('comment-deleted')).toHaveCount(1);
  await expect(creatorPage.getByText(comment)).toHaveCount(0);
  await expect(creatorPage.getByTestId('comment-reply')).toContainText(reply);
  await expect(creatorPage.getByRole('heading', { name: '댓글 2' })).toBeVisible();

  // …and that is what the server really stored, not just what this page shows.
  await readerPage.reload();
  await expect(readerPage.getByTestId('comment-deleted')).toHaveCount(1);
  await expect(readerPage.getByText(comment)).toHaveCount(0);
  await expect(readerPage.getByTestId('comment-reply')).toContainText(reply);
  await expect(readerPage.getByRole('heading', { name: '댓글 2' })).toBeVisible();
});
