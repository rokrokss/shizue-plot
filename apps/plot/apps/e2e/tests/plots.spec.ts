import { seedSession } from '../seedSession.js';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * The roster layer of a plot, along the owner's own path: a plot refuses to be
 * published until it says something → three characters join it → the order the
 * creator arranges them in is the order that is stored → one of them leaves →
 * the published plot page shows what is left, in that order → deleting the
 * plot takes the whole work with it.
 *
 * The steps build on each other, so the file runs serially. Every run uses a
 * fresh account and its own plot; only that plot is deleted, because this hits
 * the dev database.
 */
test.describe.configure({ mode: 'serial' });

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const owner = {
  email: `plot-${run}@example.test`,
  password: 'e2e-password-1234',
  name: `플롯 제작자 ${run}`,
};
const plot = {
  name: `아르카디아 ${run}`,
  description: `마법이 흔한 도시국가 ${run}. 다섯 길드가 도시를 나눠 다스린다.`,
};
/** Three, so a move has somewhere to move to and a removal leaves a middle. */
const cast = [`길드장${run}`, `전령${run}`, `문지기${run}`];
const intro = `종이 울리자 광장이 비었다 ${run}\n${cast[0]}: 늦었군.`;

const UUID_PATH = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

let context: BrowserContext;
let page: Page;
let plotId = '';

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
});

test.afterAll(async () => {
  await context.close();
});

const members = () => page.getByTestId('plot-member');

/** A member's card, opened so the controls inside it are reachable. */
async function openMember(index: number) {
  const member = members().nth(index);
  // The card is a <details>, so what "open" means is its own property rather
  // than an attribute a click could be guessed from.
  if (!(await member.evaluate((row) => (row as HTMLDetailsElement).open))) {
    await member.locator('summary').click();
  }
  return member;
}

/** The roster as the editor is showing it, row by row. */
async function expectOrder(names: string[]): Promise<void> {
  await expect(members()).toHaveCount(names.length);
  for (const [index, name] of names.entries()) {
    await expect(members().nth(index)).toContainText(name);
  }
}

test('a plot refuses to be published until it says something', async () => {
  await seedSession(page, owner);
  await expect(page).toHaveURL(/\/ko$/);

  await page.goto('/ko/plots');
  await page.getByRole('button', { name: '새 플롯' }).click();
  await page.getByPlaceholder('플롯 이름').fill(plot.name);
  await page.getByRole('button', { name: '만들기', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/ko/plots/${UUID_PATH}$`));
  plotId = new URL(page.url()).pathname.split('/').pop() ?? '';

  // A name alone is not a work: the publish is refused by the server, and the
  // panel says which of the three it is missing.
  await page.getByRole('button', { name: '공개하기' }).click();
  await expect(page.getByText('제목·세계관·도입부를 모두 채워야 공개할 수 있습니다.')).toBeVisible();
  await expect(page.getByRole('button', { name: '공개하기' })).toBeVisible();
});

test('three characters join the plot', async () => {
  await page.getByLabel('세계관 설정').fill(plot.description);
  await page.getByRole('button', { name: '도입부 추가' }).click();
  await page.getByTestId('plot-intro').fill(intro);

  for (const [index, name] of cast.entries()) {
    await page.getByRole('button', { name: '등장인물 추가' }).click();
    const row = await openMember(index);
    await row.getByLabel('이름').fill(name);
  }
  await expect(page.getByText('3/10명')).toBeVisible();

  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByText('저장했습니다')).toBeVisible();

  await page.reload();
  await expectOrder(cast);
});

test('the creator rearranges the roster and the order is stored', async () => {
  const last = await openMember(2);
  // A move is an order rather than an edit, so it answers for itself — no save.
  await Promise.all([
    page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.url().includes('/reorder'),
    ),
    last.getByRole('button', { name: '위로 옮기기' }).click(),
  ]);
  await expectOrder([cast[0]!, cast[2]!, cast[1]!]);

  await page.reload();
  await expectOrder([cast[0]!, cast[2]!, cast[1]!]);
});

test('a character leaves the plot', async () => {
  const middle = await openMember(1);
  // Removing asks first, and Playwright dismisses dialogs unless told otherwise.
  page.once('dialog', (dialog) => void dialog.accept());
  await middle.getByRole('button', { name: `${cast[2]} 삭제` }).click();

  await expect(members()).toHaveCount(2);
  await page.reload();
  await expectOrder([cast[0]!, cast[1]!]);
});

test('the published plot page carries what is left, in that order', async () => {
  await page.getByRole('button', { name: '공개하기' }).click();
  await expect(page.getByRole('button', { name: '비공개로 전환' })).toBeVisible();

  await page.goto(`/ko/p/${plotId}`);
  await expect(page.getByRole('heading', { name: plot.name })).toBeVisible();
  await expect(members()).toHaveCount(2);
  await expect(members().first()).toContainText(cast[0]!);
  await expect(members().last()).toContainText(cast[1]!);
  // The opening reads as prose: the speaker prefix is protocol, not text.
  await expect(page.getByTestId('intro-text')).toContainText('종이 울리자 광장이 비었다');
});

test('deleting the plot takes the whole work with it', async () => {
  await page.goto(`/ko/plots/${plotId}`);
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: '플롯 삭제' }).click();

  await expect(page).toHaveURL(/\/ko\/plots$/);
  await expect(page.getByTestId('plot-row').filter({ hasText: plot.name })).toHaveCount(0);

  // …and its public page is gone with it, for its own owner too.
  await page.goto(`/ko/p/${plotId}`);
  await expect(page.getByText('플롯을 찾을 수 없거나 공개되지 않았습니다.')).toBeVisible();
});
