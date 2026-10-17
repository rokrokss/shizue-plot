import { buildRisum } from '../../../packages/core/test/helpers/risum.js';
import { seedSession } from '../seedSession.js';
import { expect, test, type BrowserContext, type Page, type Request } from '@playwright/test';

/**
 * RisuAI modules along both readers' paths, through the web origin: a creator
 * brings a `.risum` with a picture into the work from the studio, and a reader
 * brings a module that asks for low-level access into their own library from
 * the chat's settings — taken only on their yes, and on the upload they already
 * made (ARCHITECTURE §10 파일 임포트). The file goes up in parts and a job
 * reads it, so what each checks is what the page shows once the import ends.
 */
test.describe.configure({ mode: 'serial' });

const WEB = process.env['E2E_WEB_URL'] ?? 'http://localhost:13000';
const headers = { origin: WEB };
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const owner = {
  email: `modules-${run}@example.test`,
  password: 'e2e-password-1234',
  name: `모듈 ${run}`,
};

/** A 1x1 GIF: the picture the `.risum` carries in its asset block. */
const GIF = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');

let context: BrowserContext;
let page: Page;
let plotId = '';

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
});

test.afterAll(async () => {
  if (plotId) await page.request.delete(`${WEB}/api/plots/${plotId}`, { headers });
  await context.close();
});

/** The parts a page sends while `work` runs, by the import's address. */
async function partsSentDuring(work: () => Promise<void>): Promise<string[]> {
  const sent: string[] = [];
  const listen = (request: Request): void => {
    if (request.method() === 'PUT' && /\/api\/file-imports\/[^/]+\/parts\/\d+$/.test(request.url())) sent.push(request.url());
  };
  page.on('request', listen);
  try {
    await work();
  } finally {
    page.off('request', listen);
  }
  return sent;
}

test('a creator brings a .risum module and its picture into the work', async () => {
  await seedSession(page, owner);
  const created = await page.request.post(`${WEB}/api/plots`, { headers, data: { name: `비 오는 작품 ${run}` } });
  expect(created.status()).toBe(201);
  plotId = (await created.json()).id;
  expect((await page.request.post(`${WEB}/api/plots/${plotId}/characters`, { headers, data: { name: '세이' } })).status()).toBe(201);

  await page.goto(`/ko/plots/${plotId}`);
  const risum = buildRisum(
    {
      type: 'risuModule',
      module: {
        name: `비 ${run}`,
        id: `rain-${run}`,
        description: '빗소리',
        lorebook: [{ key: '비', secondkey: '', comment: '비', content: '창밖에 비가 온다.', mode: 'normal', insertorder: 100, alwaysActive: false, selective: false }],
        regex: [],
        trigger: [],
        assets: [['drop', '', 'gif']],
      },
    },
    [GIF],
  );
  const sent = await partsSentDuring(async () => {
    await page.getByTestId('module-file').setInputFiles({ name: 'rain.risum', mimeType: 'application/octet-stream', buffer: Buffer.from(risum) });
    await expect(page.getByTestId('module')).toContainText(`비 ${run}`);
  });
  // Under the local driver the one part goes through the web's rewrite to the API.
  expect(sent).toHaveLength(1);
  // Its picture is the work's now, where `{{img::drop}}` finds it.
  const assets = (await (await page.request.get(`${WEB}/api/plots/${plotId}/assets`, { headers })).json()) as { name: string; mime: string }[];
  expect(assets.map((asset) => [asset.name, asset.mime])).toContainEqual(['drop', 'image/gif']);
});

test('a reader takes a module that asks for low-level access on their yes, sending it once', async () => {
  const started = await page.request.post(`${WEB}/api/chats`, { headers, data: { plotId, model: 'echo/echo' } });
  expect(started.status()).toBe(201);
  const chatId = (await started.json()).chat.id;
  await page.goto(`/ko/chats/${chatId}`);
  await page.getByRole('button', { name: '대화 설정' }).click();
  await page.getByRole('dialog', { name: '대화 설정' }).getByRole('button', { name: '노트', exact: true }).click();
  const section = page.getByTestId('reader-modules');
  await expect(section).toBeVisible();

  const module = { type: 'risuModule', name: `저수준 ${run}`, id: `low-${run}`, description: '', lowLevelAccess: true };
  let asked = '';
  page.once('dialog', (dialog) => {
    asked = dialog.message();
    void dialog.accept();
  });
  const confirmed = page.waitForResponse((res) => /\/api\/file-imports\/[^/]+\/confirm$/.test(res.url()));
  const sent = await partsSentDuring(async () => {
    await page.getByTestId('reader-module-file').setInputFiles({
      name: 'low.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(module)),
    });
    await expect(page.getByTestId('reader-module')).toContainText(`저수준 ${run}`);
  });
  expect(asked).not.toBe('');
  expect((await confirmed).status()).toBe(202);
  // The yes went to the import that stopped to ask: the file was sent once.
  expect(sent).toHaveLength(1);
});
