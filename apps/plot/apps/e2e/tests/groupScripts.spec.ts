import { importFile } from '../fileImport.js';
import { seedSession } from '../seedSession.js';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * Two RisuAI cards in one work, end to end with the echo model: each card's
 * start trigger counts its own start, its output trigger its own finish, its
 * display script draws a status panel with a button whose manual trigger has the
 * same name on both cards, and its background HTML carries a stylesheet. One
 * round, both speaking in roster order (set through the API), must leave:
 *
 * - each card's start and output having run once — on its own reply only;
 * - each card's panel on its own bubble only, both reading the one namespace
 *   the members share;
 * - a button running the triggers of the card whose bubble holds it;
 * - the companion's stylesheet dressing its own bubble only, the work's first
 *   card's dressing every bubble;
 * - the first card's background behind the chat, never the companion's.
 *
 * The studio then shows the companion's script as its own (적용 대상).
 */
test.describe.configure({ mode: 'serial' });

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const account = { email: `e2e-scripts-${run}@example.test`, password: 'e2e-password-1234', name: 'E2E' };
const WEB = process.env['E2E_WEB_URL'] ?? 'http://localhost:13000';
const headers = { origin: WEB };

let context: BrowserContext;
let page: Page;
let plotId = '';
let chatId = '';
/** The two members' ids: the work's first card, and the companion. */
let lumi = '';
let nox = '';

const setvar = (variable: string, value: string, operator = '=') => ({
  type: 'v2SetVar',
  var: variable,
  value,
  operator,
  valueType: 'value',
  indent: 0,
});

/**
 * A RisuAI card: `mark` names its variables (`start<mark>`, `out<mark>`), its
 * panel's class and its button; `color` is what its own stylesheet paints every
 * `.panel` with; `sky` is the text of its background.
 */
function card(name: string, mark: string, color: string, sky: string, defaults: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name,
        description: `${name}의 설정.`,
        personality: '',
        scenario: '눈 덮인 여관.',
        first_mes: `문이 열린다 ${run}`,
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
            defaultVariables: defaults,
            backgroundHTML: `<div class="sky">${sky}</div><style>.panel { color: ${color}; }</style>`,
            customScripts: [
              {
                comment: '상태창',
                in: '\\[status\\]',
                out:
                  `<div class="panel ${mark}-panel">${name} · 시작 {{getvar::startA}}/{{getvar::startB}}` +
                  ` · 끝 {{getvar::outA}}/{{getvar::outB}} · 누름 {{getvar::pressed}}` +
                  `<button risu-trigger="누름">${name} 버튼</button></div>`,
                type: 'editdisplay',
              },
            ],
            triggerscript: [
              { comment: '', type: 'start', conditions: [], effect: [setvar(`start${mark}`, '1', '+=')] },
              { comment: '', type: 'output', conditions: [], effect: [setvar(`out${mark}`, '1', '+=')] },
              // The same name on both cards: the bubble decides whose runs.
              { comment: '누름', type: 'manual', conditions: [], effect: [setvar('pressed', name)] },
            ],
          },
        },
      },
    }),
  );
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
});

test.afterAll(async () => {
  await context.close();
});

const bubbleOf = (memberId: string) => page.locator(`[data-testid="message-assistant"][data-shizue-member="${memberId}"]`);

