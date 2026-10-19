import { seedSession } from '../seedSession.js';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * End-to-end smoke path: test session → plot → two members → openings →
 * chat from the plot's own page → echo turn read back as the speakers who
 * wrote it → regenerate, with a request too → edit → author note → locale
 * switch → logout.
 *
 * Two members make it a work of group turns — one reply per speaker. The second
 * member is set to speak only when picked (대화량 0), so every round here is the
 * first member's alone and the counts below hold on every run; groupTurns.spec.ts
 * is where rounds of several speakers are walked through.
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

/** The chat's settings sheet, which ☰ opens at every width. */
async function openSettings() {
  await page.getByRole('button', { name: '대화 설정' }).click();
  const sheet = page.getByRole('dialog', { name: '대화 설정' });
  await expect(sheet).toBeVisible();
  return sheet;
}

/** The notes panel, opened from the settings sheet when it is not already showing. */
async function openPanel(): Promise<void> {
  if (!(await page.getByTestId('chat-panel').isVisible())) {
    await (await openSettings()).getByRole('button', { name: '노트', exact: true }).click();
  }
  await expect(page.getByTestId('chat-panel')).toBeVisible();
}

/** Resolves once a chat settings write has been answered. */
const chatWrite = (method: string, path = '/api/chats/') =>
  page.waitForResponse(
    (response) => response.request().method() === method && response.url().includes(path),
  );

/** The theme on screen now, as the reader's pick puts it on <html>: dark unless light is picked. */
async function setTheme(theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((light) => {
    if (light) document.documentElement.dataset['theme'] = 'light';
    else delete document.documentElement.dataset['theme'];
  }, theme === 'light');
}

const assistantMessages = () => page.getByTestId('message-assistant');
const userMessages = () => page.getByTestId('message-user');

/** One member's card in the roster editor, opened so its fields are reachable. */
async function openMember(index: number) {
  const member = page.getByTestId('plot-member').nth(index);
  await member.locator('summary').click();
  return member;
}

test('a test session opens the library, and 만들기 opens my plots', async () => {
  await seedSession(page, account);

  await expect(page).toHaveURL(/\/ko$/);

  // The shelf is where the creator area opens now: a plot is the unit, and the
  // characters live inside one. Scoped to the nav and exact: the library has a
  // way to make one of its own.
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

  // The second member speaks only when the reader picks them.
  await page.getByRole('button', { name: `${cast[1].name}의 대화량 0`, exact: true }).click();
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByText('저장했습니다')).toBeVisible();
});

test('writes two openings', async () => {
  for (const [index, text] of intros.entries()) {
    await page.getByRole('button', { name: '도입부 추가' }).click();
    await page.getByTestId('plot-intro').nth(index).fill(text);
  }
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByText('저장했습니다')).toBeVisible();
});

test('the plot page carries the cast and the openings', async () => {
  await page.getByRole('link', { name: '대화 시작하기' }).click();
  await expect(page).toHaveURL(new RegExp(`/ko/p/${plotId}$`));

  await expect(page.getByRole('heading', { name: plot.name })).toBeVisible();
  await expect(page.getByTestId('plot-intro')).toContainText(plot.intro);
  const members = page.getByTestId('plot-member');
  await expect(members).toHaveCount(2);
  await expect(members.first()).toContainText(cast[0].name);

  // The picker shows one card per opening and the chosen one shows whole.
  await expect(page.getByTestId('intro-pick')).toHaveCount(2);
  await expect(page.getByTestId('intro-text')).toContainText('비가 그치지 않는 밤이었다');

  await expect(page.getByRole('link', { name: '편집' })).toBeVisible();
});

