import { seedSession } from '../seedSession.js';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * End-to-end smoke path: test session → plot → two members → openings → publish →
 * chat from the plot's own page → opening swipe → echo turn read back as the
 * speakers who wrote it → regenerate/swipe → edit → author note → locale switch
 * → logout.
 *
 * The steps share one browser context (the session cookie) and build on each
 * other, so the file runs serially and stops at the first failure. Every run
 * uses a fresh account and creates its own rows; nothing is deleted, because
 * this hits the dev database.
 */
test.describe.configure({ mode: 'serial' });

const MESSAGES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/messages');

/** Read at run time — the catalogs are owned elsewhere and may change. */
function messages(locale: string): { nav: { create: string } } {
  return JSON.parse(readFileSync(resolve(MESSAGES_DIR, `${locale}.json`), 'utf8')) as {
    nav: { create: string };
  };
}

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const account = { email: `e2e-${run}@example.test`, password: 'e2e-password-1234', name: 'E2E' };
const plot = {
  name: `E2E 플롯 ${run}`,
  intro: `독자에게 건네는 소개 ${run}`,
  description: `비가 그치지 않는 도시 ${run}. 다섯 길드가 도시를 나눠 다스린다.`,
};
/**
 * The roster. The names are written into the openings and typed into the
 * composer, because the speech protocol matches a `이름: ` prefix against this
 * exact string — the name is the whole attribution mechanism.
 */
const cast = [
  { name: `세라${run}`, description: `길드의 전령 ${run}` },
  { name: `이안${run}`, description: `문 앞을 지키는 사람 ${run}` },
] as const;
/** Each opening is one narrator line and one character line, per the protocol. */
const intros = [
  `비가 그치지 않는 밤이었다 ${run}\n${cast[0].name}: *우산을 접으며* 늦었네, 기다렸어.`,
  `문이 닫히자 복도가 조용해졌다 ${run}\n${cast[1].name}: 여기서 뭐 해?`,
];
/** A turn shaped like a reply, so the echo streams the protocol back at us. */
const firstTurn = `창밖은 아직 어둡다 ${run}\n${cast[0].name}: 안녕 *웃으며* 반가워`;
const editedTurn = `수정된 메시지 ${run}`;
const note = `비 오는 밤이다 ${run}`;
const savedNote = { title: `저장 노트 ${run}`, content: `공용 노트 본문입니다 ${run}` };

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

/** The composer is enabled again and back to its idle "send" state. */
async function expectComposerIdle(): Promise<void> {
  await expect(page.getByPlaceholder('메시지를 입력하세요')).toBeEnabled();
  await expect(page.getByRole('button', { name: '보내기' })).toBeVisible();
}

