import { seedSession } from '../seedSession.js';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * Style feature walk: signup → a plot whose 스타일 섹션 is filled in (length,
 * difficulty, pacing, moods with the cap evicting the oldest, 상태창, 선택지) →
 * the badges the public page shows from it → an echo chat where the two derived
 * conventions are read back — the intro's own status block, a turn that ends with
 * a ```status fence and `>> ` lines, the card that folds once and stays folded,
 * the choice buttons under the newest reply only — and the reader's own toggles.
 *
 * The echo model streams the last user message back verbatim, so a turn written
 * in the conventions is exactly the reply the renderer has to read.
 *
 * Serial like the rest of the suite: one context, fresh account, dev database.
 */
test.describe.configure({ mode: 'serial' });

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const account = { email: `e2e-st-${run}@example.test`, password: 'e2e-password-1234', name: 'E2E' };
/** The first scene's status rides the intro text — the convention needs no field. */
const intro = [
  `여관 문이 닫히자 빗소리가 멀어졌다 ${run}`,
  '```status',
  '위치: 여관 로비',
  '시간: 자정',
  '```',
].join('\n');
const plot = {
  name: `스타일 플롯 ${run}`,
  description: `비가 그치지 않는 항구 도시 ${run}`,
  intro,
};
/** A turn in both conventions: the status block first, the offers after it. */
const styledTurn = [
  `문을 열자 복도가 비어 있었다 ${run}`,
  '```status',
  '위치: 2층 복도',
  '동행: 없음',
  '```',
  '>> 방을 둘러본다',
  '>> 복도로 나선다',
].join('\n');
/** A fence with prose after it: quoted text, not the state the turn ended on. */
const interiorTurn = [
  `간판이 흔들렸다 ${run}`,
  '```status',
  '위치: 골목',
  '```',
  `그리고 다시 조용해졌다 ${run}`,
].join('\n');

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

const composer = () => page.getByPlaceholder('메시지를 입력하세요');
const assistantMessages = () => page.getByTestId('message-assistant');
const userMessages = () => page.getByTestId('message-user');
const statusCards = () => page.getByTestId('status-card');
const choiceGroups = () => page.getByTestId('message-choices');

/** One style option's chip. The editor names each by the key it sets. */
const chip = (name: string, value: string) => page.getByTestId(`style-${name}-${value}`);
/** Whether that chip is the chosen one; the row answers with aria-pressed. */
async function expectChosen(name: string, value: string, chosen = true): Promise<void> {
  await expect(chip(name, value)).toHaveAttribute('aria-pressed', String(chosen));
}

async function expectComposerIdle(): Promise<void> {
  await expect(composer()).toBeEnabled();
  await expect(page.getByRole('button', { name: '보내기' })).toBeVisible();
}

