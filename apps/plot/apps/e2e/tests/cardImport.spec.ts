import { writeFile } from 'node:fs/promises';
import { seedSession } from '../seedSession.js';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * Card import along the owner's path, through the web origin: a card file of
 * more than one upload part arrives whole and becomes a plot (ARCHITECTURE §10
 * 파일 임포트 — under the local driver the parts go to the API on the same port) → the studio says where it came from → a second card comes in from a
 * RisuRealm page, which the browser downloads itself → a card whose upload a reload cut off goes on
 * from the parts already up when the same file is picked again, and one the
 * server was reading when the page reloaded is shown, not sent again.
 *
 * Realm's download endpoint is stubbed with `page.route`: the suite reaches no
 * one else's server. The steps build on each other, so the file runs serially;
 * the plot it makes is deleted at the end, because this hits the dev database.
 */
test.describe.configure({ mode: 'serial' });

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const owner = {
  email: `import-${run}@example.test`,
  password: 'e2e-password-1234',
  name: `가져오는 사람 ${run}`,
};
const first = `사서${run}`;
const second = `전령${run}`;
const realmId = '0f8e6c1a-3b2d-4c5e-9f7a-1b2c3d4e5f60';

const UUID_PATH = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** A V2 card with the creator and license RisuRealm writes on one. */
const card = (name: string, license: string) => ({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name,
    description: `서가를 정리하는 사서 ${run}.`,
    personality: '',
    // The world a card's scenario carries is what becomes the plot's setting.
    scenario: `폐관 시간이 지난 도서관 ${run}.`,
    first_mes: `${name}: 아직 안 가셨군요.`,
    mes_example: '',
    creator_notes: '',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [],
    tags: [],
    creator: `원작자${run}`,
    character_version: '1.0',
    extensions: { risuai: { license } },
  },
});

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

test('a card of more than one upload part arrives whole', async () => {
  await seedSession(page, owner);
  await page.goto('/ko/plots');

  // JSON takes whitespace anywhere, so this is one ordinary card in a 12MB
  // file — two 8MB parts, which the job joins and reads as one.
  // Eleven greetings, one more than a plot's openings: the studio says so.
  const own = card(first, 'CC BY-NC-ND 4.0');
  const greeted = { ...own, data: { ...own.data, alternate_greetings: Array.from({ length: 10 }, (_, i) => `다른 시작 ${i}`) } };
  const padded = JSON.stringify(greeted) + ' '.repeat(12 * 1024 * 1024);
  await page.getByTestId('plot-import-input').setInputFiles({
    name: 'first.json',
    mimeType: 'application/json',
    buffer: Buffer.from(padded),
  });
  await expect(page).toHaveURL(new RegExp(`/ko/plots/${UUID_PATH}$`));
  plotId = new URL(page.url()).pathname.split('/').pop() ?? '';
  await expect(members()).toHaveCount(1);
  await expect(page.getByTestId('import-warnings')).toContainText('도입부 한도(10개)를 넘은 첫 메시지 1개');
});

test('the studio says where the card came from', async () => {
  const member = members().first();
  await expect(member).toContainText('가져옴');
  await member.locator('summary').click();
  const provenance = member.getByTestId('member-provenance');
  await expect(provenance).toContainText('파일 first.json');
  await expect(provenance).toContainText(`원작자${run}`);
});