/** The notes panel, opened only when it is not already showing. */
async function openPanel(): Promise<void> {
  const toggle = page.getByRole('button', { name: '노트', exact: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(page.getByTestId('chat-panel')).toBeVisible();
}

/** Resolves once a chat settings write has been answered. */
const chatWrite = (method: string, path = '/api/chats/') =>
  page.waitForResponse(
    (response) => response.request().method() === method && response.url().includes(path),
  );

const assistantMessages = () => page.getByTestId('message-assistant');
const userMessages = () => page.getByTestId('message-user');
/** Swipe counter of the last assistant message, e.g. "2/2". */
const swipeCounter = () => assistantMessages().last().getByText(/^\d+\/\d+$/);
/**
 * Swipe arrows of the last assistant message. Scoped like the counter: once a
 * chat holds a swiped opening and a regenerated reply, both rows carry arrows
 * and a page-wide title lookup is ambiguous.
 */
const swipePrev = () => assistantMessages().last().getByTitle('이전 응답');
const swipeNext = () => assistantMessages().last().getByTitle('다음 응답');

/** One member's card in the roster editor, opened so its fields are reachable. */
async function openMember(index: number) {
  const member = page.getByTestId('plot-member').nth(index);
  await member.locator('summary').click();
  return member;
}

test('a test session opens the feed, and 만들기 opens my plots', async () => {
  await seedSession(page, account);

  await expect(page).toHaveURL(/\/ko$/);

  // The shelf is where the creator area opens now: a plot is the unit, and the
  // characters live inside one. Scoped to the nav and exact: feed cards carry
  // "{name} 제작" in their names.
  await page
    .getByRole('navigation')
    .getByRole('link', { name: messages('ko').nav.create, exact: true })
    .click();
  await expect(page).toHaveURL(/\/ko\/plots$/);
  await expect(page.getByRole('heading', { name: '내 플롯' })).toBeVisible();
});

test('creates a plot and writes its profile and world', async () => {
  await page.getByRole('button', { name: '새 플롯' }).click();
  await page.getByPlaceholder('플롯 이름').fill(plot.name);
  await page.getByRole('button', { name: '만들기', exact: true }).click();

  await expect(page).toHaveURL(new RegExp(`/ko/plots/${UUID_PATH}$`));
  plotId = new URL(page.url()).pathname.split('/').pop() ?? '';

  // Anchored: a field's label carries its badge and its hint along with it, and
  // the roster's own 독자 소개 would otherwise answer to the same substring.
  await page.getByLabel(/^소개/).fill(plot.intro);
  await page.getByLabel('세계관 설정').fill(plot.description);
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByText('저장했습니다')).toBeVisible();
});

test('puts two characters in the plot', async () => {
  await expect(page.getByText('아직 등장인물이 없습니다.')).toBeVisible();

  for (const [index, member] of cast.entries()) {
    await page.getByRole('button', { name: '등장인물 추가' }).click();
    const row = await openMember(index);
    await row.getByLabel('이름').fill(member.name);
    await row.getByLabel(/^설정/).fill(member.description);
  }
  await expect(page.getByTestId('plot-member')).toHaveCount(2);

  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByText('저장했습니다')).toBeVisible();

  // The roster is the server's now, in the order it was written.
  await page.reload();
  await expect(page.getByTestId('plot-member').first()).toContainText(cast[0].name);
  await expect(page.getByTestId('plot-member').last()).toContainText(cast[1].name);
});

test('writes two openings and publishes the plot', async () => {
  for (const [index, text] of intros.entries()) {
    await page.getByRole('button', { name: '도입부 추가' }).click();
    await page.getByTestId('plot-intro').nth(index).fill(text);
  }
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByText('저장했습니다')).toBeVisible();

  // Publishing reads the stored plot, so it only happens after the save.
  await page.getByRole('button', { name: '공개하기' }).click();
  await expect(page.getByRole('button', { name: '비공개로 전환' })).toBeVisible();
});

test('the public plot page carries the cast and the openings', async () => {
  await page.getByRole('link', { name: '플롯 페이지 보기' }).click();
  await expect(page).toHaveURL(new RegExp(`/ko/p/${plotId}$`));

  await expect(page.getByRole('heading', { name: plot.name })).toBeVisible();
  await expect(page.getByTestId('plot-intro')).toContainText(plot.intro);
  const members = page.getByTestId('plot-member');
  await expect(members).toHaveCount(2);
  await expect(members.first()).toContainText(cast[0].name);

  // The picker shows one card per opening and the chosen one shows whole.
  await expect(page.getByTestId('intro-pick')).toHaveCount(2);
  await expect(page.getByTestId('intro-text')).toContainText('비가 그치지 않는 밤이었다');

  // Liking your own plot is pointless: the edit link takes that slot.
  await expect(page.getByTestId('like-button')).toHaveCount(0);
  await expect(page.getByRole('link', { name: '편집' })).toBeVisible();
});