/** The notes panel, opened only when it is not already showing. */
async function openPanel(): Promise<void> {
  const toggle = page.getByRole('button', { name: '노트', exact: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(page.getByTestId('chat-panel')).toBeVisible();
}

/** Resolves once a chat settings write has been answered. */
const chatWrite = () =>
  page.waitForResponse(
    (response) => response.request().method() === 'PATCH' && response.url().includes('/api/chats/'),
  );

/** Sends a turn and waits for the echo to land as a new reply. */
async function sendTurn(text: string): Promise<void> {
  const before = await assistantMessages().count();
  await composer().fill(text);
  await page.getByRole('button', { name: '보내기' }).click();
  await expect(assistantMessages()).toHaveCount(before + 1);
  await expectComposerIdle();
}

test('the creator sets the plot style and it survives a reload', async () => {
  await seedSession(page, account);
  await expect(page).toHaveURL(/\/ko$/);

  await page.goto('/ko/plots');
  await page.getByRole('button', { name: '새 플롯' }).click();
  await page.getByPlaceholder('플롯 이름').fill(plot.name);
  await page.getByRole('button', { name: '만들기', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/ko/plots/${UUID_PATH}$`));
  plotId = new URL(page.url()).pathname.split('/').pop() ?? '';

  await page.getByLabel('세계관 설정').fill(plot.description);
  await page.getByRole('button', { name: '도입부 추가' }).click();
  await page.getByTestId('plot-intro').fill(plot.intro);

  // The narrator lives in the style section now: the point of view is an option
  // like the rest, and it is the one that reaches the public badges.
  const section = page.getByTestId('plot-style');
  await expect(section).toBeVisible();
  await section.getByLabel('나레이션 시점').selectOption({ label: '3인칭 관찰자' });

  await chip('replyLength', 'short').click();
  await chip('difficulty', 'hard').click();
  await chip('pacing', 'slow').click();
  // Two moods fit, and the third makes room rather than being refused.
  await chip('moods', 'romance').click();
  await chip('moods', 'healing').click();
  await chip('moods', 'fantasy').click();
  await expectChosen('moods', 'romance', false);

  await section.getByLabel('상태창 사용').check();
  await chip('choices', 'sentences').click();

  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByText('저장했습니다')).toBeVisible();

  // The style is the server's now, option by option.
  await page.reload();
  await expectChosen('replyLength', 'short');
  await expectChosen('difficulty', 'hard');
  await expectChosen('pacing', 'slow');
  await expectChosen('moods', 'healing');
  await expectChosen('moods', 'fantasy');
  await expectChosen('moods', 'romance', false);
  await expectChosen('choices', 'sentences');
  await expect(page.getByTestId('plot-style').getByLabel('상태창 사용')).toBeChecked();
  await expect(page.getByTestId('plot-style').getByLabel('나레이션 시점')).toHaveValue('third');
  await page.screenshot({ path: 'test-results/style-01-editor.png', fullPage: true });
});

test('the published plot page wears the style as badges', async () => {
  await page.getByRole('button', { name: '공개하기' }).click();
  await expect(page.getByRole('button', { name: '비공개로 전환' })).toBeVisible();

  await page.goto(`/ko/p/${plotId}`);
  const badges = page.getByTestId('plot-style-badges').getByRole('listitem');
  // The moods, then the two options that are not at their default, then the pov.
  // An option left alone says nothing here — 응답 길이·선택지·상태창 are the
  // creator's craft rather than a fact a reader decides on.
  await expect(badges).toHaveCount(5);
  await expect(badges.nth(0)).toHaveText('힐링');
  await expect(badges.nth(1)).toHaveText('판타지');
  await expect(badges.nth(2)).toHaveText('높은 난이도');
  await expect(badges.nth(3)).toHaveText('느린 전개');
  await expect(badges.nth(4)).toHaveText('3인칭 관찰자');
  await page.screenshot({ path: 'test-results/style-02-badges.png', fullPage: true });
});

test('the chat opens on an intro that carries the first scene status', async () => {
  await page.getByLabel('모델').selectOption('echo/echo');
  await page.getByRole('button', { name: '대화 시작' }).click();
  await expect(page).toHaveURL(new RegExp(`/ko/chats/${UUID_PATH}$`));

  const opening = assistantMessages().first();
  await expect(opening).toContainText('여관 문이 닫히자');
  const card = opening.getByTestId('status-card');
  await expect(card.locator('dt').first()).toHaveText('위치');
  await expect(card.locator('dd').first()).toHaveText('여관 로비');
  // The fence is markup: the card is where it went, not the text.
  await expect(opening).not.toContainText('```');
});

test('a turn that ends in a status block and choices is read back as both', async () => {
  await sendTurn(styledTurn);

  const reply = assistantMessages().last();
  await expect(reply).toContainText('문을 열자 복도가 비어 있었다');
  const card = reply.getByTestId('status-card');
  await expect(card.locator('dt').first()).toHaveText('위치');
  await expect(card.locator('dd').first()).toHaveText('2층 복도');
  await expect(card.locator('dt').nth(1)).toHaveText('동행');
  // Neither convention is left in the prose it was written after.
  await expect(reply).not.toContainText('```');
  await expect(reply).not.toContainText('>>');

  // The offer stands under the newest reply and nowhere else — the reader's own
  // turn carried the same lines and is not offering anything.
  await expect(choiceGroups()).toHaveCount(1);
  await expect(reply.getByTestId('message-choices')).toBeVisible();
  await expect(userMessages().last().getByTestId('message-choices')).toHaveCount(0);
  await expect(reply.getByRole('button', { name: '방을 둘러본다' })).toBeVisible();
  await page.screenshot({ path: 'test-results/style-03-status-choices.png', fullPage: true });
});

test('a newer offer withdraws the older one', async () => {
  // Both replies carry choice lines; only the newest may keep its buttons — an
  // implementation that renders every choice-bearing reply fails on the count.
  await sendTurn('복도 끝으로 걸었다.\n\n>> 계단을 오른다\n>> 소리를 따라간다');

  const reply = assistantMessages().last();
  await expect(reply.getByRole('button', { name: '계단을 오른다' })).toBeVisible();
  await expect(choiceGroups()).toHaveCount(1);
  await expect(page.getByRole('button', { name: '방을 둘러본다' })).toHaveCount(0);
});

test('taking a choice writes it into the composer and stops there', async () => {
  const sent = await userMessages().count();

  await assistantMessages().last().getByRole('button', { name: '소리를 따라간다' }).click();

  await expect(composer()).toHaveValue('소리를 따라간다');
  // Sending is the reader's, as it is for a display script's button.
  await expect(userMessages()).toHaveCount(sent);
  await composer().fill('');
});

test('folding one status card folds this chat, and it stays folded', async () => {
  const fold = statusCards().first().getByRole('button');
  await expect(fold).toHaveAttribute('aria-expanded', 'true');
  await fold.click();

  // One answer for the whole conversation: the card is the same handful of rows
  // every turn, so folding one is said about the chat.
  for (const card of await statusCards().all()) {
    await expect(card.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  }

  await page.reload();
  await expect(statusCards().first()).toBeVisible();
  await expect(statusCards().first().getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  await page.screenshot({ path: 'test-results/style-04-folded.png', fullPage: true });
});

test('the panel offers the two features the plot turned on', async () => {
  await openPanel();
  const features = page.getByTestId('chat-plot-features');
  await expect(features).toBeVisible();

  const statusToggle = features.getByLabel('상태창 사용');
  const choicesToggle = features.getByLabel('선택지 사용');
  await expect(statusToggle).toBeChecked();
  await expect(choicesToggle).toBeChecked();

  // click(), not uncheck(): each box follows the server round-trip.
  await Promise.all([chatWrite(), statusToggle.click()]);
  await expect(statusToggle).not.toBeChecked();
  await Promise.all([chatWrite(), choicesToggle.click()]);
  await expect(choicesToggle).not.toBeChecked();
  // The reader's answer reaches the message list: an offer nobody wants is not
  // made, whatever lines an older turn still carries.
  await expect(choiceGroups()).toHaveCount(0);

  await page.reload();
  await openPanel();
  const reloaded = page.getByTestId('chat-plot-features');
  await expect(reloaded.getByLabel('상태창 사용')).not.toBeChecked();
  await expect(reloaded.getByLabel('선택지 사용')).not.toBeChecked();
  await page.screenshot({ path: 'test-results/style-05-reader-toggles.png', fullPage: true });
});

test('a fence with prose after it stays the text it is', async () => {
  await sendTurn(interiorTurn);

  const reply = assistantMessages().last();
  // Only a fence the turn actually ends on is the current state; this one is
  // quoted text and reads as the code block it was written as.
  await expect(reply.getByTestId('status-card')).toHaveCount(0);
  await expect(reply).toContainText('위치: 골목');
  await expect(reply).toContainText('그리고 다시 조용해졌다');
});
