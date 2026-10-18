import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { seedSession } from '../seedSession.js';

/**
 * A model preset from PocketRisu's registry, end to end: a Google key whose
 * address is a stand-in for AI Studio on this computer, Gemini 3.8 Flash
 * picked in Settings › Models' profile browser and saved from its editor, and a
 * chat turn on it — the request the stand-in receives is the profile's (its own
 * reply cap, no safety settings), and the reply it streams is the turn's. The
 * spec puts the owner's default binding back and removes what it made, so the
 * specs after it chat on echo as before.
 */

const origin = process.env['E2E_WEB_URL'] ?? 'http://localhost:13000';
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const KEY = `AIzaE2EStandIn${run}`;
const REPLY = `안개 너머에서 등대지기가 손을 흔든다 ${run}`;

interface Received {
  url: string;
  headers: IncomingMessage['headers'];
  body: Record<string, any>;
}

/** AI Studio's `streamGenerateContent?alt=sse`, as Google streams it: a thought, the reply, a finish. */
function standIn(received: Received[]): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    let text = '';
    request.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
    request.on('end', () => {
      received.push({ url: request.url ?? '', headers: request.headers, body: JSON.parse(text || '{}') as Record<string, any> });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
      response.end(
        chunk({ candidates: [{ content: { role: 'model', parts: [{ text: '등대를 떠올린다', thought: true }] } }] })
        + chunk({ candidates: [{ content: { role: 'model', parts: [{ text: REPLY }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 12 } }),
      );
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port })));
}

test('a Gemini 3.8 Flash preset from the registry answers a chat turn', async ({ page }) => {
  const received: Received[] = [];
  const { server, port } = await standIn(received);
  const headers = { origin };
  await seedSession(page);
  const binding = await (await page.request.get(`${origin}/api/model-binding`)).json();
  const before = new Set(((await (await page.request.get(`${origin}/api/model-presets`)).json()) as { id: string }[]).map((preset) => preset.id));
  const keyRes = await page.request.post(`${origin}/api/credentials`, {
    headers, data: { provider: 'google', label: `Stand-in ${run}`, apiKey: KEY, baseUrl: `http://127.0.0.1:${port}/v1beta` },
  });
  expect(keyRes.status()).toBe(201);
  const key = (await keyRes.json()) as { id: string };
  try {
    await page.goto('/ko/settings');
    await page.getByRole('button', { name: '프리셋 추가' }).click();
    const browser = page.getByTestId('model-profile-browser');
    await expect(browser).toBeVisible();
    await browser.getByRole('searchbox').fill('3.8 Flash');
    // The older Gemini the owner once picked is hidden until asked for.
    await expect(browser.getByTestId('model-profile').filter({ hasText: 'google:gemini-25-flash' })).toHaveCount(0);
    await browser.getByTestId('model-profile').filter({ hasText: 'google:gemini-38-flash' }).click();

    const editor = page.getByTestId('profile-preset-editor');
    await expect(editor).toBeVisible();
    await expect(editor.locator('[data-field="maxOutputTokens"] input')).toHaveValue('8192');
    await editor.locator('select').first().selectOption(key.id);
    await editor.locator('[data-field="thinkingLevel"] select').selectOption('low');
    await editor.getByRole('button', { name: '저장' }).click();
    await expect(editor).toHaveCount(0);

    const presets = (await (await page.request.get(`${origin}/api/model-presets`)).json()) as { id: string; credentialId: string | null; sourceProfile?: { profileId: string } | null; userValues?: Record<string, unknown> }[];
    const preset = presets.find((entry) => !before.has(entry.id) && entry.sourceProfile?.profileId === 'google:gemini-38-flash')!;
    expect(preset).toMatchObject({ credentialId: key.id, userValues: { thinkingLevel: 'low', maxOutputTokens: 8192 } });

    const plot = await page.request.post(`${origin}/api/plots`, { headers, data: { name: `등대 ${run}`, description: '안개 낀 밤의 등대', intros: ['불빛이 깜빡인다.'] } });
    expect(plot.ok()).toBe(true);
    const chat = await page.request.post(`${origin}/api/chats`, { headers, data: { plotId: (await plot.json()).id, modelBinding: { main: preset.id } } });
    expect(chat.ok()).toBe(true);
    const { chat: { id: chatId } } = await chat.json();
    await page.goto(`/ko/chats/${chatId}`);
    await page.getByPlaceholder('메시지를 입력하세요').fill('거기 누구 있어요?');
    await page.getByRole('button', { name: '보내기', exact: true }).click();
    await expect(page.getByText(REPLY)).toBeVisible();

    expect(received).toHaveLength(1);
    expect(received[0]!.url).toBe('/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse');
    expect(received[0]!.headers['x-goog-api-key']).toBe(KEY);
    expect(received[0]!.body['generationConfig']).toEqual({ maxOutputTokens: 8192, thinkingConfig: { thinkingLevel: 'low', includeThoughts: true }, responseLogprobs: false });
    expect(received[0]!.body).not.toHaveProperty('safetySettings');
  } finally {
    await page.request.put(`${origin}/api/model-binding`, { headers, data: binding });
    const after = (await (await page.request.get(`${origin}/api/model-presets`)).json()) as { id: string; builtIn?: boolean }[];
    for (const preset of after) if (!preset.builtIn && !before.has(preset.id)) await page.request.delete(`${origin}/api/model-presets/${preset.id}`, { headers });
    await page.request.delete(`${origin}/api/credentials/${key.id}`, { headers });
    server.close();
  }
});