test('starts a chat that opens on the first opening and swipes the other', async () => {
  await page.getByLabel('모델').selectOption('echo/echo');
  await page.getByRole('button', { name: '대화 시작' }).click();

  await expect(page).toHaveURL(new RegExp(`/ko/chats/${UUID_PATH}$`));
  await expect(assistantMessages()).toHaveCount(1);
  await expect(assistantMessages().first()).toContainText('늦었네, 기다렸어');
  // Every opening is a root sibling, so it swipes the way a reply does.
  await expect(swipeCounter()).toHaveText('1/2');

  await swipeNext().click();
  await expect(swipeCounter()).toHaveText('2/2');
  await expect(assistantMessages().first()).toContainText('여기서 뭐 해?');

  // Back to the first opening, which the rest of the suite builds on. The click
  // has to land before the next one: the button reads the head from the last
  // render, so a second click fired mid-flight would re-target the same sibling.
  await swipePrev().click();
  await expect(swipeCounter()).toHaveText('1/2');
  await expect(assistantMessages().first()).toContainText('늦었네, 기다렸어');
});

test('the opening is drawn as the narrator and the character who wrote it', async () => {
  const greeting = assistantMessages().first();

  // The unprefixed line is the narrator moving the scene: no name, no face.
  await expect(greeting.getByTestId('speech-narration')).toContainText(
    '비가 그치지 않는 밤이었다',
  );
  // The `이름: ` line belongs to the member it names, and the `*…*` inside it is
  // that member's 상황묘사 rather than words they said out loud.
  const spoken = greeting.getByTestId('speech-character');
  await expect(spoken).toHaveAttribute('data-speaker', cast[0].name);
  await expect(spoken).toContainText('늦었네, 기다렸어');
  await expect(spoken.locator('em')).toHaveText('우산을 접으며');
  // The prefix is protocol, not content: it is never on screen.
  await expect(greeting).not.toContainText(`${cast[0].name}:`);
});

test('the panel names who is in the room', async () => {
  await openPanel();
  const roster = page.getByTestId('chat-members');
  await expect(roster).toContainText(cast[0].name);
  await expect(roster).toContainText(cast[1].name);
});

test('streams an echo reply and attributes its speakers', async () => {
  await page.getByPlaceholder('메시지를 입력하세요').fill(firstTurn);
  await page.getByRole('button', { name: '보내기' }).click();

  // The echo model streams the user's own words back, so the reply is a reply
  // written in the protocol — which is exactly what the renderer has to read.
  await expect(userMessages()).toHaveCount(1);
  await expect(userMessages().first()).toContainText('안녕');
  await expect(assistantMessages()).toHaveCount(2);

  const reply = assistantMessages().last();
  await expect(reply.getByTestId('speech-narration')).toContainText('창밖은 아직 어둡다');
  const spoken = reply.getByTestId('speech-character');
  await expect(spoken).toHaveAttribute('data-speaker', cast[0].name);
  await expect(spoken).toContainText('안녕');
  await expect(spoken.locator('em')).toHaveText('웃으며');
  await expectComposerIdle();
});

test('regenerates and swipes between siblings', async () => {
  await page.getByRole('button', { name: '재생성' }).click();

  await expect(swipeCounter()).toHaveText('2/2');
  await expectComposerIdle();

  await swipePrev().click();
  await expect(swipeCounter()).toHaveText('1/2');
  await expect(assistantMessages().last()).toContainText('안녕');

  await swipeNext().click();
  await expect(swipeCounter()).toHaveText('2/2');
});

test('edits the user message and regenerates the reply', async () => {
  const row = userMessages().last();
  await row.hover();
  await row.getByRole('button', { name: '수정' }).click();
  await row.getByRole('textbox').fill(editedTurn);
  await row.getByRole('button', { name: '저장', exact: true }).click();

  // Editing forks the branch: the head is now the user message, so the reply
  // is regenerated explicitly (the UI does not generate on save).
  await expect(userMessages().last()).toContainText(editedTurn);
  await expect(assistantMessages()).toHaveCount(1);

  await page.getByRole('button', { name: '재생성' }).click();

  await expect(assistantMessages()).toHaveCount(2);
  // No prefix, so the whole echoed turn reads as the narrator's.
  await expect(assistantMessages().last().getByTestId('speech-narration')).toContainText(
    editedTurn,
  );
  await expectComposerIdle();
});

