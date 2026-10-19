import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import { seedSession } from '../seedSession.js';

/**
 * The owner's "소악마" prompt preset and its module, end to end (wave 8,
 * 2026-10-19): the `.risup` and the `.risum` they downloaded, brought in through
 * the chat's settings — the preset's import reads the file in the page, the
 * module's goes up in parts and a job reads it, its low-level access taken on a
 * yes — the preset picked for a chat on Gemini 3.8 Flash, whose module
 * integration turns the module on, and a turn whose reply is shaped as the
 * preset asks Gemini to write: reasoning in `<Thoughts>`, then a `# Response`.
 * The stand-in for AI Studio streams it. What RisuAI draws of it, the page
 * draws: no `$n` anywhere, the dialogue in the module's boxes, the reasoning
 * gone while 🗯추론확인 할래 is off and folded under 생각의 사슬 once it is on,
 * and the reader's own turn as they wrote it.
 */

const origin = process.env['E2E_WEB_URL'] ?? 'http://localhost:13000';
const headers = { origin };
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
/**
 * Someone else's files, kept out of this public repository: the gitignored
 * `apps/plot/data/fixtures/sokakma/`. Where they are not copied in, the spec
 * is skipped.
 */
const FIXTURES = new URL('../../../data/fixtures/sokakma/', import.meta.url);
const present = ['sokakma-module.risum', 'sokakma-preset.risup'].every((file) => existsSync(new URL(file, FIXTURES)));
const PRESET_NAME = '😈소악마 프롬프트 v16-9A [Gem3.1]';

/** The reply as the preset's response template asks for it. */
const REPLY = [
  '<Thoughts>',
  `The user greeted Ria with a calm "안녕". Ria, a 19-year-old barista, answers playfully ${run}.`,
  '</Thoughts>',
  '# Response',
  '⏱️[2026-10-19 (월) 18:40]',
  '',
  '카페 문이 딸랑 하고 울렸다. 리아가 고개를 들었다.',
  '',
  '"어, 왔어? 기다리다 목 빠지는 줄 알았잖아."',
  '',
  '그녀는 컵을 내려놓으며 §딸깍§ 웃었다.',
  '',
  '리아가 「어서」라고 작게 중얼거렸다.',
  '',
  "'오늘은 좀 늦었네.'",
].join('\n');

/** AI Studio's `streamGenerateContent?alt=sse`: a thought of its own, the reply in two parts, a finish. */
function standIn(): Promise<{ server: Server; port: number; received: number[] }> {
  const received: number[] = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      received.push(Date.now());
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
      const half = REPLY.indexOf('# Response');
      response.end(
        chunk({ candidates: [{ content: { role: 'model', parts: [{ text: '응답 형식을 떠올린다', thought: true }] } }] }) +
          chunk({ candidates: [{ content: { role: 'model', parts: [{ text: REPLY.slice(0, half) }] } }] }) +
          chunk({
            candidates: [{ content: { role: 'model', parts: [{ text: REPLY.slice(half) }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 4000, candidatesTokenCount: 200 },
          }),
      );
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port, received })));
}

/** The notes panel, closed again from the settings sheet, so a screenshot shows the chat. */
async function closeNotes(page: Page): Promise<void> {
  if (!(await page.getByTestId('chat-panel').isVisible())) return;
  await page.getByRole('button', { name: '대화 설정' }).click();
  await page.getByRole('dialog', { name: '대화 설정' }).getByRole('button', { name: '노트', exact: true }).click();
  if (await page.getByRole('dialog', { name: '대화 설정' }).isVisible()) await page.keyboard.press('Escape');
  await expect(page.getByTestId('chat-panel')).toHaveCount(0);
}

async function openNotes(page: Page) {
  if (!(await page.getByTestId('chat-panel').isVisible())) {
    await page.getByRole('button', { name: '대화 설정' }).click();
    await page.getByRole('dialog', { name: '대화 설정' }).getByRole('button', { name: '노트', exact: true }).click();
  }
  const panel = page.getByTestId('chat-panel');
  await expect(panel).toBeVisible();
  return panel;
}

