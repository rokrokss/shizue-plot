import { seedSession } from '../seedSession.js';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * Narrator feature walk: signup → plot with a narrator (voice + pov) → echo
 * chat → composer `*` direction toggle → the three composer modes → `@:`
 * narration message → narrate action → regenerate keeps the narration →
 * chat-level override panel.
 *
 * Serial like the smoke suite: one context, fresh account, dev database.
 */
test.describe.configure({ mode: 'serial' });

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const account = { email: `e2e-nr-${run}@example.test`, password: 'e2e-password-1234', name: 'E2E' };
const plot = {
  name: `내레이터 플롯 ${run}`,
  description: `테스트용 세계관 ${run}`,
  intro: `첫 장면 ${run}`,
  narratorVoice: `건조하고 짧게 쓴다 ${run}`,
};
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
const narrationMessages = () => page.getByTestId('message-narration');

async function expectComposerIdle(): Promise<void> {
  await expect(composer()).toBeEnabled();
  await expect(page.getByRole('button', { name: '보내기' })).toBeVisible();
}

/** Picks how the next turn is written: dialogue, 상황묘사, or the narrator's. */
async function pickMode(label: '대사' | '묘사' | '내레이터'): Promise<void> {
  await page.getByRole('button', { name: label, exact: true }).click();
}

test('signs up and gives a plot a narrator voice and pov', async () => {
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

  // The narrator belongs to the work, beside the world it tells.
  await page.getByLabel('나레이터 문체').fill(plot.narratorVoice);
  await page.getByLabel('나레이션 시점').selectOption({ label: '3인칭 전지적' });

  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByText('저장했습니다')).toBeVisible();

  // The saved plot round-trips: reload and both fields are still set.
  await page.reload();
  await expect(page.getByLabel('나레이터 문체')).toHaveValue(plot.narratorVoice);
  await expect(page.getByLabel('나레이션 시점')).toHaveValue('omniscient');
  await page.screenshot({ path: 'test-results/narrator-01-editor.png', fullPage: true });
});

test('starts an echo chat', async () => {
  await page.goto(`/ko/p/${plotId}`);
  await page.getByLabel('모델').selectOption('echo/echo');
  await page.getByRole('button', { name: '대화 시작' }).click();
  await expect(page).toHaveURL(new RegExp(`/ko/chats/${UUID_PATH}$`));
  await expect(assistantMessages().first()).toContainText(plot.intro);
});

test('the composer * button wraps and unwraps a stage direction', async () => {
  const field = composer();
  await field.fill('문을 연다');
  await field.selectText();
  await page.getByRole('button', { name: '지문' }).click();
  await expect(field).toHaveValue('*문을 연다*');

  // Same button on the wrapped selection takes the stars off again.
  await field.selectText();
  await page.getByRole('button', { name: '지문' }).click();
  await expect(field).toHaveValue('문을 연다');

  // Empty caret: the button inserts a pair and typing lands between the stars.
  await field.fill('');
  await page.getByRole('button', { name: '지문' }).click();
  await page.keyboard.type('고개를 돌린다');
  await expect(field).toHaveValue('*고개를 돌린다*');
  await field.fill('');
});

test('the 묘사 mode marks the turn on its way out', async () => {
  await pickMode('묘사');
  await composer().fill(`문을 밀고 들어선다 ${run}`);
  await page.getByRole('button', { name: '보내기' }).click();

  // The mode is a way of typing, not a column: what is stored is the same `*…*`
  // a reader could have typed, so the turn is drawn as their 상황묘사.
  const sent = userMessages().last();
  await expect(sent.locator('em')).toContainText('문을 밀고 들어선다');
  await expectComposerIdle();
  await pickMode('대사');
});

test('the 내레이터 mode renders as a speaker-less narration row', async () => {
  await pickMode('내레이터');
  await composer().fill(`문이 열리고 바람이 들이쳤다 ${run}`);
  await page.getByRole('button', { name: '보내기' }).click();

  await expect(narrationMessages().first()).toContainText('문이 열리고 바람이 들이쳤다');
  // The prefix is convention, not content: it never renders.
  await expect(narrationMessages().first()).not.toContainText('@:');
  await expectComposerIdle();
  await pickMode('대사');
  await page.screenshot({ path: 'test-results/narrator-02-user-narration.png', fullPage: true });
});

test('the narrate action produces an assistant narration turn', async () => {
  await page.getByRole('button', { name: '나레이션', exact: true }).click();

  // The generated turn lands as a narration row, not an assistant bubble.
  await expect(narrationMessages()).toHaveCount(2);
  await expectComposerIdle();
  await page.screenshot({ path: 'test-results/narrator-03-narrate-turn.png', fullPage: true });
});

test('regenerating the narration head stays a narration', async () => {
  await page.getByRole('button', { name: '재생성' }).click();

  await expect(narrationMessages()).toHaveCount(2);
  await expect(narrationMessages().last().getByText(/^\d+\/\d+$/)).toHaveText('2/2');
  await expectComposerIdle();
});

test('the chat panel saves a narrator override', async () => {
  await page.getByRole('button', { name: '노트', exact: true }).click();
  const section = page.getByTestId('chat-narrator');
  await expect(section).toBeVisible();

  // The pov select saves on change; the voice drafts until its own save button.
  const povWrite = page.waitForResponse(
    (response) => response.request().method() === 'PATCH' && response.url().includes('/api/chats/'),
  );
  await section.getByLabel('나레이션 시점').selectOption({ label: '3인칭 관찰자' });
  await povWrite;

  await section.getByLabel('나레이터 문체').fill(`이 대화만 시적으로 ${run}`);
  const voiceWrite = page.waitForResponse(
    (response) => response.request().method() === 'PATCH' && response.url().includes('/api/chats/'),
  );
  await section.getByRole('button', { name: '저장', exact: true }).click();
  await voiceWrite;

  await page.reload();
  await page.getByRole('button', { name: '노트', exact: true }).click();
  const reloaded = page.getByTestId('chat-narrator');
  await expect(reloaded.getByLabel('나레이터 문체')).toHaveValue(`이 대화만 시적으로 ${run}`);
  await expect(reloaded.getByLabel('나레이션 시점')).toHaveValue('third');
  await page.screenshot({ path: 'test-results/narrator-04-chat-override.png', fullPage: true });
});
