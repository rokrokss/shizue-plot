import { seedSession } from '../seedSession.js';
import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';

/**
 * The language modes: an English work read on the Korean page.
 *
 * The mode is decided for the reader — the reply-language instruction — and
 * only the opening is translated; a reply is never asked about. Picking the
 * translation mode (RisuAI's) translates every message, with the original a
 * tap away, and the reader's own turn goes out in English.
 *
 * The test API's auxiliary model is echo, which would "translate" every text into
 * itself; the two translation routes are answered here instead, so what is drawn
 * is visibly the translation.
 */
test.describe.configure({ mode: 'serial' });

const base = process.env['E2E_WEB_URL'] ?? 'http://localhost:13000';
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const account = { email: `e2e-tr-${run}@example.test`, password: 'e2e-password-1234', name: 'E2E' };
const opening = '*Rian shakes the rain off his cloak.* Hello, traveler. The inn is warm tonight.';
const mine = '들어가도 될까요? *문을 두드린다*';
const sent = 'May I come in? *knocks on the door*';
/** What the stand-in translator knows; anything else comes back marked. */
const KOREAN: Record<string, string> = {
  [opening]: '*리안이 망토의 빗물을 털어 낸다.* 어서 와요, 여행자님. 오늘 밤 여관은 따뜻하답니다.',
  [sent]: mine,
  // The turn read before the mode changed: echo wrote it in Korean, so this marks it as translated.
  안녕하세요: '안녕하세요!',
};

let context: BrowserContext;
let page: Page;
let chatId = '';
/** Every message the page asked to have translated, by id. */
const asked: string[] = [];

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  await page.route('**/api/chats/*/messages/*/translation', async (route: Route) => {
    const { texts } = route.request().postDataJSON() as { texts: string[] };
    asked.push(route.request().url().split('/messages/')[1]!.split('/')[0]!);
    await route.fulfill({
      json: { texts: Object.fromEntries(texts.map((text) => [text, KOREAN[text] ?? `[ko] ${text}`])) },
    });
  });
  await page.route('**/api/chats/*/translate-input', async (route: Route) => {
    const { text } = route.request().postDataJSON() as { text: string };
    await route.fulfill({ json: { text: text === mine ? sent : `[en] ${text}` } });
  });
});

test.afterAll(async () => {
  await context.close();
});

const assistantMessages = () => page.getByTestId('message-assistant');
const userMessages = () => page.getByTestId('message-user');

test('an English work on the Korean page answers in Korean and translates only its opening', async () => {
  await seedSession(page, account);
  const post = (path: string, data: unknown) => page.request.post(`${base}${path}`, { headers: { origin: base }, data });
  const made = await post('/api/plots', {
    name: `Rainy inn ${run}`,
    language: 'en',
    description: 'An inn at the edge of a rainy town.',
    intros: [opening],
  });
  expect(made.status()).toBe(201);
  const plotId = (await made.json()).id as string;
  expect((await post(`/api/plots/${plotId}/characters`, { name: 'Rian', card: { description: 'The innkeeper.' } })).status()).toBe(201);
  // A display script that reads the reply: the card recommends the translation mode.
  const patched = await page.request.patch(`${base}/api/plots/${plotId}`, {
    headers: { origin: base },
    data: { customUi: { displayScripts: [{ in: '\\[HP: (\\d+)\\]', out: '<b>HP $1</b>', order: 0, enabled: true }] } },
  });
  expect(patched.status()).toBe(200);
  const started = await post('/api/chats', { plotId, model: 'echo/echo' });
  expect(started.status()).toBe(201);
  chatId = (await started.json()).chat.id;

  await page.goto(`/ko/chats/${chatId}`);
  const intro = assistantMessages().first();
  await expect(intro).toContainText('어서 와요, 여행자님');
  const toggle = intro.getByTestId('message-translation');
  await expect(toggle).toHaveText('번역됨 · 원문 보기');
  await toggle.click();
  await expect(intro).toContainText('Hello, traveler.');
  await expect(toggle).toHaveText('원문 · 번역 보기');
  await toggle.click();
  await expect(intro).toContainText('어서 와요, 여행자님');

  // The mode was decided for the reader, and the card's scripts recommend the other one.
  const mode = page.getByLabel('언어 모드');
  await expect(mode).toHaveValue('');
  await expect(mode.locator('option').first()).toHaveText('자동 (답장 언어 지시)');
  await expect(mode).toHaveAttribute('title', '이 카드는 번역 모드를 권장해요');

  // A reply is written in Korean by the model, so nothing asks about it.
  const before = asked.length;
  await page.getByPlaceholder('메시지를 입력하세요').fill('안녕하세요');
  // The server learns the page's language with the turn: that is what puts the reply-language line in.
  const [turn] = await Promise.all([
    page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith(`/api/chats/${chatId}/messages`)),
    page.getByRole('button', { name: '보내기', exact: true }).click(),
  ]);
  expect(turn.headers()['x-shizue-locale']).toBe('ko');
  await expect(assistantMessages().last()).toContainText('안녕하세요');
  await expect(page.getByRole('button', { name: '보내기' })).toBeVisible();
  await page.waitForTimeout(500);
  expect(asked.slice(before)).toEqual([]);
  await expect(assistantMessages().last().getByTestId('message-translation')).toHaveCount(0);
});

