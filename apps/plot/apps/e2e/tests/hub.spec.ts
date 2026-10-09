import { seedSession } from '../seedSession.js';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * Plot hub path across two accounts: A uploads an image asset and publishes a
 * plot whose opening references it → B discovers it in the feed at `/`, likes
 * it, chats with it and sees the image → B switches locale and the ko plot is
 * gone from the ja catalogue (hard partition) → A unpublishes and it leaves B's
 * catalogue entirely.
 *
 * A and B live in separate browser contexts (separate session cookies) and the
 * steps build on each other, so the file runs serially. Every run uses fresh
 * accounts and its own plot; nothing is deleted, because this hits the dev
 * database.
 */
test.describe.configure({ mode: 'serial' });

const MESSAGES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/messages');

/** Read at run time — the catalogs are owned elsewhere and may change. */
function messages(locale: string): { explore: { searchPlaceholder: string; emptyFiltered: string } } {
  return JSON.parse(readFileSync(resolve(MESSAGES_DIR, `${locale}.json`), 'utf8')) as {
    explore: { searchPlaceholder: string; emptyFiltered: string };
  };
}

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const password = 'e2e-password-1234';
const creator = { email: `hub-a-${run}@example.test`, password, name: `제작자 ${run}` };
const reader = { email: `hub-b-${run}@example.test`, password, name: `독자 ${run}` };
const plot = {
  name: `허브 플롯 ${run}`,
  description: `허브 테스트 세계관 ${run}`,
  // The card keeps macros raw, so the listing has to expand {{char}} itself.
  intro: `{{char}}의 문이 열린다 ${run}`,
  tag: `허브${run}`,
};
const member = { name: `문지기${run}`, description: `문 앞을 지키는 사람 ${run}` };
/** A 1x1 PNG, uploaded as the plot's only image asset. */
const asset = {
  slug: `hub-${run}`,
  bytes: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
};
/** Two openings: one carrying the picture, one plain, so the roots swipe. */
const intros = [
  `비가 내린다 ${run} {{img::${asset.slug}}}\n${member.name}: 들어와.`,
  `해가 들었다 ${run}\n${member.name}: 오늘은 조용하네.`,
];
const turn = `안녕 반가워 ${run}`;

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

/** The card for our plot in whatever catalogue the page is showing. */
const cardOf = (page: Page) => page.getByTestId('plot-card').filter({ hasText: plot.name });

async function search(page: Page, locale: 'ko' | 'ja'): Promise<void> {
  await page.goto(`/${locale}`);
  await page.getByPlaceholder(messages(locale).explore.searchPlaceholder).fill(plot.name);
}

test('user A publishes a plot with a tag, an image asset and two openings', async () => {
  await signUp(creatorPage, creator);

  // Signup lands on the feed; making things lives under the creator area.
  await creatorPage.goto('/ko/plots');
  await creatorPage.getByRole('button', { name: '새 플롯' }).click();
  await creatorPage.getByPlaceholder('플롯 이름').fill(plot.name);
  await creatorPage.getByRole('button', { name: '만들기', exact: true }).click();
  await expect(creatorPage).toHaveURL(new RegExp(`/ko/plots/${UUID_PATH}$`));
  plotId = new URL(creatorPage.url()).pathname.split('/').pop() ?? '';

  // The image the opening pulls in. Its slug is proposed from the file name.
  // Three hidden file inputs live on this page (cover, avatar and asset); target
  // the asset one.
  await creatorPage.getByTestId('asset-file-input').setInputFiles({
    name: `${asset.slug}.png`,
    mimeType: 'image/png',
    buffer: asset.bytes,
  });
  await expect(creatorPage.getByLabel('슬러그')).toHaveValue(asset.slug);
  await creatorPage.getByRole('button', { name: '업로드' }).click();
  await expect(creatorPage.getByTestId('plot-asset')).toHaveCount(1);
  await expect(creatorPage.getByTestId('plot-asset')).toContainText(asset.slug);

  // Anchored: a field's label carries its badge and its hint along with it, and
  // the roster's own 독자 소개 would otherwise answer to the same substring.
  await creatorPage.getByLabel(/^소개/).fill(plot.intro);
  await creatorPage.getByLabel('세계관 설정').fill(plot.description);
  await creatorPage.getByTestId('tag-input').fill(plot.tag);
  await creatorPage.getByTestId('tag-input').press('Enter');

  await creatorPage.getByRole('button', { name: '등장인물 추가' }).click();
  const row = creatorPage.getByTestId('plot-member').first();
  await row.locator('summary').click();
  await row.getByLabel('이름').fill(member.name);
  await row.getByLabel(/^설정/).fill(member.description);

  for (const [index, text] of intros.entries()) {
    await creatorPage.getByRole('button', { name: '도입부 추가' }).click();
    await creatorPage.getByTestId('plot-intro').nth(index).fill(text);
  }

  await creatorPage.getByRole('button', { name: '저장', exact: true }).click();
  await expect(creatorPage.getByText('저장했습니다')).toBeVisible();

  // Publishing reads the stored plot, so it only happens after the save.
  await creatorPage.getByRole('button', { name: '공개하기' }).click();
  await expect(creatorPage.getByRole('button', { name: '비공개로 전환' })).toBeVisible();
});