test('a RisuRealm page adds a member to the plot', async () => {
  const asked: string[] = [];
  await page.route('https://realm.risuai.net/api/v1/download/**', async (route) => {
    asked.push(route.request().url());
    const cors = { 'access-control-allow-origin': '*' };
    // A card uploaded to Realm as a PNG is not served as charx.
    if (route.request().url().includes('/charx-v3/')) {
      await route.fulfill({ status: 403, headers: cors, body: '' });
      return;
    }
    // The parser reads the bytes rather than the name, so a JSON card stands in
    // for the PNG one.
    await route.fulfill({
      status: 200,
      headers: { ...cors, 'content-type': 'image/png' },
      body: JSON.stringify(card(second, 'CC BY 4.0')),
    });
  });

  await page.getByTestId('member-realm-open').click();
  const form = page.getByTestId('realm-import');
  await form.getByTestId('realm-import-url').fill(`https://risuai.xyz/?realm=${realmId}`);
  await form.getByRole('button', { name: '가져오기' }).click();

  await expect(members()).toHaveCount(2);
  expect(asked.map((url) => new URL(url).pathname.split('/')[4])).toEqual(['charx-v3', 'png-v3']);
  const added = members().nth(1);
  await added.locator('summary').click();
  await expect(added.getByTestId('member-provenance').getByRole('link')).toHaveAttribute(
    'href',
    `https://realm.risuai.net/character/${realmId}`,
  );

  await page.goto(`/ko/p/${plotId}`);
  await expect(page.getByTestId('plot-member')).toHaveCount(2);
});

test('a card picked again after a reload sends only the parts the first page did not', async () => {
  // A file on disk, so both picks are the same file to the browser, its modification time included.
  const path = test.info().outputPath('resumed.json');
  await writeFile(path, JSON.stringify(card(`이어${run}`, 'CC BY 4.0')) + ' '.repeat(20 * 1024 * 1024));
  await page.goto('/ko/plots');

  // Three 8MB parts go up four at a time: the first page gets only part 1 through.
  const PART = /\/api\/file-imports\/[^/]+\/parts\/(\d+)$/;
  await page.route(PART, async (route) => {
    if (route.request().url().endsWith('/parts/1')) await route.continue();
    // Parts 2 and 3 are held until the page goes away.
  });
  const first = page.waitForResponse((response) => PART.test(response.url()) && response.url().endsWith('/parts/1'));
  await page.getByTestId('plot-import-input').setInputFiles(path);
  expect((await first).status()).toBe(204);
  expect(await page.evaluate(() => localStorage.getItem('shizue.fileImport'))).toContain('"name":"resumed.json"');

  await page.reload();
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  const sent: string[] = [];
  page.on('request', (request) => {
    const part = PART.exec(request.url());
    if (part && request.method() === 'PUT') sent.push(part[1]!);
  });
  await page.getByTestId('plot-import-input').setInputFiles(path);
  await expect(page).toHaveURL(new RegExp(`/ko/plots/${UUID_PATH}$`));
  await expect(members()).toHaveCount(1);
  expect(sent.sort()).toEqual(['2', '3']);
  expect(await page.evaluate(() => localStorage.getItem('shizue.fileImport'))).toBeNull();

  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: '플롯 삭제' }).click();
  await expect(page).toHaveURL(/\/ko\/plots$/);
});

test('a card picked again after a reload while the server read it is not sent again', async () => {
  const path = test.info().outputPath('read.json');
  await writeFile(path, JSON.stringify(card(`읽던${run}`, 'CC BY 4.0')));
  await page.goto('/ko/plots');

  // The first page never hears how the import went: its polls are held until it goes away.
  const POLL = new RegExp(`/api/file-imports/${UUID_PATH}$`);
  await page.route(POLL, async (route) => {
    if (route.request().method() !== 'GET') await route.continue();
  });
  const completed = page.waitForResponse((response) => response.url().endsWith('/complete'));
  await page.getByTestId('plot-import-input').setInputFiles(path);
  expect((await completed).status()).toBe(202);

  await page.reload();
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  const sent: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' && request.url().includes('/api/file-imports')) sent.push(new URL(request.url()).pathname);
  });
  await page.getByTestId('plot-import-input').setInputFiles(path);
  await expect(page).toHaveURL(new RegExp(`/ko/plots/${UUID_PATH}$`));
  await expect(members().first()).toContainText(`읽던${run}`);
  expect(sent).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem('shizue.fileImport'))).toBeNull();

  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: '플롯 삭제' }).click();
  await expect(page).toHaveURL(/\/ko\/plots$/);
});

test('deleting the plot cleans up after the run', async () => {
  await page.goto(`/ko/plots/${plotId}`);
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: '플롯 삭제' }).click();
  await expect(page).toHaveURL(/\/ko\/plots$/);
});
