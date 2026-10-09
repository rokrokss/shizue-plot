import { seedSession } from '../seedSession.js';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * Visual baselines for the onboarding surfaces (docs/design/shizue-ui.md)
 * and for the chat as a phone gets it.
 *
 * The baseline is the human-approved rendering of the design, not the AI
 * reference mockup — regenerate with `--update-snapshots` only after a design
 * change has been approved. Snapshots are platform-suffixed, so they pin the
 * environment they were created on.
 */

const VIEWPORTS = [
  { label: 'desktop', width: 1440, height: 1024 },
  { label: 'mobile', width: 390, height: 844 },
] as const;

for (const viewport of VIEWPORTS) {
  test.describe(`auth pages — ${viewport.label}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test.beforeEach(async ({ page }) => {
      await page.route('**/api/auth/get-session', (route) => route.fulfill({ json: null }));
      await page.route('**/api/chatgpt', (route) => route.fulfill({
        json: { connected: false, email: null, pending: false, errorCode: null },
      }));
    });

    test('login matches the approved design', async ({ page }) => {
      await page.goto('/ko/login');
      await expect(page.getByRole('heading', { name: /한 줄의 시작/ })).toBeVisible();
      // The dev-mode Next.js indicator is not part of the design.
      await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });

      await expect(page).toHaveScreenshot(`login-${viewport.label}.png`, {
        animations: 'disabled',
        maxDiffPixelRatio: 0.01,
      });
    });
  });
}

/**
 * The chat on a phone, where the header's settings are a sheet rather than a
 * row. Everything the screenshot contains is fixed on purpose — the plot's name
 * and its opening are the same every run, and the account is the only thing
 * carrying the run id, because it never appears on the page.
 *
 * The steps build on each other, so this file's chat half runs serially.
 */
test.describe('chat — mobile', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ viewport: { width: 390, height: 844 } });

  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const account = { email: `e2e-vis-${run}@example.test`, password: 'e2e-password-1234', name: 'E2E' };
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
  });

  test.afterAll(async () => {
    await context.close();
  });

  test('a chat is opened on a phone-sized screen', async () => {
    await seedSession(page, account);
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
    await page.getByLabel('모델').selectOption('echo/echo');
    await page.getByRole('button', { name: '대화 시작' }).click();
    await expect(page).toHaveURL(new RegExp(`/ko/chats/${UUID_PATH}$`));
    await expect(page.getByTestId('message-assistant').first()).toContainText(plot.intro);
  });

  test('the conversation matches the approved design', async () => {
    await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
    await expect(page).toHaveScreenshot('chat-mobile.png', {
      animations: 'disabled',
      maxDiffPixelRatio: 0.01,
    });
  });

  test('the settings sheet matches the approved design', async () => {
    await page.getByRole('button', { name: '대화 설정' }).click();
    await expect(page.getByTestId('bottom-sheet')).toBeVisible();
    await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
    await expect(page).toHaveScreenshot('chat-settings-mobile.png', {
      animations: 'disabled',
      maxDiffPixelRatio: 0.01,
    });
  });
});
