import { seedSession } from '../seedSession.js';
import { expect, test, type BrowserContext, type Page, type Request, type Route } from '@playwright/test';

/**
 * Group turns end to end, with the echo model: a work of three members answers
 * a turn one reply per speaker, each its own bubble under its own face — set to
 * roster order in the studio, so every member speaks and the run is the same
 * every time. Then 재생성 redoes the whole round (the swipe moves between whole
 * rounds), 이어가기 opens one of its own, 나레이션 is the narrator's, a line
 * written as a member is that member's, and 중단 stops the round. A
 * work of one member asks exactly as before, naming no speaker.
 *
 * The echo model streams the reader's own words back for every speaker, so the
 * text this spec sends names nobody: a `이름:` line would be read as that member.
 *
 * The steps build on each other, so the file runs serially with a fresh account.
 */
test.describe.configure({ mode: 'serial' });

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const account = { email: `e2e-group-${run}@example.test`, password: 'e2e-password-1234', name: 'E2E' };
const cast = [`세라${run}`, `이안${run}`, `유나${run}`] as const;
const UUID_PATH = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

let context: BrowserContext;
let page: Page;
let plotId = '';
/** Every generation request the chat made, in order. */
const generations: { path: string; body: Record<string, unknown> | null }[] = [];

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  page.on('request', (request: Request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && /\/api\/chats\/[^/]+\/(messages|regenerate|reply|continue|narrate|auto)$/.test(path)) {
      generations.push({ path: path.split('/').pop()!, body: request.postDataJSON() as Record<string, unknown> | null });
    }
  });
});

test.afterAll(async () => {
  await context.close();
});

const assistantMessages = () => page.getByTestId('message-assistant');
const userMessages = () => page.getByTestId('message-user');
/** The speaker each assistant row is drawn under, in order; null for one that names none. */
const replySpeakers = (): Promise<(string | null)[]> =>
  assistantMessages().evaluateAll((rows) =>
    rows.map((row) => row.querySelector('[data-testid="speech-character"]')?.getAttribute('data-speaker') ?? null),
  );

/**
 * Who the last `count` messages of the chat were stored as said by, by name — the
 * speaker column, not the text: the echo model writes back the reader's own
 * lines, `이름:` prefixes included, whoever it answers as.
 */
async function storedSpeakers(count: number): Promise<(string | null)[]> {
  const base = process.env['E2E_WEB_URL'] ?? 'http://localhost:13000';
  const chatId = new URL(page.url()).pathname.split('/').pop();
  const state = (await (await page.request.get(`${base}/api/chats/${chatId}`)).json()) as {
    path: { speakerMemberId: string | null }[];
  };
  const plot = (await (await page.request.get(`${base}/api/plots/${plotId}/public`)).json()) as {
    characters: { id: string; name: string }[];
  };
  const names = new Map(plot.characters.map((member) => [member.id, member.name]));
  return state.path.slice(-count).map((message) => (message.speakerMemberId ? (names.get(message.speakerMemberId) ?? null) : null));
}

async function expectComposerIdle(): Promise<void> {
  await expect(page.getByRole('button', { name: '보내기' })).toBeVisible();
  await expect(page.getByPlaceholder('메시지를 입력하세요')).toBeEnabled();
}

async function send(text: string): Promise<void> {
  await page.getByPlaceholder('메시지를 입력하세요').fill(text);
  await page.getByRole('button', { name: '보내기' }).click();
}