test('starts a chat that opens on the first opening', async () => {
  await page.getByRole('combobox', { name: '모델', exact: true }).selectOption('echo/echo');
  await page.getByRole('button', { name: '대화 시작' }).click();

  await expect(page).toHaveURL(new RegExp(`/ko/chats/${UUID_PATH}$`));
  await expect(assistantMessages()).toHaveCount(1);
  await expect(assistantMessages().first()).toContainText('늦었네, 기다렸어');
  // The conversation has the whole screen: the site's header steps aside.
  await expect(page.getByRole('link', { name: '뒤로', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation').getByRole('link', { name: messages('ko').nav.create, exact: true })).toBeHidden();
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

  // The reply is wholly the member who gave it — the prefix it echoed of its
  // own name comes off — so every line of it is theirs, under their face.
  const reply = assistantMessages().last();
  await expect(reply.getByTestId('speech-narration')).toHaveCount(0);
  const spoken = reply.getByTestId('speech-character');
  await expect(spoken).toHaveAttribute('data-speaker', cast[0].name);
  await expect(spoken).toContainText('창밖은 아직 어둡다');
  await expect(spoken).toContainText('안녕');
  await expect(spoken.locator('em')).toHaveText('웃으며');
  await expect(reply).not.toContainText(`${cast[0].name}:`);
  await expectComposerIdle();
});

test('regenerates the last reply, and again with a request', async () => {
  const regenerate = () =>
    page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/regenerate'));
  let sent = regenerate();
  await page.getByRole('button', { name: '재생성' }).click();
  expect((await sent).postDataJSON()?.request).toBeUndefined();
  await expectComposerIdle();
  await expect(assistantMessages()).toHaveCount(2);
  await expect(assistantMessages().last()).toContainText('안녕');

  // The request goes along with the regeneration, and the sheet steps aside.
  await page.getByRole('button', { name: '요청해서 다시 쓰기' }).click();
  const ask = page.getByRole('dialog', { name: '어떻게 고쳐드릴까요?' });
  await ask.getByRole('textbox').fill(`더 짧게 ${run}`);
  sent = regenerate();
  await ask.getByRole('button', { name: '다시 쓰기', exact: true }).click();
  expect((await sent).postDataJSON()).toMatchObject({ request: `더 짧게 ${run}` });
  await expect(ask).toHaveCount(0);
  await expectComposerIdle();
  await expect(assistantMessages()).toHaveCount(2);
});

test('edits the last turn in the composer’s place, its action parted from its words', async () => {
  const reply = assistantMessages().last();
  // Drawn as Zeta draws a reply: the action a paragraph of its own between the words.
  await expect(reply.locator('p').filter({ has: page.locator('em') })).toHaveText('웃으며');

  await page.locator('.chat-veil').getByRole('button', { name: '수정' }).click();
  const editor = page.getByTestId('turn-editor');
  const field = editor.getByRole('textbox', { name: '메시지 수정' });
  // The composer gives way to the panel, which holds the turn as it is drawn.
  await expect(page.getByPlaceholder('메시지를 입력하세요')).toHaveCount(0);
  await expect(field).toHaveValue(/안녕\n\n\*웃으며\*\n\n반가워/);

  const saved = page.waitForResponse((response) => response.url().endsWith('/edit-scene'));
  await field.fill((await field.inputValue()).replace('반가워', `반가웠어 ${run}`));
  await editor.getByRole('button', { name: '저장', exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await expect(editor).toHaveCount(0);
  await expect(assistantMessages()).toHaveCount(2);
  await expect(assistantMessages().last()).toContainText(`반가웠어 ${run}`);
  await expectComposerIdle();
});

test('edits the user message and regenerates the reply', async () => {
  const row = userMessages().last();
  await row.hover();
  await row.getByRole('button', { name: '수정' }).click();
  const editor = page.getByTestId('turn-editor');
  await editor.getByRole('textbox', { name: '메시지 수정' }).fill(editedTurn);
  await editor.getByRole('button', { name: '저장', exact: true }).click();

  // The edit is in place: the reply under it stays, and answering the new
  // words again is the reader's own choice (the UI does not generate on save).
  await expect(userMessages().last()).toContainText(editedTurn);
  await expect(assistantMessages()).toHaveCount(2);

  await page.getByRole('button', { name: '재생성' }).click();

  await expect(assistantMessages()).toHaveCount(2);
  // No prefix, and the reply is its speaker's whole.
  await expect(assistantMessages().last().getByTestId('speech-character')).toContainText(
    editedTurn,
  );
  await expectComposerIdle();
});

test('hides a message from the AI and shows it again, on screen either way', async () => {
  const turn = userMessages().last();
  const reply = assistantMessages().last();
  for (const row of [turn, reply]) {
    await row.hover();
    const hidden = page.waitForResponse((response) => response.url().endsWith('/hidden'));
    await row.getByRole('button', { name: 'AI에게 숨기기', exact: true }).click();
    expect((await hidden).status()).toBe(200);
    await expect(row.getByTestId('message-hidden')).toHaveText('AI에게 숨김');
  }
  // Dimmed, not gone: the words are still there to read.
  await expect(turn).toContainText(editedTurn);
  await expect(turn.locator('[class*="opacity-[0.58]"]').first()).toHaveCSS('opacity', '0.58');
  // A reply the AI no longer reads is not one it can go on writing.
  await expect(page.getByRole('button', { name: '이어쓰기' })).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId('message-hidden')).toHaveCount(2);

  for (const row of [userMessages().last(), assistantMessages().last()]) {
    await row.hover();
    await row.getByRole('button', { name: 'AI에게 다시 보이기', exact: true }).click();
  }
  await expect(page.getByTestId('message-hidden')).toHaveCount(0);
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

test('places the user note by depth, frequency and role, which survive a reload', async () => {
  await openPanel();
  const settings = page.getByTestId('author-note-settings');
  // SillyTavern's defaults: four from the end, every turn, a system message.
  await expect(settings.getByLabel('넣는 깊이')).toHaveValue('4');
  await expect(settings.getByLabel('넣는 빈도')).toHaveValue('1');
  await expect(settings.getByLabel('역할')).toHaveValue('system');
  await Promise.all([chatWrite('PATCH'), settings.getByLabel('넣는 깊이').selectOption('0')]);
  await Promise.all([chatWrite('PATCH'), settings.getByLabel('넣는 빈도').selectOption('2')]);
  await Promise.all([chatWrite('PATCH'), settings.getByLabel('역할').selectOption('user')]);

  await page.reload();
  await openPanel();
  const reloaded = page.getByTestId('author-note-settings');
  await expect(reloaded.getByLabel('넣는 깊이')).toHaveValue('0');
  await expect(reloaded.getByLabel('넣는 빈도')).toHaveValue('2');
  await expect(reloaded.getByLabel('역할')).toHaveValue('user');
});

test('turns on recalling past messages, off until then, which survives a reload', async () => {
  let sheet = await openSettings();
  const recall = () => sheet.getByRole('checkbox', { name: '지난 대화 불러오기' });
  await expect(recall()).not.toBeChecked();
  // Held by the chat's state, so it turns on once the write is answered.
  await Promise.all([chatWrite('PATCH'), recall().click()]);
  await expect(recall()).toBeChecked();

  await page.reload();
  sheet = await openSettings();
  await expect(recall()).toBeChecked();
  await page.keyboard.press('Escape');
});

test('makes my own preset from the default template, picked for the chat across a reload', async () => {
  const name = `내 문체 ${run}`;
  let sheet = await openSettings();
  await sheet.getByRole('button', { name: '내 프리셋 관리' }).click();
  await sheet.getByRole('button', { name: '새 프리셋' }).click();
  await sheet.getByLabel('이름', { exact: true }).fill(name);
  // A new preset starts as a copy of the default (OAI2) template; its main item is the first text.
  await expect(sheet.getByTestId('reader-preset-template')).toBeVisible();
  await sheet.getByLabel('일반 프롬프트 · 메인 · 시스템').fill(`대사를 짧게 끊는다 ${run}`);
  await Promise.all([
    chatWrite('POST', '/api/reader-presets'),
    sheet.getByRole('button', { name: '저장', exact: true }).click(),
  ]);

  await Promise.all([
    chatWrite('PATCH'),
    sheet.getByRole('combobox', { name: '내 프리셋' }).selectOption({ label: name }),
  ]);
  await page.keyboard.press('Escape');

  await page.reload();
  sheet = await openSettings();
  await expect(sheet.getByRole('combobox', { name: '내 프리셋' }).locator('option:checked')).toHaveText(name);
  await page.keyboard.press('Escape');
});

test('imports a SillyTavern preset where ST sends its prompts, and says which field each went into', async () => {
  const wide = page.viewportSize();
  await page.setViewportSize({ width: 375, height: 812 });
  await setTheme('light');
  try {
    const sheet = await openSettings();
    await sheet.getByRole('button', { name: '내 프리셋 관리' }).click();
    const preset = {
      chat_completion_source: 'openai',
      prompts: [
        { identifier: 'main', name: 'Main Prompt', content: `ST 메인 ${run}` },
        { identifier: 'nsfw', name: 'Auxiliary Prompt', content: `보조 지시 ${run}` },
        { identifier: 'jailbreak', name: 'Post-History Instructions', content: `응답 직전 지시 ${run}` },
        { identifier: 'style', name: '문체', content: '짧게' },
      ],
      prompt_order: [
        {
          character_id: 100000,
          order: ['main', 'nsfw', 'jailbreak', 'style'].map((identifier) => ({ identifier, enabled: true })),
        },
      ],
    };
    await sheet.getByTestId('reader-preset-import-input').setInputFiles({
      name: 'Celia.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(preset)),
    });
    const notice = sheet.getByTestId('reader-preset-import-notice');
    await expect(notice.locator('li')).toHaveText([
      'Main Prompt → 메인 프롬프트',
      'Auxiliary Prompt → 메인 프롬프트',
      'Post-History Instructions → 글로벌 노트',
      '그 밖의 프롬프트 1개는 보내지 않습니다: 문체',
      '모델·샘플링 등 나머지 설정도 가져오지 않았습니다.',
    ]);
    await expect(sheet.getByLabel('메인 프롬프트')).toHaveValue(`ST 메인 ${run}\n\n보조 지시 ${run}`);
    await expect(sheet.getByLabel('글로벌 노트')).toHaveValue(`응답 직전 지시 ${run}`);
    await notice.scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'test-results/reader-preset/import-notice-light.png' });
    // Nothing is kept until the reader saves.
    await sheet.getByRole('button', { name: '취소', exact: true }).click();
    await page.keyboard.press('Escape');
  } finally {
    if (wide) await page.setViewportSize(wide);
  }
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

test('says who knows each fact, folds the ones a later summary ended under their own heading, struck, and restores one', async () => {
  // The echo model extracts nothing and this API runs without an embedder, so the
  // memory is stood in for: the panel's own reads and the restore it sends.
  const at = '2026-10-15T00:00:00.000Z';
  // A group scene's stage, as the API names it.
  const stage = [
    { id: '00000000-0000-4000-8000-0000000000a1', name: '리안' },
    { id: '00000000-0000-4000-8000-0000000000a2', name: '하준' },
  ];
  const fact = (
    id: string,
    content: string,
    ended?: { turn: number; by?: string },
    scene: { knownTo: typeof stage | null; knownToAll: boolean } = { knownTo: null, knownToAll: false },
  ) => ({
    id,
    content,
    summaryId: '00000000-0000-4000-8000-000000000001',
    turnFrom: 1,
    turnTo: 3,
    invalidated: Boolean(ended),
    invalidatedTurn: ended?.turn ?? null,
    supersededBy: ended?.by ? { id: '00000000-0000-4000-8000-0000000000f3', content: ended.by } : null,
    ...scene,
    createdAt: at,
    updatedAt: at,
  });
  const ended = fact('00000000-0000-4000-8000-0000000000f1', '리안은 수영을 하지 못한다.', { turn: 42, by: '리안은 하준에게 수영을 배워 이제 혼자 수영할 수 있다.' });
  const promise = fact('00000000-0000-4000-8000-0000000000f2', '하준은 리안의 생일에 은반지를 선물하기로 약속했다.', { turn: 57 });
  const memory = {
    summaries: [
      {
        id: '00000000-0000-4000-8000-000000000001',
        text: '여름 내내 하준은 강변 수영장에서 리안에게 수영을 가르쳤다.',
        important: false,
        applies: true,
        messageIds: [],
        messages: [],
        createdAt: at,
        updatedAt: at,
      },
    ],
    facts: [
      ended,
      promise,
      fact('00000000-0000-4000-8000-0000000000f3', '리안은 하준에게 수영을 배워 이제 혼자 수영할 수 있다.', undefined, { knownTo: stage, knownToAll: false }),
      fact('00000000-0000-4000-8000-0000000000f4', '강변 수영장은 여름 내내 마을 사람 모두에게 열려 있다.', undefined, { knownTo: stage, knownToAll: true }),
    ],
  };
  // The panel reads the memory again a few seconds after it opens: once restored, it stays restored.
  const restored = { ...promise, invalidated: false, invalidatedTurn: null };
  let restoredYet = false;
  await page.route(/\/api\/chats\/[^/]+\/memory$/, (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: { ...memory, facts: memory.facts.map((item) => (restoredYet && item.id === promise.id ? restored : item)) } })
      : route.fallback(),
  );
  await page.route(/\/api\/chats\/[^/]+\/memory\/facts\/[^/]+$/, async (route) => {
    expect(route.request().method()).toBe('PATCH');
    expect(route.request().postDataJSON()).toEqual({ invalidated: false });
    restoredYet = true;
    await route.fulfill({ json: { fact: restored } });
  });
  const wide = page.viewportSize();
  try {
    await page.reload();
    await openPanel();
    // Read on a phone: the panel stays open as the window narrows.
    await page.setViewportSize({ width: 375, height: 812 });
    const facts = page.getByTestId('memory-facts');
    await expect(facts.getByTestId('memory-fact')).toHaveCount(2);
    await expect(facts.getByText('이 갈래의 사실 2개')).toBeVisible();
    // A group scene's fact names who may be told it; one everyone knows says so; one of no scene says nothing.
    const knownTo = facts.getByTestId('memory-fact-known-to');
    await expect(knownTo).toHaveText(['아는 인물: 리안, 하준', '모두가 아는 사실']);
    for (const scheme of ['light', 'dark'] as const) {
      await setTheme(scheme);
      await facts.getByTestId('memory-fact').first().scrollIntoViewIfNeeded();
      await facts.locator('ul').first().screenshot({ path: `test-results/memory/known-to-${scheme}.png` });
    }
    await setTheme('light');
    const folded = facts.getByTestId('memory-ended-facts');
    await folded.getByText('더 이상 맞지 않는 사실 2개').click();
    const endedCards = folded.getByTestId('memory-ended-fact');
    await expect(endedCards).toHaveCount(2);
    await expect(endedCards.first()).toContainText('바뀐 사실: 리안은 하준에게 수영을 배워 이제 혼자 수영할 수 있다.');
    await expect(endedCards.first()).toContainText('42턴에서 끝남');
    await expect(endedCards.first().getByText(ended.content)).toHaveCSS('text-decoration-line', 'line-through');
    for (const scheme of ['light', 'dark'] as const) {
      await setTheme(scheme);
      await endedCards.last().scrollIntoViewIfNeeded();
      await folded.screenshot({ path: `test-results/memory/ended-facts-${scheme}.png` });
      await page.screenshot({ path: `test-results/memory/ended-facts-viewport-${scheme}.png` });
    }
    await setTheme('light');

    // Restored, it stands with the facts that hold again.
    await endedCards.nth(1).getByRole('button', { name: '되살리기' }).click();
    await expect(facts.getByTestId('memory-fact')).toHaveCount(3);
    await expect(facts.getByTestId('memory-fact').getByText(promise.content)).toBeVisible();
    await expect(knownTo).toHaveCount(2);
    await expect(folded.getByTestId('memory-ended-fact')).toHaveCount(1);
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
    if (wide) await page.setViewportSize(wide);
  }
});

test('the open notes panel scrolls inside itself, never the page', async () => {
  await openPanel();
  // Nothing in the panel may reach past it and stretch the page: a page that
  // scrolls slides the chat's header and the panel's top off the screen.
  const overflow = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
  expect(overflow).toBeLessThanOrEqual(1);
  // Nor does the panel push the composer off the screen once it grows to its tallest.
  const composer = page.getByPlaceholder('메시지를 입력하세요');
  await composer.fill(Array.from({ length: 15 }, (_, line) => `${line + 1}`).join('\n'));
  await expect(composer).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)).toBeLessThanOrEqual(1);
  await composer.fill('');
  // A click in the conversation below closes it, as a click outside a popup does.
  await page.locator('[data-message-list]').click({ position: { x: 5, y: 5 } });
  await expect(page.getByTestId('chat-panel')).toBeHidden();
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

test('이어쓰기 by the composer goes on with the last reply rather than adding one', async () => {
  const before = await assistantMessages().count();
  const continued = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/continue'));

  await page.getByRole('button', { name: '이어쓰기' }).click();

  await continued;
  await expectComposerIdle();
  await expect(assistantMessages()).toHaveCount(before);
  await expect(assistantMessages().last()).toContainText(editedTurn);
});

test('keeps following the conversation when what stands under it shrinks back', async () => {
  // Several lines grow the composer and shorten the list; the reader reads down
  // to the newest turn, then clears them. The list grows back and the browser
  // pulls its scroll up with it, which is not the reader leaving the bottom: the
  // next reply is still followed.
  const list = page.locator('[data-message-list]');
  const composer = page.getByPlaceholder('메시지를 입력하세요');
  await composer.fill(['하나', '둘', '셋', '넷', '다섯', '여섯'].join('\n'));
  await assistantMessages().last().hover();
  await page.mouse.wheel(0, 2000);
  await expect.poll(() => list.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2);
  await composer.fill('');

  const before = await assistantMessages().count();
  await composer.fill('조금만 더');
  await page.getByRole('button', { name: '보내기' }).click();
  await expect(assistantMessages()).toHaveCount(before + 1);
  await expect(userMessages().last()).toContainText('조금만 더');
  await expectComposerIdle();
  // Followed down to it: the reply ends on the list's screen, and no way down is offered.
  await expect
    .poll(async () => {
      const [reply, shown] = await Promise.all([assistantMessages().last().boundingBox(), list.boundingBox()]);
      return reply!.y + reply!.height - (shown!.y + shown!.height);
    })
    .toBeLessThanOrEqual(1);
  await expect(page.getByRole('button', { name: '맨 아래로' })).toBeHidden();
});

test('switches the UI locale to Japanese', async () => {
  // The language is one of 설정's, under 화면, with the theme.
  await page.goto('/ko/settings');
  await page.getByLabel('언어').selectOption('ja');

  await expect(page).toHaveURL(/\/ja\/settings$/);
  await expect(
    page.getByRole('navigation').getByRole('link', { name: messages('ja').nav.create }),
  ).toBeVisible();
});