test('the owner sees the public page with an edit link', async () => {
  await creatorPage.goto(`/ko/p/${plotId}`);

  // Everything the public view shows, projected from the owner's own plot.
  await expect(creatorPage.getByRole('heading', { name: plot.name })).toBeVisible();
  await expect(creatorPage.getByText(plot.tag)).toBeVisible();
  // {{char}} is expanded for display; the API stores it raw.
  await expect(creatorPage.getByTestId('plot-intro')).toContainText(`${plot.name}의 문이 열린다`);
  // The opening's preview is plain text: the image reference is dropped rather
  // than shown.
  await expect(creatorPage.getByTestId('intro-text')).toContainText('비가 내린다');
  await expect(creatorPage.getByText('{{img::')).toHaveCount(0);
  await expect(creatorPage.getByText('좋아요 0')).toBeVisible();
  // Liking your own plot is pointless: the edit link takes that slot.
  await expect(creatorPage.getByTestId('like-button')).toHaveCount(0);
  await expect(creatorPage.getByRole('link', { name: '편집' })).toBeVisible();
});

test('user B finds the plot in the feed', async () => {
  await signUp(readerPage, reader);

  // Scoped and exact: the dev catalogue carries other cards named "허브 …".
  await readerPage.getByRole('navigation').getByRole('link', { name: '탐색', exact: true }).click();
  await expect(readerPage).toHaveURL(/\/ko$/);

  await readerPage.getByPlaceholder(messages('ko').explore.searchPlaceholder).fill(plot.name);
  await expect(cardOf(readerPage)).toHaveCount(1);
  await expect(cardOf(readerPage)).toContainText(creator.name);
  await expect(cardOf(readerPage)).toContainText(plot.tag);
  await expect(cardOf(readerPage)).toContainText(`${plot.name}의 문이 열린다`);
  // The roster is what a card is read by, beside the cover it does not have.
  await expect(cardOf(readerPage).getByTestId('plot-faces')).toBeVisible();

  await cardOf(readerPage).click();
  await expect(readerPage).toHaveURL(new RegExp(`/ko/p/${UUID_PATH}$`));
  await expect(readerPage.getByRole('heading', { name: plot.name })).toBeVisible();
  await expect(readerPage.getByTestId('plot-member')).toContainText(member.name);
});

test('user B likes the plot and the count sticks', async () => {
  const like = readerPage.getByTestId('like-button');
  await expect(like).toHaveText(/♡\s*0/);

  await like.click();
  await expect(like).toHaveText(/♥\s*1/);

  await readerPage.reload();
  await expect(readerPage.getByTestId('like-button')).toHaveText(/♥\s*1/);
});

test('user B starts a chat with the public plot and echoes a turn', async () => {
  await readerPage.getByLabel('모델').selectOption('echo/echo');
  await readerPage.getByRole('button', { name: '대화 시작' }).click();

  await expect(readerPage).toHaveURL(new RegExp(`/ko/chats/${UUID_PATH}$`));
  const assistant = readerPage.getByTestId('message-assistant');
  await expect(assistant.first()).toContainText('비가 내린다');
  // Both openings came across as root siblings.
  await expect(assistant.last().getByText(/^\d+\/\d+$/)).toHaveText('1/2');
  // …and the creator's roster names the line that carries a prefix, for a
  // non-owner too: the public view is where the reader's page reads it from.
  await expect(assistant.first().getByTestId('speech-character')).toHaveAttribute(
    'data-speaker',
    member.name,
  );

  // The opening's reference renders as the creator's image, for a non-owner too.
  // The src may carry the measured-size fragment (#shizue=…) behind the path.
  // ChatImage exposes the picture as a button since the subcomponent audit —
  // opening it is the action, and the alt is its name.
  const image = assistant.first().getByRole('button', { name: asset.slug });
  await expect(image).toHaveAttribute(
    'src',
    new RegExp(`^/api/plots/${plotId}/assets/${asset.slug}(#|$)`),
  );
  // …and the bytes really came back: assets follow the plot's visibility.
  await expect
    .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  await expect(assistant.first().getByText('{{img::')).toHaveCount(0);

  await readerPage.getByPlaceholder('메시지를 입력하세요').fill(turn);
  await readerPage.getByRole('button', { name: '보내기' }).click();

  await expect(readerPage.getByTestId('message-user').last()).toContainText(turn);
  await expect(assistant.last()).toContainText(turn);
  await expect(readerPage.getByPlaceholder('메시지를 입력하세요')).toBeEnabled();
});

test('the ja catalogue does not carry a ko plot', async () => {
  await readerPage.goto('/ko');
  await readerPage.getByLabel('언어').selectOption('ja');
  await expect(readerPage).toHaveURL(/\/ja$/);

  await readerPage.getByPlaceholder(messages('ja').explore.searchPlaceholder).fill(plot.name);
  await expect(readerPage.getByText(messages('ja').explore.emptyFiltered)).toBeVisible();
  await expect(cardOf(readerPage)).toHaveCount(0);
});

test('unpublishing takes the plot out of the catalogue', async () => {
  await creatorPage.goto(`/ko/plots/${plotId}`);
  await creatorPage.getByRole('button', { name: '비공개로 전환' }).click();
  await expect(creatorPage.getByRole('button', { name: '공개하기' })).toBeVisible();

  await search(readerPage, 'ko');
  await expect(readerPage.getByText(messages('ko').explore.emptyFiltered)).toBeVisible();
  await expect(cardOf(readerPage)).toHaveCount(0);

  // …and its page is gone with it, for everyone but its owner.
  await readerPage.goto(`/ko/p/${plotId}`);
  await expect(readerPage.getByText('플롯을 찾을 수 없거나 공개되지 않았습니다.')).toBeVisible();

  // The owner still reaches it, and still gets the edit link rather than a like.
  await creatorPage.goto(`/ko/p/${plotId}`);
  await expect(creatorPage.getByRole('heading', { name: plot.name })).toBeVisible();
  await expect(creatorPage.getByRole('link', { name: '편집' })).toBeVisible();
  await expect(creatorPage.getByTestId('like-button')).toHaveCount(0);
});