test('a work of two RisuAI cards, the second joining the first', async () => {
  await seedSession(page, account);
  const made = await importFile(page.request, WEB, headers, { target: 'plot' }, {
    name: 'lumi.json',
    buffer: card('루미', 'A', 'rgb(255, 0, 0)', `루미의 하늘 ${run}`, 'startA=0\nstartB=0\noutA=0\noutB=0\npressed=-'),
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const plot = made.json as { id: string; characters: { id: string }[] };
  plotId = plot.id;
  lumi = plot.characters[0]!.id;

  const joined = await importFile(page.request, WEB, headers, { target: 'member', plotId }, {
    name: 'nox.json',
    buffer: card('녹스', 'B', 'rgb(0, 0, 255)', `녹스의 동굴 ${run}`, 'startA=9\ngold=3'),
  });
  expect(joined.status, JSON.stringify(joined.json)).toBe(201);
  const companion = joined.json as { id: string; variableConflicts: string[] };
  nox = companion.id;
  // The work already had its own value for the companion's `startA`.
  expect(companion.variableConflicts).toEqual(['startA']);

  // Both speak, in roster order, every round.
  const ordered = await page.request.patch(`${WEB}/api/plots/${plotId}`, {
    headers,
    data: { groupSettings: { order: 'list', maxSpeakers: 2 } },
  });
  expect(ordered.status(), await ordered.text()).toBe(200);
});

test('each card’s scripts run for its own reply and draw on its own bubble, over one namespace', async () => {
  const chat = await page.request.post(`${WEB}/api/chats`, { headers, data: { plotId, model: 'echo/echo' } });
  expect(chat.status(), await chat.text()).toBe(201);
  chatId = ((await chat.json()) as { chat: { id: string } }).chat.id;
  await page.goto(`/ko/chats/${chatId}`);
  await expect(page.getByTestId('message-assistant')).toHaveCount(1);

  // The work's one background is the first card's; the companion's is drawn nowhere.
  await expect(page.getByTestId('chat-background')).toContainText(`루미의 하늘 ${run}`);
  await expect(page.getByTestId('chat-background')).not.toContainText('녹스의 동굴');

  await page.getByPlaceholder('메시지를 입력하세요').fill('[status] 눈이 그칠 때까지 쉬어 갈게요');
  await page.getByRole('button', { name: '보내기' }).click();
  await expect(page.getByTestId('message-assistant')).toHaveCount(3);
  await expect(page.getByRole('button', { name: '보내기' })).toBeVisible();

  const mine = bubbleOf(lumi).locator('.x-shizue-A-panel');
  const theirs = bubbleOf(nox).locator('.x-shizue-B-panel');
  // Each start and each output ran once — on its own card's reply.
  await expect(mine).toContainText('루미 · 시작 1/1 · 끝 1/1 · 누름 -');
  await expect(theirs).toContainText('녹스 · 시작 1/1 · 끝 1/1 · 누름 -');
  // A card's panel is on its own bubble only.
  await expect(bubbleOf(lumi).locator('.x-shizue-B-panel')).toHaveCount(0);
  await expect(bubbleOf(nox).locator('.x-shizue-A-panel')).toHaveCount(0);

  // The work's first card's stylesheet dresses every bubble; the companion's, its own on top.
  await expect(mine).toHaveCSS('color', 'rgb(255, 0, 0)');
  await expect(theirs).toHaveCSS('color', 'rgb(0, 0, 255)');

  // The same button name on both cards: the bubble holding it decides whose trigger runs.
  await theirs.getByRole('button', { name: '녹스 버튼' }).click();
  await expect(mine).toContainText('누름 녹스');
  await mine.getByRole('button', { name: '루미 버튼' }).click();
  await expect(theirs).toContainText('누름 루미');
});

test('a scripts read the page has moved past never rebuilds its runtimes', async () => {
  // The development build runs the page's effects twice on load, so the chat's
  // scripts are read twice. The first answer is held until the second has landed
  // and then renames both members: a page that took it would build its runtimes
  // again from it, ending the Lua calls the first set had started.
  const stale = `낡은 답 ${run}`;
  let reads = 0;
  let secondLanded!: () => void;
  const second = new Promise<void>((resolve) => (secondLanded = resolve));
  let staleSent!: () => void;
  const sent = new Promise<void>((resolve) => (staleSent = resolve));
  await page.route(`**/api/chats/${chatId}/scripts`, async (route) => {
    reads += 1;
    const first = reads === 1;
    const response = await route.fetch();
    if (!first) {
      await route.fulfill({ response });
      secondLanded();
      return;
    }
    const answer = (await response.json()) as { members: { overlay: { member: object | null } }[] };
    // Bounded, so a page that reads once fails on the count below rather than hanging.
    await Promise.race([second, new Promise((resolve) => setTimeout(resolve, 15_000))]);
    for (const member of answer.members) member.overlay.member = { ...member.overlay.member, name: stale };
    await route.fulfill({ response, json: answer });
    staleSent();
  });
  await page.reload();
  await sent;
  expect(reads).toBe(2);
  await expect(page.locator('.chat-name', { hasText: '녹스' }).first()).toBeVisible();
  // Time for the held answer to have been taken, had the page taken it.
  await page.waitForTimeout(1000);
  await expect(page.getByText(stale)).toHaveCount(0);
  await page.unroute(`**/api/chats/${chatId}/scripts`);
});

test('the studio shows the companion’s display script as its own', async () => {
  await page.goto(`/ko/plots/${plotId}`);
  const scripts = page.getByTestId('display-script');
  await expect(scripts).toHaveCount(2);
  await scripts.nth(1).locator('summary').click();
  await expect(scripts.nth(1).getByTestId('display-script-member')).toHaveValue(nox);
  await expect(scripts.nth(0).getByTestId('display-script-member-name')).toHaveText('루미');
  // The work's background, the first card's, is the field's.
  await expect(page.getByTestId('work-background')).toHaveValue(`<div class="sky">루미의 하늘 ${run}</div>`);
});
