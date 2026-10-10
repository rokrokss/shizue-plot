import { readFile } from 'node:fs/promises';
import { crc32, deflateSync } from 'node:zlib';
import { seedSession } from '../seedSession.js';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * A paste migration from Zeta along the creator's path: the site picker → the
 * confirmations and a source page → the form, filled the way a creator pastes it
 * (two characters, a conversation profile, an intro in Zeta's `@이름:` turns, a
 * lorebook entry, a style pick), kept across a reload → one image under its
 * source name → the preview, drawn with the speakers it will have → the private
 * plot it makes, read back, and the publish asking for the owner's word.
 *
 * The form is found by the field paths the schema gives it
 * (`migrate-field-<section>.<field>` / `<section>[i].<field>`), so the ids below
 * are `SITE_SCHEMAS.zeta`'s (`packages/core/src/migrate/zeta.ts`); a renamed
 * field there is a renamed test id here.
 *
 * The steps build on each other, so the file runs serially, and the plot it
 * makes is deleted at the end, because this hits the dev database.
 */
test.describe.configure({ mode: 'serial' });

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const owner = {
  email: `paste-${run}@example.test`,
  password: 'e2e-password-1234',
  name: `옮기는 사람 ${run}`,
};
const origin = process.env['E2E_WEB_URL'] ?? 'http://localhost:13000';

const title = `밤의 서점 ${run}`;
const alice = '앨리스';
const bob = '밥';
const zetaId = '0f8e6c1a-3b2d-4c5e-9f7a-1b2c3d4e5f60';

/** A 1×1 PNG, which is all the asset route and the browser's measuring need. */
function png(): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 0x32, 0xcc, 0xbc, 0xff]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

interface Member {
  id: string;
  name: string;
  importedFrom: { platform?: string; method?: string; sourceUrl?: string; sha256: string } | null;
}
interface PlotRead {
  id: string;
  name: string;
  visibility: string;
  intros: string[];
  lorebook: { keys: string[]; content: string; constant: boolean }[];
  style: { storytelling?: string } | null;
  profiles: { name: string; description: string }[];
  characters: Member[];
}

let context: BrowserContext;
let page: Page;
let plotId = '';

const field = (path: string) => page.getByTestId(`migrate-field-${path}`);

const api = async <T>(path: string): Promise<T> => {
  const response = await page.request.get(`${origin}${path}`);
  expect(response.ok(), path).toBe(true);
  return (await response.json()) as T;
};

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
});

test.afterAll(async () => {
  await context.close();
});

test('the picker opens the sites the core has, and names the rest', async () => {
  await seedSession(page, owner);
  await page.goto('/ko/plots');
  await page.getByTestId('plot-paste-import').click();
  await expect(page).toHaveURL(/\/ko\/plots\/import\/paste$/);

  await expect(page.getByTestId('migrate-site')).toHaveCount(5);
  for (const platform of ['caveduck', 'babechat', 'crack']) {
    const card = page.locator(`[data-testid="migrate-site"][data-platform="${platform}"]`);
    await expect(card).toHaveAttribute('aria-disabled', 'true');
    await expect(card).toContainText('준비 중');
  }
  await page.getByTestId('migrate-open-zeta').click();
  await expect(page).toHaveURL(/\/ko\/plots\/import\/paste\/zeta$/);
});

test('the form waits for every confirmation and a well-formed source page', async () => {
  const next = page.getByTestId('migrate-next');
  await expect(next).toBeDisabled();
  const items = page.getByTestId('migrate-confirm-item');
  await expect(items).toHaveCount(2);
  for (let index = 0; index < 2; index += 1) await items.nth(index).getByRole('checkbox').check();
  await expect(next).toBeEnabled();

  await page.getByTestId('migrate-source-url').fill('https://zeta-ai.io/ko/characters/nope');
  await expect(page.getByText('제타의 캐릭터 공개 페이지 주소가 아닙니다.')).toBeVisible();
  await expect(next).toBeDisabled();
  await page.getByTestId('migrate-source-url').fill(`https://zeta-ai.io/en/plots/${zetaId.toUpperCase()}/profile?tab=1`);
  await expect(next).toBeEnabled();
  await next.click();
  await expect(page.getByTestId('migrate-form')).toBeVisible();
});

test('the form takes the pasted fields and survives a reload', async () => {
  await field('about.title').fill(title);
  await field('about.summary').fill('비 오는 밤에만 여는 서점.');
  await field('prompt.description').fill(`자정까지 문을 여는 오래된 서점 ${run}.`);

  await field('characters[0].name').fill(alice);
  await field('characters[0].description').fill('서점을 지키는 사서.');
  // Ctrl+Enter inside a row adds the next one below it and moves there.
  await field('characters[0].description').press('Control+Enter');
  await expect(field('characters[1].name')).toBeFocused();
  await field('characters[1].name').fill(bob);
  await field('characters[1].description').fill('늘 늦게 오는 단골.');

  await page.getByTestId('migrate-add-profiles').click();
  await field('profiles[0].name').fill('손님');
  await field('profiles[0].description').fill('처음 서점에 들른 사람.');

  await field('intro.intro').fill(
    ['@: 비가 내리는 밤, 서점 문이 열린다.', `@${alice}: 어서 오세요.`, `@${bob}: 늦었네요.`].join('\n'),
  );

  await page.getByTestId('migrate-add-lorebook').click();
  await field('lorebook[0].name').fill('영업시간');
  await field('lorebook[0].keywords').fill('서점, 책방');
  await field('lorebook[0].content').fill('서점은 자정까지 연다.');

  await page.getByTestId('migrate-choice-style.storytelling-noir').click();
  await expect(page.getByTestId('migrate-choice-style.storytelling-noir')).toHaveAttribute('aria-pressed', 'true');

  // The copy this browser keeps lands a moment after the last keystroke.
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem('shizue.migrate.zeta') ?? ''))
    .toContain('서점은 자정까지 연다.');
  await page.reload();
  await expect(page.getByTestId('migrate-restored')).toBeVisible();
  await expect(field('about.title')).toHaveValue(title);
  await expect(field('characters[1].name')).toHaveValue(bob);
});

