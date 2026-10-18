/**
 * The owner's credentials (`/api/credentials`, ARCHITECTURE §7.1): API keys go in
 * sealed and never come out, only this computer writes or checks them, and a
 * removed one leaves its presets waiting for another.
 */
import { credentials, modelPresets } from '@shizue/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { tokenCipher } from '../src/chatgptAccounts.js';
import { maskKey } from '../src/credentials.js';
import { modelsHarness, readJson, SECRET } from './modelsHarness.js';

const h = modelsHarness();
const KEY = 'sk-proj-abcdefghijklmnopqrstuvwx1234';

describe('credentials', () => {
  it('seals a key on its way in and answers with a masked hint, never the key', async () => {
    const app = h.app();
    const created = await h.call(app, 'POST', '/api/credentials', { provider: 'openai', apiKey: `  ${KEY}\t` });
    expect(created.status).toBe(201);
    const body = await readJson(created);
    expect(body).toMatchObject({ kind: 'api_key', provider: 'openai', label: 'OpenAI', baseUrl: null, hint: 'sk-…1234', connected: true });
    expect(JSON.stringify(body)).not.toContain(KEY);
    expect(created.headers.get('cache-control')).toBe('no-store');

    const listed = await readJson(await h.call(app, 'GET', '/api/credentials'));
    expect(listed).toEqual([body]);
    expect(JSON.stringify(listed)).not.toContain('abcdefghijklmnop');

    const [row] = await h.db.select().from(credentials);
    expect(row!.secrets['apiKey']).not.toContain(KEY);
    expect(tokenCipher(SECRET).open(row!.secrets['apiKey']!)).toBe(KEY);
    expect(row!.userId).toBe(await h.owner());
  });

  it('holds a key to its provider and an address to http(s)', async () => {
    const app = h.app();
    const refused = [
      { provider: 'nope', apiKey: KEY },
      // The ChatGPT connection connects itself.
      { provider: 'chatgpt', apiKey: KEY },
      { provider: 'anthropic' },
      { provider: 'anthropic', apiKey: '' },
      { provider: 'openai', apiKey: 'sk-a\nb' },
      { provider: 'openai', apiKey: 7 },
      // A custom server has no address of its own.
      { provider: 'custom', apiKey: KEY },
      { provider: 'custom', baseUrl: 'javascript:alert(1)' },
      { provider: 'custom', baseUrl: 'http://user:pass@localhost:8000/v1' },
      { provider: 'custom', baseUrl: 'ftp://localhost/v1' },
    ];
    for (const body of refused) {
      const res = await h.call(app, 'POST', '/api/credentials', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await readJson(res)).code, JSON.stringify(body)).toBe('invalid_request');
    }
    expect(await h.db.select().from(credentials)).toEqual([]);

    // A keyless one needs only its address, its trailing slash gone.
    const proxy = await readJson(await h.call(app, 'POST', '/api/credentials', { provider: 'custom', baseUrl: 'http://localhost:8000/v1/', label: '  vLLM  ' }));
    expect(proxy).toMatchObject({ provider: 'custom', label: 'vLLM', baseUrl: 'http://localhost:8000/v1', hint: '' });
  });

  it('lets a paired phone read the list and nothing more', async () => {
    const app = h.app();
    const { id } = await readJson(await h.call(app, 'POST', '/api/credentials', { provider: 'openai', apiKey: KEY }));
    // Its first-preset listing aside (`ensureFirstPreset`), nothing below calls a provider.
    h.sent.length = 0;
    const phone = await h.phone();
    expect((await h.fromPhone(app, phone, 'GET', '/api/credentials')).status).toBe(200);
    for (const [method, path, body] of [
      ['POST', '/api/credentials', { provider: 'openai', apiKey: KEY }],
      ['PATCH', `/api/credentials/${id}`, { label: 'phone' }],
      ['DELETE', `/api/credentials/${id}`, undefined],
      ['POST', `/api/credentials/${id}/test`, undefined],
    ] as const) {
      const res = await h.fromPhone(app, phone, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await readJson(res)).toMatchObject({ code: 'local_only' });
    }
    expect(h.sent).toEqual([]);
    expect((await h.db.select().from(credentials)).map((row) => row.label)).toEqual(['OpenAI']);
  });

  it('replaces a key, its hint with it, and keeps the ChatGPT connection to a label', async () => {
    const app = h.app();
    const { id } = await readJson(await h.call(app, 'POST', '/api/credentials', { provider: 'openrouter', apiKey: KEY }));
    const patched = await readJson(await h.call(app, 'PATCH', `/api/credentials/${id}`, { apiKey: 'sk-or-v1-zzzzzzzzzzzz9876', label: 'Mine' }));
    expect(patched).toMatchObject({ hint: 'sk-…9876', label: 'Mine' });
    const [row] = await h.db.select().from(credentials);
    expect(tokenCipher(SECRET).open(row!.secrets['apiKey']!)).toBe('sk-or-v1-zzzzzzzzzzzz9876');

    const [chatgpt] = await h.db.insert(credentials).values({ userId: await h.owner(), kind: 'chatgpt', provider: 'chatgpt', label: 'ChatGPT' }).returning();
    expect((await h.call(app, 'PATCH', `/api/credentials/${chatgpt!.id}`, { apiKey: KEY })).status).toBe(400);
    expect((await h.call(app, 'DELETE', `/api/credentials/${chatgpt!.id}`)).status).toBe(400);
    expect(await readJson(await h.call(app, 'PATCH', `/api/credentials/${chatgpt!.id}`, { label: '내 ChatGPT' }))).toMatchObject({ label: '내 ChatGPT', connected: false });
  });

  it('leaves the presets on a removed key in place, waiting for another', async () => {
    const app = h.app();
    const { id } = await readJson(await h.call(app, 'POST', '/api/credentials', { provider: 'anthropic', apiKey: 'sk-ant-api03-abcdefghij' }));
    const preset = await readJson(await h.call(app, 'POST', '/api/model-presets', { name: 'Claude', format: 'anthropic', model: 'claude-sonnet-4-5', credentialId: id }));
    expect(preset.credentialId).toBe(id);
    expect((await h.call(app, 'DELETE', `/api/credentials/${id}`)).status).toBe(204);
    const [row] = await h.db.select().from(modelPresets).where(eq(modelPresets.id, preset.id));
    expect(row!.credentialId).toBeNull();
    expect((await h.call(app, 'DELETE', `/api/credentials/${id}`)).status).toBe(404);
  });

  it('checks a key with a call that needs it, and answers a refusal as the result', async () => {
    const app = h.app();
    const { id } = await readJson(await h.call(app, 'POST', '/api/credentials', { provider: 'openrouter', apiKey: KEY }));
    h.provider(() => Response.json({ data: { label: 'key' } }));
    expect(await readJson(await h.call(app, 'POST', `/api/credentials/${id}/test`))).toEqual({ ok: true });
    expect(h.sent.at(-1)).toMatchObject({ url: 'https://openrouter.ai/api/v1/key', headers: { authorization: `Bearer ${KEY}` } });

    h.provider(() => Response.json({ error: { message: `No auth credentials found for ${KEY}` } }, { status: 401 }));
    expect(await readJson(await h.call(app, 'POST', `/api/credentials/${id}/test`))).toEqual({ ok: false, code: 'provider_unauthorized', status: 401 });
  });

  it('stores nothing without the install secret to seal it with', async () => {
    const res = await h.call(h.app({ vault: undefined }), 'POST', '/api/credentials', { provider: 'openai', apiKey: KEY });
    expect(res.status).toBe(503);
    expect(await readJson(res)).toMatchObject({ code: 'credentials_unavailable' });
  });

  it('masks a key to its family and last four', () => {
    expect(maskKey('sk-ant-api03-abcdefgh')).toBe('sk-…efgh');
    expect(maskKey('AIzaSyD-abcdefghijklmn')).toBe('AIz…klmn');
    expect(maskKey('short')).toBe('…');
  });
});

