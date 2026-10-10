import { seedSession } from '../seedSession.js';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * Card import along the owner's path, through the web origin and its `/api`
 * rewrite: a card file past the rewrite proxy's 10MB default arrives whole and
 * becomes a plot → the studio says where it came from and under what license →
 * publishing it waits for the owner's word → a second card comes in from a
 * RisuRealm page, which the browser downloads itself, and the now-public plot
 * asks for the word again first.
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
    description: `폐관 시간이 지난 도서관 ${run}.`,
    personality: '',
    scenario: '',
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

test('a card past the rewrite proxy’s default body limit arrives whole', async () => {
  await seedSession(page, owner);
  await page.goto('/ko/plots');

  // JSON takes whitespace anywhere, so this is one ordinary card in a 12MB
  // file — the size at which the proxy used to hand the API a truncated body.
  const padded = JSON.stringify(card(first, 'CC BY-NC-ND 4.0')) + ' '.repeat(12 * 1024 * 1024);
  await page.getByTestId('plot-import-input').setInputFiles({
    name: 'first.json',
    mimeType: 'application/json',
    buffer: Buffer.from(padded),
  });
  await expect(page).toHaveURL(new RegExp(`/ko/plots/${UUID_PATH}$`));
  plotId = new URL(page.url()).pathname.split('/').pop() ?? '';
  await expect(members()).toHaveCount(1);
});

test('the studio says where the card came from and under what license', async () => {
  const member = members().first();
  await expect(member).toContainText('가져옴');
  await member.locator('summary').click();
  const provenance = member.getByTestId('member-provenance');
  await expect(provenance).toContainText('파일 first.json');
  await expect(provenance).toContainText(`원작자${run}`);
  await expect(member.getByTestId('member-license')).toHaveText(
    'CC BY-NC-ND 4.0 · 저작자표시 · 비영리 · 변경금지',
  );
});

test('publishing waits for the owner’s word, warned harder for a no-derivatives card', async () => {
  const publish = page.getByRole('button', { name: '공개하기' });
  await expect(publish).toBeDisabled();
  await expect(page.getByTestId('rights-restricted')).toContainText(first);

  await page
    .getByLabel('가져온 등장인물을 직접 만들었거나, 원작자에게 공개해도 좋다는 허락을 받았습니다.')
    .check();
  await publish.click();
  await expect(page.getByRole('button', { name: '비공개로 전환' })).toBeVisible();
  await expect(page.getByText(/^권리 확인 /)).toBeVisible();
});

test('a RisuRealm page adds a member to the public plot, once the owner vouches for it', async () => {
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
  const submit = form.getByRole('button', { name: '가져오기' });
  // The plot is public, so the import itself would publish the card.
  await expect(submit).toBeDisabled();
  const confirm = page.getByLabel(
    '추가할 등장인물을 직접 만들었거나, 원작자에게 공개해도 좋다는 허락을 받았습니다.',
  );
  await confirm.check();
  await submit.click();

  await expect(members()).toHaveCount(2);
  expect(asked.map((url) => new URL(url).pathname.split('/')[4])).toEqual(['charx-v3', 'png-v3']);
  // Asked again for the next card.
  await expect(confirm).not.toBeChecked();
  const added = members().nth(1);
  await added.locator('summary').click();
  await expect(added.getByTestId('member-provenance').getByRole('link')).toHaveAttribute(
    'href',
    `https://realm.risuai.net/character/${realmId}`,
  );
  await expect(added.getByTestId('member-license')).toHaveText('CC BY 4.0 · 저작자표시');

  await page.goto(`/ko/p/${plotId}`);
  await expect(page.getByTestId('plot-member')).toHaveCount(2);
});

test('deleting the plot cleans up after the run', async () => {
  await page.goto(`/ko/plots/${plotId}`);
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: '플롯 삭제' }).click();
  await expect(page).toHaveURL(/\/ko\/plots$/);
});