test('an image comes in under its source name', async () => {
  await page.getByTestId('migrate-next').click();
  await page.getByTestId('migrate-image-input').setInputFiles({
    name: 'smile.png',
    mimeType: 'image/png',
    buffer: png(),
  });
  await expect(page.getByTestId('migrate-image')).toHaveCount(1);
  await expect(page.getByTestId('migrate-image-name')).toHaveValue('smile');
  await page.getByTestId('migrate-image-description').fill('웃는 얼굴');
});

test('the preview draws the plot with its speakers', async () => {
  await page.getByTestId('migrate-next').click();
  await expect(page.getByTestId('migrate-preview-name')).toHaveText(title);
  await expect(page.getByTestId('migrate-preview-member')).toHaveCount(2);
  const intro = page.getByTestId('migrate-preview-intro');
  await expect(intro.locator(`[data-testid="migrate-speech-character"][data-speaker="${alice}"]`)).toContainText('어서 오세요.');
  await expect(intro.locator(`[data-testid="migrate-speech-character"][data-speaker="${bob}"]`)).toContainText('늦었네요.');
  await expect(intro.getByTestId('migrate-speech-narration')).toContainText('비가 내리는 밤');
  // The entry pasted, and the image list made from the described image.
  await expect(page.getByTestId('migrate-preview-lore')).toHaveCount(2);
  await expect(page.getByTestId('migrate-preview-style')).toContainText('느와르');
  await expect(page.getByTestId('migrate-already-imported')).toHaveCount(0);
});

test('creating makes the plot, uploads the image and offers the text that did not fit', async () => {
  await page.getByTestId('migrate-create').click();
  await expect(page.getByTestId('migrate-open-studio')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-testid="migrate-step"][data-status="done"]')).toHaveCount(2);
  plotId = (await page.getByTestId('migrate-open-studio').getAttribute('href'))!.split('/').pop()!;

  // The lore entry's name has no field here, so it is part of the preserved text.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('migrate-preserved-download').click(),
  ]);
  expect(download.suggestedFilename()).toBe('shizue-zeta-preserved.txt');
  const path = await download.path();
  expect(await readFile(path, 'utf8')).toContain('영업시간');

  // Made is made: the saved copy is gone.
  expect(await page.evaluate(() => window.localStorage.getItem('shizue.migrate.zeta'))).toBeNull();
});

test('the plot is private and holds what was pasted, in our protocol', async () => {
  const plot = await api<PlotRead>(`/api/plots/${plotId}`);
  expect(plot.name).toBe(title);
  expect(plot.visibility).toBe('private');
  expect(plot.characters.map((member) => member.name)).toEqual([alice, bob]);
  for (const member of plot.characters) {
    expect(member.importedFrom).toMatchObject({
      platform: 'zeta',
      method: 'paste',
      sourceUrl: `https://zeta-ai.io/ko/plots/${zetaId}/profile`,
    });
  }
  expect(plot.intros).toEqual([['비가 내리는 밤, 서점 문이 열린다.', `${alice}: 어서 오세요.`, `${bob}: 늦었네요.`].join('\n')]);
  const pasted = plot.lorebook.find((entry) => entry.content === '서점은 자정까지 연다.');
  expect(pasted?.keys).toEqual(['서점', '책방']);
  const images = plot.lorebook.find((entry) => entry.constant);
  expect(images?.content).toContain('smile: 웃는 얼굴');
  expect(plot.style?.storytelling).toBe('noir');
  expect(plot.profiles.map(({ name, description }) => ({ name, description }))).toEqual([
    { name: '손님', description: '처음 서점에 들른 사람.' },
  ]);

  const assets = await api<{ slug: string; name: string | null }[]>(`/api/plots/${plotId}/assets`);
  expect(assets.map(({ slug, name }) => ({ slug, name }))).toEqual([{ slug: 'smile', name: 'smile' }]);
});

test('publishing it asks for the owner’s word first', async () => {
  await page.goto(`/ko/plots/${plotId}`);
  const publish = page.getByRole('button', { name: '공개하기' });
  await expect(publish).toBeDisabled();
  await page
    .getByLabel('가져온 등장인물을 직접 만들었거나, 원작자에게 공개해도 좋다는 허락을 받았습니다.')
    .check();
  await expect(publish).toBeEnabled();
});

test('deleting the plot cleans up after the run', async () => {
  expect((await page.request.delete(`${origin}/api/plots/${plotId}`, { headers: { origin } })).ok()).toBe(true);
});
