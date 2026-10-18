import { seedSession } from '../seedSession.js';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * Visual baselines for the chat as a phone gets it (docs/design/shizue-ui.md).
 *
 * The baseline is the human-approved rendering of the design, not the AI
 * reference mockup — regenerate with `--update-snapshots` only after a design
 * change has been approved. Snapshots are platform-suffixed, so they pin the
 * environment they were created on.
 */

/**
 * Takes out what is not part of the design: the dev-mode Next.js indicator, and
 * the host's scrollbars. macOS draws overlay or classic scrollbars depending on
 * whether a mouse is attached, and only a classic one makes `scrollbar-gutter:
 * stable` (globals.css) reserve a gutter — so without this the same page lands
 * a few pixels apart on the same Mac from one day to the next.
 */
async function hideUndesigned(page: Page): Promise<void> {
  await page.addStyleTag({
    content: [
      'nextjs-portal { display: none !important; }',
      '* { scrollbar-width: none !important; }',
      '::-webkit-scrollbar { display: none !important; }',
    ].join('\n'),
  });
  // No gutter is left, whichever kind of scrollbar the host draws.
  expect(await page.evaluate(() => window.innerWidth - document.documentElement.clientWidth)).toBe(0);
}

/**
 * The chat on a phone, and the settings sheet its ☰ opens. Everything the
 * screenshot contains is fixed on purpose — the plot's name and its opening are
 * the same every run, and the owner's presets are answered as none.
 *
 * The steps build on each other, so this file runs serially.
 */
test.describe('chat — mobile', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ viewport: { width: 390, height: 844 } });

  const plot = {
    name: '스냅샷 호스트',
    description: '낯선 방 하나뿐인 무대.',
    intro: '문이 열리고, 낯선 방의 공기가 밀려든다.',
  };
  const UUID_PATH = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext();
    page = await context.newPage();
    // The run's one owner holds the other specs' presets too; the sheet is drawn
    // as for an owner with none of their own.
    await page.route('**/api/reader-presets', (route) => route.fulfill({ json: [] }));
  });

  test.afterAll(async () => {
    await context.close();
  });

  test('a chat is opened on a phone-sized screen', async () => {
    await seedSession(page);
    await expect(page).toHaveURL(/\/ko$/);

    await page.goto('/ko/plots');
    await page.getByRole('button', { name: '새 플롯' }).click();
    await page.getByPlaceholder('플롯 이름').fill(plot.name);
    await page.getByRole('button', { name: '만들기', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/ko/plots/${UUID_PATH}$`));
    const plotId = new URL(page.url()).pathname.split('/').pop() ?? '';

    await page.getByLabel('세계관 설정').fill(plot.description);
    await page.getByRole('button', { name: '도입부 추가' }).click();
    await page.getByTestId('plot-intro').fill(plot.intro);
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await expect(page.getByText('저장했습니다')).toBeVisible();

    // A chat opens on the work's own page, which is the same one for creator
    // and reader.
    await page.goto(`/ko/p/${plotId}`);
    await page.getByRole('combobox', { name: '모델', exact: true }).selectOption('echo/echo');
    await page.getByRole('button', { name: '대화 시작' }).click();
    await expect(page).toHaveURL(new RegExp(`/ko/chats/${UUID_PATH}$`));
    await expect(page.getByTestId('message-assistant').first()).toContainText(plot.intro);
  });

  test('the conversation matches the approved design', async () => {
    await hideUndesigned(page);
    await expect(page).toHaveScreenshot('chat-mobile.png', {
      animations: 'disabled',
      maxDiffPixelRatio: 0.01,
    });
  });

  test('the settings sheet matches the approved design', async () => {
    await page.getByRole('button', { name: '대화 설정' }).click();
    await expect(page.getByTestId('bottom-sheet')).toBeVisible();
    await hideUndesigned(page);
    await expect(page).toHaveScreenshot('chat-settings-mobile.png', {
      animations: 'disabled',
      maxDiffPixelRatio: 0.01,
    });
  });
});
