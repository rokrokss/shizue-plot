import { expect, test, type Route } from '@playwright/test';

test('AI draft locks its premise and other creation doors, preserving input after failure', async ({ page }) => {
  await page.route('**/api/auth/get-session', (route) => route.fulfill({ json: { user: { id: 'pending-reader', name: 'Reader' } } }));
  await page.route('**/api/plots', (route) => route.fulfill({ json: [] }));
  let release!: (route: Route) => void;
  const submitted = new Promise<Route>((resolve) => { release = resolve; });
  await page.route('**/api/plots/draft', (route) => release(route));
  await page.goto('/ko/plots');
  await page.getByTestId('plot-draft-open').click();
  const premise = page.getByTestId('plot-draft-panel').locator('textarea');
  await premise.fill('비 오는 밤의 서점에서 만나는 두 사람');
  await page.getByRole('button', { name: '초안 만들기', exact: true }).click();
  const request = await submitted;
  try {
    await expect(premise).toBeDisabled();
    await expect(page.getByTestId('plot-draft-open')).toBeDisabled();
    await expect(page.getByRole('button', { name: '새 플롯', exact: true })).toBeDisabled();
    await expect(page.getByTestId('plot-import-input')).toBeDisabled();
    await expect(page.getByRole('button', { name: '초안 만들기', exact: true })).toHaveAttribute('aria-busy', 'true');
    expect(request.request().postDataJSON()).toEqual({ premise: '비 오는 밤의 서점에서 만나는 두 사람' });
  } finally {
    await request.fulfill({ status: 502, json: { error: 'Draft failed', code: 'draft_failed' } });
  }
  await expect(premise).toBeEnabled();
  await expect(premise).toHaveValue('비 오는 밤의 서점에서 만나는 두 사람');
  await expect(page.getByRole('button', { name: '새 플롯', exact: true })).toBeEnabled();
  await expect(page.getByText('초안을 만들지 못했습니다. 설정을 조금 바꿔 다시 시도해 보세요.')).toBeVisible();
});

test('chat settings lock their snapshot without discarding the next message draft', async ({ page }) => {
  const { seedSession } = await import('../seedSession.js');
  await seedSession(page, { email: `pending-${Date.now()}@example.test`, password: 'e2e-password-1234', name: 'Pending' });
  const origin = process.env['E2E_WEB_URL'] ?? 'http://localhost:13000';
  const headers = { origin };
  const plotResponse = await page.request.post(`${origin}/api/plots`, {
    headers, data: { name: '저장 대기 테스트', description: '작은 서점', intros: ['문이 열렸다.'] },
  });
  expect(plotResponse.ok()).toBe(true);
  const plot = await plotResponse.json();
  const chatResponse = await page.request.post(`${origin}/api/chats`, {
    headers, data: { plotId: plot.id, model: 'echo/echo' },
  });
  expect(chatResponse.ok()).toBe(true);
  const state = await chatResponse.json();
  await page.goto(`/ko/chats/${state.chat.id}`);
  await page.getByRole('button', { name: '노트', exact: true }).click();
  const panel = page.getByTestId('chat-panel');
  const note = panel.locator('textarea').first();
  await note.fill('저장할 대화 설정');
  const composer = page.getByPlaceholder('메시지를 입력하세요…');
  await composer.fill('다음에 보낼 메시지');
  let release!: (route: Route) => void;
  const submitted = new Promise<Route>((resolve) => { release = resolve; });
  await page.route(`**/api/chats/${state.chat.id}`, (route) => route.request().method() === 'PATCH' ? release(route) : route.continue());
  await panel.getByRole('button', { name: '저장', exact: true }).first().click();
  const request = await submitted;
  try {
    await expect(note).toBeDisabled();
    await expect(page.getByLabel('모델', { exact: true }).first()).toBeDisabled();
    await expect(page.getByRole('button', { name: '보내기', exact: true })).toBeDisabled();
    await expect(composer).toBeEnabled();
  } finally {
    await request.fulfill({ status: 500, json: { error: 'Save failed', code: 'internal_error' } });
  }
  await expect(note).toBeEnabled();
  await expect(note).toHaveValue('저장할 대화 설정');
  await expect(composer).toHaveValue('다음에 보낼 메시지');
  await expect(page.getByRole('button', { name: '보내기', exact: true })).toBeEnabled();
});
