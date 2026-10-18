/**
 * The model layer through the API (ARCHITECTURE §7.1): model presets and their
 * checks, a chat's binding and the owner's default, where a key's requests go,
 * the ChatGPT connection's catalog rules, the picker's listing and a preset's
 * test. Provider calls are answered by the harness's stand-in for `fetch`.
 */
import { chats, credentials, messages, user } from '@shizue/db';
import { ChatGPTOAuth } from '@shizue/llm';
import { asc, eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createChatGPTAccounts, tokenCipher } from '../src/chatgptAccounts.js';
import type { AppEnv } from '../src/deps.js';
import { chatCompletion, modelsHarness, readJson, readSse, SECRET, sseBody } from './modelsHarness.js';

const h = modelsHarness();
const KEY = 'sk-proj-abcdefghijklmnopqrstuvwx1234';

async function created(res: Response): Promise<any> {
  expect(res.status, await res.clone().text()).toBe(201);
  return readJson(res);
}

/** A keyless preset on a local Chat Completions server, for `model`. */
const localPreset = (app: Hono<AppEnv>, model: string, extra: Record<string, unknown> = {}) =>
  h.call(app, 'POST', '/api/model-presets', { name: model, format: 'openai-chat', endpoint: 'http://localhost:1234/v1', model, ...extra }).then(created);

/** A work with an opening, and a chat on it with `binding`. */
async function chatOn(app: Hono<AppEnv>, binding?: Record<string, unknown>): Promise<string> {
  const plot = await created(await h.call(app, 'POST', '/api/plots', { name: '도서관', description: '밤의 도서관.', intros: ['문 앞이다.'] }));
  const chat = await created(await h.call(app, 'POST', '/api/chats', { plotId: plot.id, ...(binding ? { modelBinding: binding } : {}) }));
  return chat.chat.id;
}

/** Sends a turn and reads the stream to its end. */
const send = async (app: Hono<AppEnv>, chatId: string, content = '안녕') =>
  readSse(await h.call(app, 'POST', `/api/chats/${chatId}/messages`, { content }));