test('the 소악마 preset and module draw a Gemini reply as RisuAI draws it', async ({ page }) => {
  test.skip(!present, 'the 소악마 files are not in apps/plot/data/fixtures/sokakma');
  test.setTimeout(240_000);
  const { server, port, received } = await standIn();
  const logs: string[] = [];
  page.on('console', (message: ConsoleMessage) => logs.push(message.text()));
  await seedSession(page);
  const binding = await (await page.request.get(`${origin}/api/model-binding`)).json();
  const made: { presets: string[]; credential?: string; plot?: string; readerPreset?: string; module?: string } = { presets: [] };
  try {
    // Gemini 3.8 Flash from PocketRisu's registry, on a key whose address is the stand-in.
    const key = await page.request.post(`${origin}/api/credentials`, {
      headers,
      data: { provider: 'google', label: `소악마 ${run}`, apiKey: `AIzaSokakma${run}`, baseUrl: `http://127.0.0.1:${port}/v1beta` },
    });
    expect(key.status()).toBe(201);
    made.credential = ((await key.json()) as { id: string }).id;
    const preset = await page.request.post(`${origin}/api/model-presets`, {
      headers,
      data: { profileId: 'google:gemini-38-flash', credentialId: made.credential },
    });
    expect(preset.status()).toBe(201);
    const modelPreset = ((await preset.json()) as { id: string }).id;
    made.presets.push(modelPreset);

    const plot = await page.request.post(`${origin}/api/plots`, {
      headers,
      data: { name: `리아 ${run}`, description: '카페에서 일하는 열아홉 살 바리스타.', intros: ['리아가 카운터를 닦고 있다.'] },
    });
    expect(plot.ok()).toBe(true);
    made.plot = ((await plot.json()) as { id: string }).id;
    // A member to speak: the module's scripts ride on the cast, as RisuAI's on its character.
    expect((await page.request.post(`${origin}/api/plots/${made.plot}/characters`, { headers, data: { name: '리아' } })).status()).toBe(201);
    const chat = await page.request.post(`${origin}/api/chats`, { headers, data: { plotId: made.plot, modelBinding: { main: modelPreset } } });
    expect(chat.ok()).toBe(true);
    const chatId = ((await chat.json()) as { chat: { id: string } }).chat.id;

    await page.goto(`/ko/chats/${chatId}`);
    // The module first, into the reader's library and on for every chat, as the
    // owner had it; it asks for low-level access, and the reader says yes.
    const panel = await openNotes(page);
    page.once('dialog', (dialog) => void dialog.accept());
    await panel.getByTestId('reader-module-file').setInputFiles({
      name: 'sokakma-module.risum',
      mimeType: 'application/octet-stream',
      buffer: readFileSync(new URL('sokakma-module.risum', FIXTURES)),
    });
    const module = panel.getByTestId('reader-module').filter({ hasText: '📱소악마 기본 모듈 261017' });
    await expect(module).toBeVisible({ timeout: 60_000 });
    // Held by the server's answer, so it turns on once the write is answered.
    await module.getByRole('checkbox', { name: '모든 대화에서 켜기' }).click();
    await expect(module.getByRole('checkbox', { name: '모든 대화에서 켜기' })).toBeChecked();
    await expect(module.getByRole('checkbox', { name: '이 대화에서 켜기' })).toBeChecked();
    // Its Lua starts on the messages on screen — the greeting — and is still
    // loading its engine when the preset below builds the scripts anew under it.
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape');

    // The preset, read in the page from the file and saved, then picked for the chat:
    // the scripts are built anew under the Lua already running.
    await page.getByRole('button', { name: '대화 설정' }).click();
    const sheet = page.getByRole('dialog', { name: '대화 설정' });
    await sheet.getByRole('button', { name: '내 프리셋 관리' }).click();
    await sheet.getByTestId('reader-preset-import-input').setInputFiles({
      name: 'sokakma-preset.risup',
      mimeType: 'application/octet-stream',
      buffer: readFileSync(new URL('sokakma-preset.risup', FIXTURES)),
    });
    await expect(sheet.getByTestId('reader-preset-import-notice')).toBeVisible();
    const saved = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/reader-presets'));
    await sheet.getByRole('button', { name: '저장', exact: true }).click();
    made.readerPreset = ((await (await saved).json()) as { id: string }).id;
    const picked = page.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().includes(`/api/chats/${chatId}`));
    await sheet.getByRole('combobox', { name: '내 프리셋' }).selectOption({ label: PRESET_NAME });
    expect((await picked).status()).toBe(200);
    await page.keyboard.press('Escape');

    const library = (await (await page.request.get(`${origin}/api/chats/${chatId}/modules`)).json()) as {
      library: { id: string; name: string; onHere?: boolean }[];
      presetDisplayScripts?: unknown[];
    };
    const entry = library.library.find((row) => row.name === '📱소악마 기본 모듈 261017')!;
    made.module = entry.id;
    expect(entry.onHere).toBe(true);
    // The preset's own `editdisplay` regex rides to the page with the modules'.
    expect(library.presetDisplayScripts?.length).toBeGreaterThan(0);

    // The preset's toggles, drawn as RisuAI's sidebar draws them: groups, dividers, selects.
    const toggles = (await openNotes(page)).getByTestId('chat-toggles');
    await expect(toggles.locator('summary', { hasText: '😈소악마 그룹1' })).toBeVisible();
    await toggles.locator('summary', { hasText: '😈소악마 그룹3' }).click();
    await expect(toggles.getByRole('separator').filter({ hasText: '😈유틸리티' })).toBeVisible();
    // A select nothing set reads as nothing, as RisuAI's `getGlobalChatVarNH` does.
    await expect(toggles.locator('label', { hasText: '🌞라이트/🌛다크모드' }).locator('select')).toHaveValue('');
    await closeNotes(page);

    await page.getByPlaceholder('메시지를 입력하세요').fill('안녕');
    await page.getByRole('button', { name: '보내기', exact: true }).click();
    const reply = page.getByTestId('message-assistant').last();
    await expect(reply).toContainText('카페 문이 딸랑 하고 울렸다.', { timeout: 60_000 });
    expect(received).toHaveLength(1);

    // As RisuAI draws it with the toggles as they come: the reasoning gone, the response boxed.
    await expect(page.locator('body')).not.toContainText('$n');
    await expect(page.locator('body')).not.toContainText('#@%');
    await expect(reply).not.toContainText('The user greeted Ria');
    await expect(reply).not.toContainText('# Response');
    await expect(reply.locator('.x-shizue-regex-quote-block')).toContainText('어, 왔어? 기다리다 목 빠지는 줄 알았잖아.');
    // In the colours of the module's first dark mode, the one its background's
    // `{{#if}}` draws while 🌞라이트/🌛다크모드 is unset — not the last mode's.
    await expect(reply.locator('.x-shizue-regex-quote-block')).toHaveCSS('color', 'rgb(241, 187, 87)');
    await expect(reply.locator('.x-shizue-regex-thought-block')).toHaveCSS('color', 'rgb(127, 171, 241)');
    await expect(reply.locator('.x-shizue-regex-thought-block')).toContainText('오늘은 좀 늦었네.');
    await expect(reply.locator('.x-shizue-ts-badge')).toContainText('18:40');
    await expect(reply.locator('.x-shizue-regex-sound-block')).toContainText('딸깍');
    // The sound chip is a `<div>` the module puts between blank lines, and RisuAI's
    // markdown draws it as a block of its own between the line's two paragraphs:
    // here it stands outside the bubbles, between the two halves of the line.
    await expect(reply.locator('.chat-bubble .x-shizue-regex-sound-block')).toHaveCount(0);
    await expect(reply.locator('.chat-bubble', { hasText: '그녀는 컵을 내려놓으며' })).not.toContainText('웃었다.');
    // The 「…」 a script colours is a `<span>`, a run of its line in RisuAI's
    // paragraph: here it stays in that line, in the line's bubble.
    const line = reply.locator('.chat-bubble p', { hasText: '「어서」' });
    const word = line.locator('span', { hasText: '「어서」' });
    await expect(word).toHaveCSS('color', 'rgb(255, 179, 102)');
    await expect(line).toHaveText(/^리아가 「어서」\u200b?라고 작게 중얼거렸다\.$/);
    const turn = page.getByTestId('message-user').last();
    // The `<Thoughts>` the module opens on every message is never closed in a turn, and draws nothing.
    await expect(turn.locator('.message-body')).toHaveText(/^\s*안녕\s*$/);
    await turn.scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'test-results/sokakma/turn-and-background.png' });
    await reply.scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'test-results/sokakma/reply-toggle-off.png' });

    // The module's output script took the reasoning out of the stored reply too, as
    // RisuAI's does while the toggle is off (`<Thoughts> 출력문`).
    // The page runs the output scripts once the reply is in and commits what they made.
    const storedReply = async (): Promise<string> =>
      ((await (await page.request.get(`${origin}/api/chats/${chatId}`)).json()) as { path: { content: string }[] }).path.at(-1)!.content;
    await expect.poll(storedReply, { timeout: 30_000 }).not.toContain('<Thoughts>');
    expect(await storedReply()).toContain('# Response');

    // 🗯추론확인 할래 on, and the next reply keeps its reasoning, folded under RisuAI's 생각의 사슬.
    const notes = await openNotes(page);
    await notes.getByTestId('chat-toggles').locator('summary', { hasText: '😈소악마 그룹3' }).click();
    const wrote = page.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().endsWith('/global-variables'));
    await notes.getByRole('checkbox', { name: '🗯추론확인 할래' }).click();
    expect((await wrote).status()).toBe(200);
    await closeNotes(page);
    await page.getByPlaceholder('메시지를 입력하세요').fill('오늘 바빠?');
    await page.getByRole('button', { name: '보내기', exact: true }).click();
    await expect.poll(() => received.length, { timeout: 60_000 }).toBe(2);
    const second = page.getByTestId('message-assistant').last();
    const fold = second.locator('details').filter({ has: page.locator('summary', { hasText: '생각의 사슬' }) });
    await expect(fold).toBeVisible({ timeout: 60_000 });
    await expect(second).toContainText('카페 문이 딸랑 하고 울렸다.');
    await expect(fold).not.toHaveAttribute('open', '');
    await expect(second.locator('.x-shizue-regex-quote-block')).toContainText('어, 왔어?');
    await fold.scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'test-results/sokakma/reply-thoughts-folded.png' });
    await fold.locator('summary').click();
    await expect(fold).toContainText(`The user greeted Ria with a calm "안녕". Ria, a 19-year-old barista, answers playfully ${run}.`);
    await expect(page.locator('body')).not.toContainText('$n');
    await fold.scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'test-results/sokakma/reply-thoughts-open.png' });

    // The module's Lua ran its display pass on every message, and nothing it did was cut off.
    expect(logs.filter((line) => line.includes('[scripts]') && line.includes('triggerlua'))).toEqual([]);
  } finally {
    await page.request.put(`${origin}/api/model-binding`, { headers, data: binding });
    if (made.plot) await page.request.delete(`${origin}/api/plots/${made.plot}`, { headers });
    if (made.readerPreset) await page.request.delete(`${origin}/api/reader-presets/${made.readerPreset}`, { headers });
    if (made.module) await page.request.delete(`${origin}/api/reader-modules/${made.module}`, { headers });
    for (const id of made.presets) await page.request.delete(`${origin}/api/model-presets/${id}`, { headers });
    if (made.credential) await page.request.delete(`${origin}/api/credentials/${made.credential}`, { headers });
    server.close();
  }
});