describe('the first model preset', () => {
  /** An OpenAI-compatible server's model list. */
  const listing = (ids: string[]) => () => Response.json({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) });

  it("makes an owner's first key bring a preset on the provider's first listed model, and the default main", async () => {
    const app = h.app();
    h.provider(listing(['deepseek-reasoner', 'deepseek-chat']));
    const key = await readJson(await h.call(app, 'POST', '/api/credentials', { provider: 'deepseek', apiKey: KEY }));
    expect(h.sent).toMatchObject([{ url: 'https://api.deepseek.com/models', headers: { authorization: `Bearer ${KEY}` } }]);
    const presets = await h.db.select().from(modelPresets);
    expect(presets).toMatchObject([{ name: 'deepseek-chat', format: 'openai-chat', model: 'deepseek-chat', credentialId: key.id, endpoint: null }]);
    expect(await readJson(await h.call(app, 'GET', '/api/model-binding'))).toEqual({ main: presets[0]!.id, sub: null });

    // A second key finds a preset there, and neither lists nor makes another.
    await h.call(app, 'POST', '/api/credentials', { provider: 'mistral', apiKey: KEY });
    expect(h.sent).toHaveLength(1);
    expect(await h.db.select().from(modelPresets)).toHaveLength(1);
  });

  it('makes none when the listing fails, keeps the key, and leaves a default main that is set', async () => {
    const app = h.app();
    h.provider(() => new Response('upstream down', { status: 503 }));
    const kept = await h.call(app, 'POST', '/api/credentials', { provider: 'deepseek', apiKey: KEY });
    expect(kept.status).toBe(201);
    expect(await h.db.select().from(credentials)).toHaveLength(1);
    expect(await h.db.select().from(modelPresets)).toEqual([]);

    await h.call(app, 'PUT', '/api/model-binding', { main: 'echo/echo' });
    h.provider(listing(['mistral-large-latest']));
    await h.call(app, 'POST', '/api/credentials', { provider: 'mistral', apiKey: KEY });
    expect(await h.db.select().from(modelPresets)).toMatchObject([{ model: 'mistral-large-latest', format: 'openai-chat' }]);
    expect(await readJson(await h.call(app, 'GET', '/api/model-binding'))).toEqual({ main: 'echo/echo', sub: null });
  });
});