describe('model presets', () => {
  it('describe each format by the values it sends, and the providers a key is entered for', async () => {
    const { formats, providers, localEndpoints, instructTemplates } = await readJson(await h.call(h.app(), 'GET', '/api/model-presets/formats'));
    const byId = Object.fromEntries(formats.map((format: any) => [format.id, format]));
    expect(Object.keys(byId)).toEqual([
      'openai-chat', 'openai-responses', 'anthropic', 'google', 'vertex', 'bedrock', 'mistral', 'cohere',
      'ollama', 'ooba', 'ooba-legacy', 'kobold', 'novelai', 'novellist', 'horde', 'openai-legacy', 'anthropic-legacy', 'echo',
    ]);
    expect(byId['openai-chat']).toMatchObject({ key: 'optional', chatgptParameters: null, reformat: {}, instructTemplate: false });
    expect(byId['openai-chat'].parameters).toEqual(expect.arrayContaining(['temperature', 'minP', 'topA', 'repetitionPenalty', 'reasoningEffort']));
    expect(byId['openai-chat'].parameters).not.toContain('thinkingTokens');
    expect(byId['anthropic'].parameters).toEqual(['temperature', 'topP', 'topK', 'reasoningEffort', 'thinkingTokens']);
    expect(byId['anthropic'].reformat).toBeNull();
    expect(byId['openai-responses']).toMatchObject({ key: 'required', chatgptParameters: ['reasoningEffort'] });
    // RisuAI's flags for its Mistral models, which a preset's own lay over; a template for the text formats.
    expect(byId['mistral']).toMatchObject({ reformat: { systemPrompt: 'first', alternateRoles: true, startWithUser: true }, instructTemplate: false });
    expect(byId['kobold']).toMatchObject({ key: 'optional', defaultBaseUrl: 'http://localhost:5001', reformat: { systemPrompt: 'first' }, instructTemplate: true });
    expect(instructTemplates).toEqual(['llama3', 'llama2', 'chatml', 'gpt2', 'gemma', 'mistral', 'vicuna', 'alpaca', 'jinja']);
    expect(providers.map((provider: any) => provider.id)).toEqual([
      'openai', 'anthropic', 'google', 'vertex', 'aws', 'openrouter', 'deepseek', 'deepinfra', 'mistral', 'cohere', 'nanogpt', 'novelai', 'novellist', 'horde', 'ollama', 'custom',
    ]);
    expect(providers.find((provider: any) => provider.id === 'aws')).toMatchObject({ kind: 'aws', baseUrl: null, formats: ['bedrock'] });
    expect(providers.find((provider: any) => provider.id === 'openai')).toMatchObject({ kind: 'api_key', formats: ['openai-responses', 'openai-chat', 'openai-legacy'] });
    expect(localEndpoints).toContainEqual({ id: 'ollama', label: 'Ollama', endpoint: 'http://localhost:11434/v1', formats: ['openai-chat'] });
    expect(localEndpoints).toContainEqual({ id: 'koboldcpp', label: 'KoboldCpp', endpoint: 'http://localhost:5001', formats: ['kobold'] });
  });

  it('makes, changes and removes a preset, held to its format, its credential and its values', async () => {
    const app = h.app();
    const preset = await localPreset(app, 'qwen3:8b', { endpoint: 'http://localhost:1234/v1/', params: { temperature: 0.8, stop: ['\n###'] }, capabilities: { systemPrompt: 'first' } });
    expect(preset).toMatchObject({ format: 'openai-chat', endpoint: 'http://localhost:1234/v1', model: 'qwen3:8b', credentialId: null, params: { temperature: 0.8, stop: ['\n###'] }, capabilities: { systemPrompt: 'first' } });
    const listed = await readJson(await h.call(app, 'GET', '/api/model-presets'));
    expect(listed.map((entry: any) => entry.id)).toEqual(['echo/echo', preset.id]);

    const { id: openai } = await created(await h.call(app, 'POST', '/api/credentials', { provider: 'openai', apiKey: KEY }));
    const refused: [Record<string, unknown>, string][] = [
      [{ name: 'x', format: 'nope', model: 'm', endpoint: 'http://localhost:1/v1' }, 'format_unavailable'],
      [{ name: 'x', format: 'anthropic', model: 'claude' }, 'credential_required'],
      [{ name: 'x', format: 'openai-chat', model: 'm' }, 'endpoint_required'],
      [{ name: 'x', format: 'anthropic', model: 'claude', credentialId: openai }, 'credential_format_mismatch'],
      [{ name: 'x', format: 'openai-chat', model: 'm', endpoint: 'http://localhost:1/v1', params: { temperature: 5 } }, 'invalid_request'],
      [{ name: 'x', format: 'openai-chat', model: 'm', endpoint: 'http://localhost:1/v1', params: { seed: 1 } }, 'invalid_request'],
      [{ name: 'x', format: 'openai-chat', model: 'm', endpoint: 'http://localhost:1/v1', capabilities: { vision: 'yes' } }, 'invalid_request'],
      [{ name: ' ', format: 'openai-chat', model: 'm', endpoint: 'http://localhost:1/v1' }, 'invalid_request'],
      [{ name: 'x', format: 'openai-chat', model: '', endpoint: 'http://localhost:1/v1' }, 'invalid_request'],
      [{ name: 'x', format: 'openai-chat', model: 'm', endpoint: 'file:///etc/passwd' }, 'invalid_request'],
    ];
    for (const [body, code] of refused) {
      const res = await h.call(app, 'POST', '/api/model-presets', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await readJson(res)).code, JSON.stringify(body)).toBe(code);
    }
    expect((await h.call(app, 'POST', '/api/model-presets', { name: 'x', format: 'openai-chat', model: 'm', credentialId: crypto.randomUUID() })).status).toBe(404);

    const patched = await readJson(await h.call(app, 'PATCH', `/api/model-presets/${preset.id}`, { name: '로컬 Qwen', params: { temperature: 1.1 } }));
    expect(patched).toMatchObject({ name: '로컬 Qwen', model: 'qwen3:8b', params: { temperature: 1.1 }, capabilities: { systemPrompt: 'first' } });
    const claude = await created(await h.call(app, 'POST', '/api/model-presets', {
      name: 'Claude', format: 'anthropic', model: 'claude-sonnet-4-5',
      credentialId: (await created(await h.call(app, 'POST', '/api/credentials', { provider: 'anthropic', apiKey: 'sk-ant-api03-abcdefghij' }))).id,
    }));
    expect((await readJson(await h.call(app, 'PATCH', `/api/model-presets/${claude.id}`, { credentialId: null }))).code).toBe('credential_required');

    expect((await h.call(app, 'DELETE', `/api/model-presets/${preset.id}`)).status).toBe(204);
    expect((await readJson(await h.call(app, 'GET', '/api/model-presets'))).map((entry: any) => entry.id)).toEqual(['echo/echo', claude.id]);
    expect((await h.call(app, 'DELETE', `/api/model-presets/${preset.id}`)).status).toBe(404);
  });

  it("runs a chat's turn on its main preset with the preset's values, and sends a key only to its own address", async () => {
    const app = h.app();
    const { id: openai } = await created(await h.call(app, 'POST', '/api/credentials', { provider: 'openai', apiKey: KEY }));
    const preset = await created(await h.call(app, 'POST', '/api/model-presets', {
      name: 'GPT', format: 'openai-chat', model: 'gpt-5.4-mini', credentialId: openai,
      // An address for a keyless preset; one with a key goes to the key's.
      endpoint: 'https://attacker.example/v1',
      params: { temperature: 0.7, maxTokens: 900 },
    }));
    const chatId = await chatOn(app, { main: preset.id });
    // The key's first-preset listing aside (`ensureFirstPreset`), only the turns call a provider.
    h.sent.length = 0;
    h.provider(() => chatCompletion('누구세요?', '문이 열렸다'));
    expect((await send(app, chatId)).at(-1)!.event).toBe('done');

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ url: 'https://api.openai.com/v1/chat/completions', headers: { authorization: `Bearer ${KEY}` } });
    expect(h.sent[0]!.body).toMatchObject({ model: 'gpt-5.4-mini', temperature: 0.7, max_completion_tokens: 900, stream: true });
    const [reply] = await h.db.select().from(messages).where(eq(messages.chatId, chatId)).orderBy(asc(messages.createdAt)).then((rows) => rows.slice(-1));
    // The thinking is kept folded above the reply, never in its text.
    expect(reply).toMatchObject({ role: 'assistant', content: '누구세요?', reasoning: '문이 열렸다', model: 'gpt-5.4-mini' });

    // A paired phone may edit the preset; the key still goes nowhere else.
    const phone = await h.phone();
    expect((await h.fromPhone(app, phone, 'PATCH', `/api/model-presets/${preset.id}`, { endpoint: 'https://elsewhere.example/v1' })).status).toBe(200);
    await send(app, chatId, '또');
    expect(h.sent.map((request) => new URL(request.url).host)).toEqual(['api.openai.com', 'api.openai.com']);
  });

  it('tells a turn the provider refused, and keeps no reply of it', async () => {
    const app = h.app();
    const chatId = await chatOn(app, { main: (await localPreset(app, 'qwen3:8b')).id });
    h.provider(() => Response.json({ error: { message: 'slow down' } }, { status: 429 }));
    const events = await send(app, chatId);
    expect(events.at(-1)).toMatchObject({ event: 'error', data: { code: 'provider_rate_limited' } });
    const rows = await h.db.select().from(messages).where(eq(messages.chatId, chatId));
    expect(rows.filter((row) => row.role === 'assistant')).toHaveLength(1);

    // A server nobody answers at is told as such.
    h.provider(() => { throw new TypeError('fetch failed'); });
    expect((await send(app, chatId, '다시')).at(-1)).toMatchObject({ event: 'error', data: { code: 'provider_unreachable' } });
  });
});

