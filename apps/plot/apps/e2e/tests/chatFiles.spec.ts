import { readFile } from 'node:fs/promises';
import { seedSession } from '../seedSession.js';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * A work's chats moved as RisuAI moves a character's, and the whole app backed
 * up, along the owner's path: a RisuAI chat file goes into a work from its chat
 * list, onto the work's own greeting; the chat is exported as RisuAI's JSON and
 * that file imported into a second work, which then holds the same messages;
 * the text and HTML exports download too; then Settings makes a backup of the
 * whole folder, a restore of that file is checked and waits for the next start,
 * a foreign file is refused, and the waiting restore is given up.
 *
 * The steps build on each other, so the file runs serially; what it made is
 * deleted at the end. The swap a restore makes happens at the next start of
 * the app, which this suite does not restart — the API suite covers it.
 */
test.describe.configure({ mode: 'serial' });

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const origin = process.env['E2E_WEB_URL'] ?? 'http://localhost:13000';
/** Writes come from the web origin, as the page's own do. */
const headers = { origin };
const intros = [`첫 인사 ${run}`, `비 오는 오후 ${run}`];
const member = `세라${run}`;

/** A RisuAI chat as `exportChat` writes it: on the alternate greeting, one message left out of the prompt. */
const risuFile = {
  type: 'risuChat',
  ver: 2,
  data: {
    message: [
      { role: 'user', data: `안녕 ${run}`, chatId: 'm1', time: 1_760_000_000_000 },
      { role: 'char', data: `어서 와, {{user}} ${run}`, chatId: 'm2', time: 1_760_000_060_000, saying: 'some-cha-id' },
      { role: 'user', data: `(OOC ${run})`, chatId: 'm3', time: 1_760_000_120_000, disabled: true },
      { role: 'char', data: `알았어 ${run}`, chatId: 'm4', time: 1_760_000_180_000, saying: 'some-cha-id' },
    ],
    note: `노트 ${run}`,
    name: `비 오는 날 ${run}`,
    localLore: [],
    fmIndex: 0,
    id: 'risu-chat',
    scriptstate: { $affection: 12 },
    bookmarks: ['m2'],
  },
  folders: [],
};

let context: BrowserContext;
let page: Page;
const plotIds: string[] = [];

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ acceptDownloads: true });
  page = await context.newPage();
  await seedSession(page);
});

test.afterAll(async () => {
  for (const id of plotIds) await page.request.delete(`${origin}/api/plots/${id}`, { headers });
  await page.request.delete(`${origin}/api/backup/restore`, { headers });
  await context.close();
});

async function makeWork(name: string): Promise<string> {
  const plot = await (await page.request.post(`${origin}/api/plots`, { headers, data: { name, intros } })).json();
  const added = await page.request.post(`${origin}/api/plots/${plot.id}/characters`, { headers, data: { name: member } });
  expect(added.status(), await added.text()).toBe(201);
  plotIds.push(plot.id);
  return plot.id;
}

/** The branch of the work's only chat: what was said, by whom, and whether the AI reads it. */
async function branchOf(plotId: string): Promise<[string, string, boolean][]> {
  const chats = await (await page.request.get(`/api/chats?plotId=${plotId}`)).json();
  expect(chats).toHaveLength(1);
  const state = await (await page.request.get(`/api/chats/${chats[0].id}`)).json();
  return state.path.map((message: any) => [message.role, message.content, message.hiddenFromPrompt ?? false]);
}

const chatImported = () => page.getByRole('status').filter({ hasText: '대화 1개를 가져왔습니다.' });

test('a RisuAI chat file goes into a work from its chat list, onto its greeting', async () => {
  const first = await makeWork(`첫 작품 ${run}`);
  await page.goto(`/ko/plots/${first}`);
  await page.getByTestId('chat-file-input').setInputFiles({
    name: `${member}_chat.json`,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(risuFile)),
  });
  await expect(chatImported()).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '책갈피 1개는 가져오지 않았습니다' })).toBeVisible();
  await expect(page.getByTestId('work-chat')).toHaveCount(1);
  await expect(page.getByTestId('work-chat')).toContainText(`비 오는 날 ${run}`);
  expect(await branchOf(first)).toEqual([
    ['assistant', intros[1], false],
    ['user', `안녕 ${run}`, false],
    ['assistant', `어서 와, {{user}} ${run}`, false],
    ['user', `(OOC ${run})`, true],
    ['assistant', `알았어 ${run}`, false],
  ]);
});

test('its export goes into another work as the same messages, and the text and page download', async () => {
  const [first] = plotIds;
  await page.goto(`/ko/plots/${first}`);
  const row = page.getByTestId('work-chat');
  await row.getByRole('button', { name: '내보내기' }).click();
  const [json] = await Promise.all([page.waitForEvent('download'), row.getByRole('link', { name: /JSON/ }).click()]);
  expect(json.suggestedFilename()).toMatch(new RegExp(`^${member}_.*_chat\\.json$`));
  const exported = JSON.parse(await readFile((await json.path())!, 'utf8'));
  expect(exported).toMatchObject({ type: 'risuChat', ver: 2, data: { fmIndex: 0, note: `노트 ${run}`, scriptstate: { $affection: '12' } } });

  const [text] = await Promise.all([page.waitForEvent('download'), row.getByRole('link', { name: /텍스트/ }).click()]);
  expect(await readFile((await text.path())!, 'utf8')).toContain(`--${member}\n${intros[1]}\n\n--유저\n안녕 ${run}`);
  const [html] = await Promise.all([page.waitForEvent('download'), row.getByRole('link', { name: /HTML/ }).click()]);
  expect(await readFile((await html.path())!, 'utf8')).toContain('<div class="idat">');

  const second = await makeWork(`둘째 작품 ${run}`);
  await page.goto(`/ko/plots/${second}`);
  await page.getByTestId('chat-file-input').setInputFiles((await json.path())!);
  await expect(chatImported()).toBeVisible();
  expect(await branchOf(second)).toEqual(await branchOf(first!));
});

test('Settings makes a backup, and a restore of it waits for the next start until it is given up', async () => {
  await page.goto('/ko/settings');
  const card = page.getByTestId('backup-settings');
  await expect(card.getByRole('heading', { name: '백업과 복원' })).toBeVisible();
  const [backup] = await Promise.all([page.waitForEvent('download'), card.getByRole('link', { name: '백업 받기' }).click()]);
  expect(backup.suggestedFilename()).toMatch(/^shizue-backup-\d{4}-\d{2}-\d{2}-\d{6}\.tar$/);
  const path = (await backup.path())!;
  const bytes = await readFile(path);
  expect(bytes.subarray(0, 18).toString('latin1')).toBe('shizue-backup.json');

  // Not a backup: refused, nothing waits.
  await card.getByTestId('backup-file-input').setInputFiles({ name: 'card.tar', mimeType: 'application/x-tar', buffer: Buffer.alloc(4096, 1) });
  await expect(card.getByText('shizue 백업 파일이 아니거나 손상된 파일입니다.')).toBeVisible();
  await expect(card.getByRole('status')).toHaveCount(0);

  await card.getByTestId('backup-file-input').setInputFiles(path);
  const waiting = card.getByRole('status').filter({ hasText: '복원을 기다립니다' });
  await expect(waiting).toBeVisible({ timeout: 60_000 });
  expect((await (await page.request.get('/api/backup/restore')).json()).pending).not.toBeNull();

  await waiting.getByRole('button', { name: '복원 취소' }).click();
  await expect(waiting).toHaveCount(0);
  expect((await (await page.request.get('/api/backup/restore')).json()).pending).toBeNull();
});
