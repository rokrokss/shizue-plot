import { seedSession } from '../seedSession.js';
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';

/**
 * The P1 surfaces, along the path a reader actually walks them: A writes a plot
 * with two 추천 프로필 and an image its opening pulls in → publishes it → B
 * follows A from the plot page, picks one of the profiles and starts a chat on
 * it → the opening draws the picture → the 주간 인기 tab carries the work → A
 * publishes a second plot and B's bell says so.
 *
 * **AI 초안 and 답장 추천 are deliberately not here.** Both are a real model
 * call the echo adapter cannot stand in for — a draft is strict JSON from the
 * default chat model, and suggestions come from the memory channel, which is
 * off entirely without its key. Their contracts (in-flight guards, parse
 * retries, the 502/503 they answer with) are covered in `apps/api/test`.
 *
 * A and B live in separate browser contexts and the steps build on each other,
 * so the file runs serially. Every run uses fresh accounts and its own plots;
 * nothing is deleted, because this hits the dev database.
 */
test.describe.configure({ mode: 'serial' });

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const password = 'e2e-password-1234';
const creator = { email: `p1-a-${run}@example.test`, password, name: `제작자 ${run}` };
const reader = { email: `p1-b-${run}@example.test`, password, name: `독자 ${run}` };

/** A 1x1 PNG — the image the opening pulls in. */
const asset = {
  slug: `p1-${run}`,
  bytes: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
};
const plot = {
  name: `항구 플롯 ${run}`,
  description: `열쇠 하나가 도는 항구 도시 ${run}`,
  intro: `창고 문이 열렸다 ${run} {{img::${asset.slug}}}`,
};
/** Two of them, so the picker is a choice and the count is not 1/5. */
const profiles = [
  { name: `신입 기자 ${run}`, description: `무엇이든 묻는 것이 일인 사람 ${run}` },
  { name: `옛 동료 ${run}`, description: `이 도시를 떠났다가 돌아온 사람 ${run}` },
];
/** The second work: published after B follows, so it is what the bell is about. */
const followUp = {
  name: `두 번째 플롯 ${run}`,
  description: `같은 도시의 다른 골목 ${run}`,
  intro: `골목 끝에서 불이 켜졌다 ${run}`,
};

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