describe('model bindings', () => {
  it("follows the default where the chat leaves a slot open, and the main where the sub is open", async () => {
    const app = h.app();
    const a = await localPreset(app, 'a-model');
    const b = await localPreset(app, 'b-model');
    expect(await readJson(await h.call(app, 'GET', '/api/model-binding'))).toEqual({ main: null, sub: null });
    expect(await readJson(await h.call(app, 'PUT', '/api/model-binding', { main: a.id }))).toEqual({ main: a.id, sub: null });

    const chatId = await chatOn(app);
    const state = await readJson(await h.call(app, 'GET', `/api/chats/${chatId}`));
    expect(state.chat.modelBinding).toEqual({ main: null, sub: null });
    h.provider(() => chatCompletion('{"suggestions": ["하나", "둘", "셋"]}'));
    await send(app, chatId);
    // The default moves, and the open slot with it.
    await h.call(app, 'PUT', '/api/model-binding', { main: b.id });
    await send(app, chatId, '또');
    // The side work's sub is open everywhere: it runs on the main.
    expect((await h.call(app, 'POST', `/api/chats/${chatId}/suggest`)).status).toBe(200);
    // The chat's own sub.
    await h.call(app, 'PATCH', `/api/chats/${chatId}`, { modelBinding: { sub: a.id } });
    expect((await h.call(app, 'POST', `/api/chats/${chatId}/suggest`)).status).toBe(200);
    expect(h.sent.map((request) => request.body!['model'])).toEqual(['a-model', 'b-model', 'b-model', 'a-model']);

    for (const [body, code] of [[{ main: 'nope' }, 'model_unavailable'], [{ main: crypto.randomUUID() }, 'model_unavailable'], [{ main: 7 }, 'invalid_request']] as const) {
      const res = await h.call(app, 'PUT', '/api/model-binding', body);
      expect(res.status).toBe(400);
      expect((await readJson(res)).code).toBe(code);
    }
    expect(await readJson(await h.call(app, 'GET', '/api/model-binding'))).toEqual({ main: b.id, sub: null });
  });

  it("hands a removed preset's chats and the default back to what their open slots follow", async () => {
    const app = h.app();
    const a = await localPreset(app, 'a-model');
    const b = await localPreset(app, 'b-model');
    await h.call(app, 'PUT', '/api/model-binding', { main: a.id, sub: b.id });
    const chatId = await chatOn(app, { main: b.id, sub: a.id });

    await h.call(app, 'DELETE', `/api/model-presets/${b.id}`);
    expect((await readJson(await h.call(app, 'GET', `/api/chats/${chatId}`))).chat.modelBinding).toEqual({ main: null, sub: a.id });
    expect(await readJson(await h.call(app, 'GET', '/api/model-binding'))).toEqual({ main: a.id, sub: null });
    await h.call(app, 'DELETE', `/api/model-presets/${a.id}`);
    const [row] = await h.db.select({ binding: chats.modelBinding }).from(chats).where(eq(chats.id, chatId));
    expect(row!.binding).toBeNull();
    const [owner] = await h.db.select({ binding: user.modelBinding }).from(user);
    expect(owner!.binding).toBeNull();

    // Nothing bound at all — outside the tests, which fall back on echo: a turn
    // is refused before anything is written.
    const res = await h.call(h.app({ env: { NODE_ENV: 'production' } }), 'POST', `/api/chats/${chatId}/messages`, { content: '안녕' });
    expect(res.status).toBe(400);
    expect((await readJson(res)).code).toBe('model_unavailable');
  });

  it('opens no chat without a model to run it on', async () => {
    const app = h.app({ env: { NODE_ENV: 'production' } });
    const plot = await created(await h.call(app, 'POST', '/api/plots', { name: '도서관' }));
    const res = await h.call(app, 'POST', '/api/chats', { plotId: plot.id });
    expect(res.status).toBe(400);
    expect((await readJson(res)).code).toBe('model_unavailable');
    // Nor names the test catalog outside the tests.
    expect((await readJson(await h.call(app, 'GET', '/api/model-presets'))).map((entry: any) => entry.id)).toEqual([]);
  });
});