test('the translation mode translates every message and sends the reader turn in English', async () => {
  const mode = page.getByLabel('언어 모드');
  await Promise.all([
    page.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().includes(`/api/chats/${chatId}`)),
    mode.selectOption('translate'),
  ]);
  // The reply written before is translated now, and so is the reader's turn.
  await expect(assistantMessages().last()).toContainText('안녕하세요!');
  await expect(userMessages().last().getByTestId('message-translation')).toBeVisible();

  const input = page.getByLabel('내 메시지를 English로 번역해서 보내기');
  await Promise.all([
    page.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().includes(`/api/chats/${chatId}`)),
    input.click(),
  ]);
  await expect(input).toBeChecked();
  await expect(page.getByPlaceholder('English로 번역해 보내요…')).toBeVisible();

  await page.getByPlaceholder('English로 번역해 보내요…').fill(mine);
  await page.getByRole('button', { name: '보내기', exact: true }).click();
  // Stored and echoed in English; drawn in Korean, the English one tap away.
  const reply = assistantMessages().last();
  await expect(reply).toContainText('들어가도 될까요?');
  await reply.getByTestId('message-translation').click();
  await expect(reply).toContainText('May I come in?');
  await reply.getByTestId('message-translation').click();
  await expect(reply).toContainText('들어가도 될까요?');
});

/** Resolves once the chat's settings write has been answered. */
const settingsWrite = () =>
  page.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().includes(`/api/chats/${chatId}`));

test('reads at a phone width, in both themes', async () => {
  await page.setViewportSize({ width: 375, height: 812 });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`/ko/chats/${chatId}`);
    const reply = assistantMessages().last();
    await expect(reply).toContainText('들어가도 될까요?');
    await expect(reply.getByTestId('message-translation')).toHaveText('번역됨 · 원문 보기');
    await page.screenshot({ path: `test-results/translation/reply-${scheme}.png` });

    // The settings sheet: the mode the reader picked, and the recommendation once it is automatic.
    await page.getByRole('button', { name: '대화 설정' }).click();
    const sheet = page.getByRole('dialog');
    const mode = sheet.getByLabel('언어 모드');
    await mode.scrollIntoViewIfNeeded();
    await expect(mode).toHaveValue('translate');
    await page.screenshot({ path: `test-results/translation/settings-translate-${scheme}.png` });
    await Promise.all([settingsWrite(), mode.selectOption('')]);
    const hint = sheet.getByTestId('translate-recommended');
    await expect(hint).toHaveText('이 카드는 번역 모드를 권장해요');
    await hint.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/translation/settings-recommended-${scheme}.png` });
    await Promise.all([settingsWrite(), mode.selectOption('translate')]);

    // The author's note, with where and how often it goes.
    await sheet.getByRole('button', { name: '노트', exact: true }).click();
    const settings = page.getByTestId('author-note-settings');
    await settings.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/translation/author-note-${scheme}.png` });
  }
});
