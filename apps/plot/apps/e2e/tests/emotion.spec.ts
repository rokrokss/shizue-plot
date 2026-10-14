import { crc32, deflateSync } from 'node:zlib';
import { seedSession } from '../seedSession.js';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * RisuAI's emotion screen end to end: a RisuAI PNG card that shows its
 * expressions (`viewScreen: 'emotion'`) becomes a plot whose chat opens on the
 * card's `neutral`; a reply moves it to the picture the auxiliary model picks —
 * the echo model, which hands the reply back, so a reply of `happy` picks
 * `happy` — and the panel folds away and stays folded. On a wide screen it
 * stands beside the chat; the studio switches it off.
 *
 * The steps build on each other, so the file runs serially with a fresh account.
 */
test.describe.configure({ mode: 'serial' });

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const account = { email: `emotion-${run}@example.test`, password: 'e2e-password-1234', name: `표정 ${run}` };
const name = `세이${run}`;
const base = process.env['E2E_WEB_URL'] ?? 'http://localhost:13000';

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A 2×3 PNG of one colour, with whatever text chunks it is given. */
function png(rgb: [number, number, number], texts: [string, string][] = []): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(3, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.from([0, ...rgb, ...rgb]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    ...texts.map(([keyword, text]) => chunk('tEXt', Buffer.from(`${keyword}\0${text}`, 'latin1'))),
    chunk('IDAT', deflateSync(Buffer.concat([row, row, row]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A RisuAI V2 PNG card: its expressions in `chara-ext-asset_:N` chunks, named in `risuai.emotions`. */
function emotionCard(): Buffer {
  const card = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name,
      description: `표정이 풍부한 검객 ${run}.`,
      personality: '',
      scenario: `국경의 주막 ${run}.`,
      first_mes: '자리 있소?',
      mes_example: '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: [],
      creator: '',
      character_version: '1.0',
      extensions: {
        risuai: {
          viewScreen: 'emotion',
          emotions: [
            ['neutral', '__asset:1'],
            ['happy', '__asset:2'],
          ],
        },
      },
    },
  };
  const b64 = (bytes: Buffer): string => bytes.toString('base64');
  return png(
    [240, 240, 240],
    [
      ['chara-ext-asset_:1', b64(png([91, 141, 239]))],
      ['chara-ext-asset_:2', b64(png([242, 163, 58]))],
      ['chara', b64(Buffer.from(JSON.stringify(card)))],
    ],
  );
}

let context: BrowserContext;
let page: Page;
let plotId = '';
let chatId = '';

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ viewport: { width: 375, height: 812 } });
  page = await context.newPage();
});

test.afterAll(async () => {
  await context.close();
});

const screen = () => page.getByTestId('emotion-screen');
const slot = () => page.getByTestId('emotion-slot');

test('opens on the card’s neutral and moves to the picture a reply leaves', async () => {
  await seedSession(page, account);
  const imported = await page.request.post(`${base}/api/plots/import`, {
    headers: { origin: base },
    multipart: { file: { name: 'sei.png', mimeType: 'image/png', buffer: emotionCard() } },
  });
  expect(imported.status()).toBe(201);
  plotId = (await imported.json()).id;
  // The echo model is the chat's auxiliary model too, so it is what picks the picture.
  const started = await page.request.post(`${base}/api/chats`, {
    headers: { origin: base },
    data: { plotId, model: 'echo/echo', subModel: 'echo/echo' },
  });
  expect(started.status()).toBe(201);
  chatId = (await started.json()).chat.id;

  await page.goto(`/ko/chats/${chatId}`);
  await expect(screen()).toBeVisible();
  await expect(slot()).toHaveAttribute('data-emotion', 'neutral');
  await expect(slot().locator('img')).toHaveAttribute('alt', `${name}의 표정: neutral`);

  await page.getByPlaceholder('메시지를 입력하세요').fill('happy');
  await page.getByRole('button', { name: '보내기', exact: true }).click();
  await expect(page.getByTestId('message-assistant').last()).toContainText('happy');
  // Chosen after the reply, and the page asks until it is there.
  await expect(slot()).toHaveAttribute('data-emotion', 'happy', { timeout: 30_000 });
  // On the branch, so a reload shows it.
  await page.reload();
  await expect(slot()).toHaveAttribute('data-emotion', 'happy');
});

test('folds to a bar on a narrow screen and stays folded for this chat', async () => {
  const tall = (await screen().boundingBox())!.height;
  expect(tall).toBeGreaterThan(812 * 0.3);
  await page.getByRole('button', { name: '표정 접기' }).click();
  await expect(slot().locator('img')).toBeHidden();
  expect((await screen().boundingBox())!.height).toBeLessThan(48);
  await page.reload();
  await expect(page.getByRole('button', { name: '표정 펼치기' })).toBeVisible();
  await page.getByRole('button', { name: '표정 펼치기' }).click();
  await expect(slot().locator('img')).toBeVisible();
});

test('stands beside the chat on a wide screen', async () => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const box = (await screen().boundingBox())!;
  expect(box.x).toBe(0);
  expect(box.width).toBeGreaterThan(1280 * 0.35);
  expect(box.width).toBeLessThan(1280 * 0.45);
  // Full height of the chat area, the composer's included.
  const composer = (await page.getByPlaceholder('메시지를 입력하세요').boundingBox())!;
  expect(box.y + box.height).toBeGreaterThan(composer.y + composer.height);
  await expect(page.getByRole('button', { name: '표정 접기' })).toBeHidden();
});

test('is switched off in the studio', async () => {
  await page.goto(`/ko/plots/${plotId}`);
  const member = page.getByTestId('plot-member').first();
  await member.locator('summary').click();
  await member.getByTestId('member-emotion-mode').selectOption('off');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByText('저장했습니다')).toBeVisible();

  await page.goto(`/ko/chats/${chatId}`);
  await expect(page.getByTestId('message-assistant').last()).toContainText('happy');
  await expect(screen()).toHaveCount(0);
});