describe('a preset on the ChatGPT connection', () => {
  /** The owner's ChatGPT connection, its tokens fresh, its catalog the one model `gpt-5.4`. */
  async function connected() {
    const fakeOpenAI: typeof fetch = async (input) => {
      if (String(input).endsWith('/models')) {
        return Response.json({ models: [{ slug: 'gpt-5.4', display_name: 'GPT-5.4', visibility: 'list', input_modalities: ['text', 'image'], supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] }] });
      }
      throw new Error(`unexpected ${String(input)}`);
    };
    const accounts = createChatGPTAccounts(h.db, { secret: SECRET, callbackPort: 47801, oauth: new ChatGPTOAuth({ fetch: fakeOpenAI }) });
    const cipher = tokenCipher(SECRET);
    const [row] = await h.db.insert(credentials).values({
      userId: await h.owner(), kind: 'chatgpt', provider: 'chatgpt', label: 'ChatGPT',
      secrets: { accessToken: cipher.seal('ACCESS'), refreshToken: cipher.seal('REFRESH') },
      meta: { subject: 'alice', clientId: 'app_alice', scope: 'chatgpt.tokens.use.direct' },
      expiresAt: new Date(Date.now() + 60 * 60_000),
    }).returning();
    return { app: h.app({ chatgpt: { accounts } }), credentialId: row!.id };
  }
  const completed = sseBody([
    { type: 'response.output_text.delta', delta: '네' },
    { type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 1 } } },
  ]);

  it("sends what the plan takes — an advertised effort, the cache's key — and holds the model to the catalog", async () => {
    const { app, credentialId } = await connected();
    const preset = await created(await h.call(app, 'POST', '/api/model-presets', {
      name: 'GPT-5.4', format: 'openai-responses', model: 'gpt-5.4', credentialId, params: { reasoningEffort: 'high', temperature: 0.2 },
    }));
    const chatId = await chatOn(app, { main: preset.id });
    h.provider(() => completed);
    expect((await send(app, chatId)).at(-1)!.event).toBe('done');
    expect(h.sent[0]).toMatchObject({ url: 'https://api.openai.com/v1/responses', headers: { authorization: 'Bearer ACCESS', session_id: chatId } });
    expect(h.sent[0]!.body).toMatchObject({ model: 'gpt-5.4', store: false, reasoning: { effort: 'high' }, prompt_cache_key: chatId });
    expect(h.sent[0]!.body).not.toHaveProperty('temperature');

    // An effort the model does not advertise is not sent.
    await h.call(app, 'PATCH', `/api/model-presets/${preset.id}`, { params: { reasoningEffort: 'xhigh' } });
    await send(app, chatId, '또');
    expect(h.sent[1]!.body).not.toHaveProperty('reasoning');

    // A model the catalog no longer lists refuses the turn before anything is written.
    await h.call(app, 'PATCH', `/api/model-presets/${preset.id}`, { model: 'gpt-gone' });
    const before = await h.db.select().from(messages).where(eq(messages.chatId, chatId));
    const res = await h.call(app, 'POST', `/api/chats/${chatId}/messages`, { content: '안녕' });
    expect(res.status).toBe(400);
    expect((await readJson(res)).code).toBe('model_unavailable');
    expect(await h.db.select().from(messages).where(eq(messages.chatId, chatId))).toHaveLength(before.length);
  });

  it("lists the account's catalog for the picker, and takes no format but the Responses one", async () => {
    const { app, credentialId } = await connected();
    expect(await readJson(await h.call(app, 'GET', `/api/model-presets/catalog?format=openai-responses&credentialId=${credentialId}`))).toEqual([
      { id: 'gpt-5.4', label: 'GPT-5.4', vision: true, reasoningEfforts: ['low', 'high'] },
    ]);
    const res = await h.call(app, 'POST', '/api/model-presets', { name: 'x', format: 'openai-chat', model: 'gpt-5.4', credentialId });
    expect((await readJson(res)).code).toBe('credential_format_mismatch');
  });
});