/** A fresh plot in the studio, named `name`, with `members` and one opening, saved. */
async function createPlot(name: string, members: readonly string[]): Promise<string> {
  await page.goto('/ko/plots');
  await page.getByRole('button', { name: '새 플롯' }).click();
  await page.getByPlaceholder('플롯 이름').fill(name);
  await page.getByRole('button', { name: '만들기', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/ko/plots/${UUID_PATH}$`));
  const id = new URL(page.url()).pathname.split('/').pop() ?? '';

  await page.getByLabel('세계관 설정').fill(`여관 하나뿐인 마을 ${run}`);
  for (const [index, member] of members.entries()) {
    await page.getByRole('button', { name: '등장인물 추가' }).click();
    const row = page.getByTestId('plot-member').nth(index);
    await row.locator('summary').click();
    await row.getByLabel('이름').fill(member);
    await row.getByLabel(/^설정/).fill(`${member}의 설정`);
  }
  await page.getByRole('button', { name: '도입부 추가' }).click();
  await page.getByTestId('plot-intro').fill(`문이 열리고 눈이 들이친다 ${run}`);
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByText('저장했습니다')).toBeVisible();
  return id;
}

/** A chat on the plot's own page, with the echo model. */
async function startChat(id: string): Promise<void> {
  await page.goto(`/ko/p/${id}`);
  await page.getByRole('combobox', { name: '모델', exact: true }).selectOption('echo/echo');
  await page.getByRole('button', { name: '대화 시작' }).click();
  await expect(page).toHaveURL(new RegExp(`/ko/chats/${UUID_PATH}$`));
  await expect(assistantMessages()).toHaveCount(1);
}

test('the studio sets how a conversation of three flows', async () => {
  await seedSession(page, account);
  plotId = await createPlot(`그룹 플롯 ${run}`, cast);

  // Offered once there are two members or more; roster order makes every member speak.
  await page.getByTestId('group-order-list').click();
  await expect(page.getByText('대화량이 0이 아닌 인물이 모두 로스터 순서대로 말합니다.')).toBeVisible();
  await expect(page.getByTestId('member-talkativeness')).toHaveCount(3);
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByText('저장했습니다')).toBeVisible();

  await page.reload();
  await expect(page.getByTestId('group-order-list')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('group-max-speakers')).toHaveValue('3');
});

test('a send is answered by each member in turn, each in a bubble under their own face', async () => {
  await startChat(plotId);
  await send(`눈이 그칠 때까지 여기서 쉬어도 될까요 ${run}`);

  await expect(assistantMessages()).toHaveCount(4);
  await expectComposerIdle();
  expect(await replySpeakers()).toEqual([null, ...cast]);
  for (const name of cast) {
    const reply = page.locator(`[data-testid="speech-character"][data-speaker="${name}"]`);
    await expect(reply).toContainText('눈이 그칠 때까지');
    // A face: the member has no picture, so its initial.
    await expect(reply.locator('span[aria-hidden]').first()).toHaveText(name[0]!);
  }
  // One round: the first with the turn, the rest joining it, the last as the final speaker.
  expect(generations.map((entry) => [entry.path, entry.body?.['finalSpeaker'], Boolean(entry.body?.['groupTurnId'])])).toEqual([
    ['messages', false, false],
    ['reply', false, true],
    ['reply', true, true],
  ]);
});

test('재생성 redoes the whole round, and the swipe moves between whole rounds', async () => {
  generations.length = 0;
  await page.getByRole('button', { name: '재생성' }).click();
  await expectComposerIdle();
  await expect(assistantMessages()).toHaveCount(4);
  expect(generations.map((entry) => entry.path)).toEqual(['regenerate', 'reply', 'reply']);

  const counter = assistantMessages().last().getByText(/^\d+\/\d+$/);
  await expect(counter).toHaveText('2/2');
  await assistantMessages().last().getByTitle('이전 응답').click();
  await expect(counter).toHaveText('1/2');
  await expect(assistantMessages()).toHaveCount(4);
  await assistantMessages().last().getByTitle('다음 응답').click();
  await expect(counter).toHaveText('2/2');
});

test('이어가기 opens a round of its own after the last reply', async () => {
  generations.length = 0;
  await page.getByRole('button', { name: '이어가기' }).click();
  await expect(assistantMessages()).toHaveCount(7);
  await expectComposerIdle();
  // A round of its own: its first reply names no round, the rest join it.
  expect(generations.map((entry) => [entry.path, Boolean(entry.body?.['groupTurnId'])])).toEqual([
    ['reply', false],
    ['reply', true],
    ['reply', true],
  ]);
});

test('나레이션 is the narrator’s, as its own row', async () => {
  const narrations = await page.getByTestId('message-narration').count();
  await page.getByRole('button', { name: '나레이션' }).click();
  await expect(page.getByTestId('message-narration')).toHaveCount(narrations + 1);
  await expectComposerIdle();
});

test('a line written as a member is drawn as theirs, and they sit the round out', async () => {
  generations.length = 0;
  await page.getByTestId('write-as').click();
  await page.getByRole('button', { name: `${cast[1]}의 말` }).click();
  await expect(page.getByTestId('write-as')).toHaveText(`${cast[1]}의 말`);
  await send(`눈 치우는 건 내가 할게 ${run}`);

  await expect(userMessages()).toHaveCount(2);
  const turn = userMessages().last();
  const written = turn.getByTestId('speech-character');
  await expect(written).toHaveAttribute('data-speaker', cast[1]);
  await expect(written).toContainText('눈 치우는 건 내가 할게');
  await expect(turn).not.toContainText('@');
  await expectComposerIdle();
  // Stored as typed, and the round goes to the other two.
  expect(generations[0]!.body?.['content']).toBe(`@${cast[1]}: 눈 치우는 건 내가 할게 ${run}`);
  expect(generations).toHaveLength(2);
  expect(await storedSpeakers(2)).toEqual([cast[0], cast[2]]);
  // Back to the reader's own voice for what follows.
  await page.getByTestId('write-as').click();
  await page.getByRole('button', { name: '내 말' }).click();
});

test('중단 stops the round between speakers: what is stored stays, and nobody after is asked', async () => {
  generations.length = 0;
  const before = await assistantMessages().count();
  // The second speaker's request is held, so the reader stops the round while
  // it is out: the first reply is stored, and the third speaker is never asked.
  let held: Route | null = null;
  await page.route('**/api/chats/*/reply', (route) => {
    held = route;
  });
  await send(`눈이 더 오기 전에 장작을 들여야겠어요 ${run}`);

  await expect(page.getByTestId('typing')).toHaveAttribute('data-speaker', cast[1]);
  await expect(page.getByTestId('round-next')).toHaveText(`다음: ${cast[2]}`);
  await expect(assistantMessages()).toHaveCount(before + 2);
  await page.getByRole('button', { name: '중단' }).click();
  await expectComposerIdle();
  await page.unroute('**/api/chats/*/reply');
  await (held as Route | null)?.abort().catch(() => undefined);

  await expect(page.getByTestId('round-next')).toHaveCount(0);
  await expect(page.getByTestId('typing')).toHaveCount(0);
  await expect(assistantMessages()).toHaveCount(before + 1);
  expect(await storedSpeakers(1)).toEqual([cast[0]]);
  expect(generations.map((entry) => [entry.path, entry.body?.['finalSpeaker']])).toEqual([
    ['messages', false],
    ['reply', false],
  ]);
});

test('a work of one member asks as it always has', async () => {
  const soloId = await createPlot(`혼자 플롯 ${run}`, [`리안${run}`]);
  await expect(page.getByTestId('group-order-natural')).toHaveCount(0);
  await startChat(soloId);
  await expect(page.getByTestId('write-as')).toHaveCount(0);
  await expect(page.getByTestId('focus-picker')).toHaveCount(0);

  generations.length = 0;
  await send(`안녕하세요 ${run}`);
  await expect(assistantMessages()).toHaveCount(2);
  await expectComposerIdle();
  expect(generations).toEqual([{ path: 'messages', body: { content: `안녕하세요 ${run}` } }]);
});