test('saves a user note that survives a reload', async () => {
  await openPanel();
  const panel = page.getByTestId('chat-panel');
  // Nothing has been evicted from the context yet, so there is no summary.
  await expect(panel.getByText('아직 요약이 없습니다')).toBeVisible();

  await panel.getByLabel('유저노트').fill(note);
  await Promise.all([
    chatWrite('PATCH'),
    panel.getByTestId('author-note').getByRole('button', { name: '저장', exact: true }).click(),
  ]);

  await page.reload();
  await openPanel();
  await expect(page.getByTestId('chat-panel').getByLabel('유저노트')).toHaveValue(note);
});

test('picks a prompt preset that survives a reload', async () => {
  await Promise.all([chatWrite('PATCH'), page.getByLabel('프리셋').selectOption('novel')]);

  await page.reload();
  await expect(page.getByLabel('프리셋')).toHaveValue('novel');
});

test('shows the relationship section with its toggle', async () => {
  await openPanel();
  const section = page.getByTestId('chat-relationship');

  // The echo model never triggers an extraction, so there is nothing to show yet.
  await expect(section.getByText('아직 관계가 형성되지 않았습니다')).toBeVisible();

  const toggle = section.getByLabel('관계 추적');
  await expect(toggle).toBeChecked();
  // click(), not uncheck(): the box is controlled by the server round-trip, so it
  // stays checked until the PATCH answers.
  await Promise.all([chatWrite('PATCH'), toggle.click()]);
  await expect(toggle).not.toBeChecked();

  await page.reload();
  await openPanel();
  await expect(page.getByTestId('chat-relationship').getByLabel('관계 추적')).not.toBeChecked();
});

test('tunes the memory settings, which survive a reload', async () => {
  await openPanel();
  await Promise.all([
    chatWrite('PATCH'),
    page.getByTestId('memory-settings').getByLabel('컨텍스트 예산').selectOption('32000'),
  ]);

  await page.reload();
  await openPanel();
  await expect(page.getByTestId('memory-settings').getByLabel('컨텍스트 예산')).toHaveValue('32000');
});

test('attaches a saved note to the chat', async () => {
  const chatPath = new URL(page.url()).pathname;

  await page.goto('/ko/notes');
  await page.getByLabel('제목').fill(savedNote.title);
  await page.getByLabel('내용').fill(savedNote.content);
  await page.getByRole('button', { name: '만들기', exact: true }).click();
  await expect(page.getByTestId('note-card')).toHaveCount(1);

  await page.goto(chatPath);
  await openPanel();
  const attached = () => page.getByTestId('chat-notes').getByLabel(savedNote.title);
  // click(), not check(): the box follows the server round-trip.
  await Promise.all([chatWrite('POST', '/notes/'), attached().click()]);
  await expect(attached()).toBeChecked();

  await page.reload();
  await openPanel();
  await expect(attached()).toBeChecked();
});

test('generates one more reply with the auto button', async () => {
  const before = await assistantMessages().count();

  await page.getByRole('button', { name: '이어가기' }).click();

  await expect(assistantMessages()).toHaveCount(before + 1);
  // The echo model replies with the last user turn, unprompted this time.
  await expect(assistantMessages().last()).toContainText(editedTurn);
  await expectComposerIdle();
});

test('switches the UI locale to Japanese', async () => {
  const chatPath = new URL(page.url()).pathname;

  await page.getByLabel('언어').selectOption('ja');

  await expect(page).toHaveURL(`${chatPath.replace('/ko/', '/ja/')}`);
  await expect(
    page.getByRole('navigation').getByRole('link', { name: messages('ja').nav.create }),
  ).toBeVisible();
});

test('logout sends protected routes back to the login page', async () => {
  await page.goto('/ko');
  await page.getByRole('button', { name: '로그아웃' }).click();

  await expect(page).toHaveURL(/\/ko\/login$/);

  // The gate carries where the reader was headed, so signing in lands there.
  await page.goto('/ko/personas');
  await expect(page).toHaveURL(/\/ko\/login\?next=%2Fpersonas$/);
});