describe("a format's models and a preset's test", () => {
  it('lists the models behind an address before and after a preset is saved', async () => {
    const app = h.app();
    h.provider(() => Response.json({ data: [{ id: 'qwen3:8b' }, { id: 'nomic-embed-text' }] }));
    const listed = await readJson(await h.call(app, 'GET', `/api/model-presets/catalog?format=openai-chat&endpoint=${encodeURIComponent('http://localhost:11434/v1')}`));
    expect(listed).toEqual([{ id: 'qwen3:8b', label: 'qwen3:8b' }]);
    expect(h.sent[0]).toMatchObject({ url: 'http://localhost:11434/v1/models' });
    expect(h.sent[0]!.headers['authorization']).toBeUndefined();

    const { id: deepseek } = await created(await h.call(app, 'POST', '/api/credentials', { provider: 'deepseek', apiKey: KEY }));
    const preset = await created(await h.call(app, 'POST', '/api/model-presets', { name: 'DS', format: 'openai-chat', model: 'deepseek-chat', credentialId: deepseek }));
    await h.call(app, 'GET', `/api/model-presets/${preset.id}/models`);
    expect(h.sent[1]).toMatchObject({ url: 'https://api.deepseek.com/models', headers: { authorization: `Bearer ${KEY}` } });

    const keyless = await h.call(app, 'GET', '/api/model-presets/catalog?format=anthropic');
    expect(keyless.status).toBe(400);
    expect((await readJson(keyless)).code).toBe('credential_required');
  });

  it('tests a preset with one tiny request, and answers a refusal as the result', async () => {
    const app = h.app();
    const preset = await localPreset(app, 'qwen3:8b');
    h.provider(() => chatCompletion('OK'));
    expect(await readJson(await h.call(app, 'POST', `/api/model-presets/${preset.id}/test`))).toEqual({ ok: true, text: 'OK', ms: expect.any(Number) });
    expect(h.sent[0]!.body).toMatchObject({ model: 'qwen3:8b', max_tokens: 64, messages: [{ role: 'user', content: 'Reply with the single word OK.' }] });
    h.provider(() => Response.json({ error: { message: 'bad key' } }, { status: 401 }));
    expect(await readJson(await h.call(app, 'POST', `/api/model-presets/${preset.id}/test`))).toEqual({ ok: false, code: 'provider_unauthorized', status: 401 });
  });
});