/** Creates a plot from the creator area and answers with its id. */
async function createPlot(page: Page, name: string): Promise<string> {
  await page.goto('/ko/plots');
  await page.getByRole('button', { name: '새 플롯' }).click();
  await page.getByPlaceholder('플롯 이름').fill(name);
  await page.getByRole('button', { name: '만들기', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/ko/plots/${UUID_PATH}$`));
  return new URL(page.url()).pathname.split('/').pop() ?? '';
}

const profileRows = () => creatorPage.getByTestId('plot-profile');
/**
 * One field of a profile row. By role rather than by label: an unnamed row's
 * remove button answers to `이름 삭제`, which is the same prefix its 이름 field
 * has, and only one of the two is something to type in.
 */
const profileField = (row: Locator, label: string) =>
  row.getByRole('textbox', { name: new RegExp(`^${label}`) });
const assistantMessages = () => readerPage.getByTestId('message-assistant');
/** The opening's picture (ChatImage is a button). */
const openedImage = () => assistantMessages().first().getByRole('button', { name: asset.slug });

test('the creator writes two recommended profiles and they survive a reload', async () => {
  await signUp(creatorPage, creator);
  plotId = await createPlot(creatorPage, plot.name);

  await creatorPage.getByLabel('세계관 설정').fill(plot.description);
  await creatorPage.getByRole('button', { name: '도입부 추가' }).click();
  await creatorPage.getByTestId('plot-intro').fill(plot.intro);

  // Reader-facing text, both of them: the picker on the public page is where
  // they are read, so they carry the audience badge the 소개 fields carry.
  for (const [index, profile] of profiles.entries()) {
    await creatorPage.getByRole('button', { name: '프로필 추가' }).click();
    const row = profileRows().nth(index);
    await profileField(row, '이름').fill(profile.name);
    await profileField(row, '소개').fill(profile.description);
  }
  await expect(creatorPage.getByText('2/5개')).toBeVisible();

  // They ride the plot's own Save, like every other field of the row.
  await creatorPage.getByRole('button', { name: '저장', exact: true }).click();
  await expect(creatorPage.getByText('저장했습니다')).toBeVisible();

  await creatorPage.reload();
  await expect(profileRows()).toHaveCount(2);
  for (const [index, profile] of profiles.entries()) {
    await expect(profileField(profileRows().nth(index), '이름')).toHaveValue(profile.name);
    await expect(profileField(profileRows().nth(index), '소개')).toHaveValue(profile.description);
  }
});

test('an uploaded image joins the plot and the plot goes public', async () => {
  // Three hidden file inputs live on this page (cover, avatar and asset); target
  // the asset one. Its slug is proposed from the file name.
  await creatorPage.getByTestId('asset-file-input').setInputFiles({
    name: `${asset.slug}.png`,
    mimeType: 'image/png',
    buffer: asset.bytes,
  });
  await expect(creatorPage.getByLabel('슬러그')).toHaveValue(asset.slug);
  await creatorPage.getByRole('button', { name: '업로드' }).click();
  await expect(creatorPage.getByTestId('plot-asset')).toHaveCount(1);

  await creatorPage.getByRole('button', { name: '공개하기' }).click();
  await expect(creatorPage.getByRole('button', { name: '비공개로 전환' })).toBeVisible();
});

test('a reader follows the creator and starts a chat on a recommended profile', async () => {
  await signUp(readerPage, reader);
  await readerPage.goto(`/ko/p/${plotId}`);

  // Beside the creator's name, where a reader meets them.
  const follow = readerPage.getByTestId('follow-button');
  await expect(follow).toHaveText(/팔로우\s*0/);
  await follow.click();
  await expect(follow).toHaveText(/팔로잉\s*1/);

  await readerPage.reload();
  await expect(readerPage.getByTestId('follow-button')).toHaveText(/팔로잉\s*1/);

  // The work's own suggestions, offered above the reader's saved personas.
  const picks = readerPage.getByTestId('profile-pick');
  await expect(picks).toHaveCount(2);
  await expect(picks.first()).toContainText(profiles[0]!.name);
  await expect(picks.nth(1)).toContainText(profiles[1]!.description);

  await picks.nth(1).click();
  await expect(picks.nth(1)).toHaveAttribute('aria-pressed', 'true');
  // The chat carries one of the two, so picking a profile gives up the select.
  await expect(readerPage.getByLabel('페르소나')).toBeDisabled();

  await readerPage.getByRole('combobox', { name: '모델', exact: true }).selectOption('echo/echo');
  await readerPage.getByRole('button', { name: '대화 시작' }).click();
  await expect(readerPage).toHaveURL(new RegExp(`/ko/chats/${UUID_PATH}$`));

  // The pick was copied into the reader's own personas, and the chat points at
  // the copy — a row they own and may edit like any other.
  await expect
    .poll(() =>
      readerPage
        .getByLabel('페르소나')
        .evaluate((select) => (select as HTMLSelectElement).selectedOptions[0]?.textContent ?? ''),
    )
    .toBe(profiles[1]!.name);
});

test('the opening draws the plot’s image', async () => {
  const opening = assistantMessages().first();
  await expect(opening).toContainText('창고 문이 열렸다');
  await expect(openedImage()).toHaveAttribute(
    'src',
    new RegExp(`^/api/plots/${plotId}/assets/${asset.slug}(#|$)`),
  );
  await expect
    .poll(() => openedImage().evaluate((element) => (element as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  await expect(opening.getByText('{{img::')).toHaveCount(0);
});

test('the weekly tab carries the plot', async () => {
  await readerPage.goto('/ko');
  const weekly = readerPage.getByRole('button', { name: '주간 인기', exact: true });
  await weekly.click();
  await expect(weekly).toHaveAttribute('aria-pressed', 'true');
  await expect(readerPage).toHaveURL(/sort=weekly/);

  // Scoped by name: the catalogue is shared, and what is asserted here is that
  // the ranking is a listing of the same public plots, not a different set.
  await readerPage.getByPlaceholder('플롯 이름이나 보고 싶은 이야기로 검색').fill(plot.name);
  const card = readerPage.getByTestId('plot-card').filter({ hasText: plot.name });
  await expect(card).toHaveCount(1);
  await expect(card).toContainText(creator.name);
});

test('a followed creator publishing a plot rings the reader’s bell', async () => {
  // The bell is quiet until then: B followed A after the first plot went out,
  // and a publish only ever notifies the followers it had at that moment.
  await readerPage.goto('/ko');
  await expect(readerPage.getByTestId('notification-bell')).toBeVisible();
  await expect(readerPage.getByTestId('notification-badge')).toHaveCount(0);

  const secondId = await createPlot(creatorPage, followUp.name);
  await creatorPage.getByLabel('세계관 설정').fill(followUp.description);
  await creatorPage.getByRole('button', { name: '도입부 추가' }).click();
  await creatorPage.getByTestId('plot-intro').fill(followUp.intro);
  await creatorPage.getByRole('button', { name: '저장', exact: true }).click();
  await expect(creatorPage.getByText('저장했습니다')).toBeVisible();
  await creatorPage.getByRole('button', { name: '공개하기' }).click();
  await expect(creatorPage.getByRole('button', { name: '비공개로 전환' })).toBeVisible();

  // The fan-out rides the job queue now, so the row lands a beat after the
  // publish returns — and the bell only reads on mount. Reload until the walk
  // catches up rather than staring at one mount that predates it.
  await expect(async () => {
    await readerPage.reload();
    await expect(readerPage.getByTestId('notification-badge')).toHaveText('1', { timeout: 2_000 });
  }).toPass({ timeout: 20_000 });

  await readerPage.getByTestId('notification-bell').click();
  const item = readerPage.getByTestId('notification-item');
  await expect(item).toHaveCount(1);
  await expect(item).toContainText(followUp.name);
  await expect(item).toContainText(creator.name);
  await expect(item).toHaveAttribute('href', `/ko/p/${secondId}`);

  // There is no per-row read, so the panel marks them the way the API does.
  await readerPage.getByTestId('notification-read-all').click();
  await expect(readerPage.getByTestId('notification-badge')).toHaveCount(0);

  await readerPage.reload();
  await expect(readerPage.getByTestId('notification-badge')).toHaveCount(0);
});
