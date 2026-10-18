/**
 * The owner's credentials (`/api/credentials`, ARCHITECTURE §7.1): API keys go in
 * sealed and never come out, only this computer writes or checks them, and a
 * removed one leaves its presets waiting for another.
 */
import { credentials, modelPresets } from '@shizue/db';
import { generateKeyPairSync } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { tokenCipher } from '../src/chatgptAccounts.js';
import { maskKey } from '../src/credentials.js';
import { preferredModel } from '../src/models.js';
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

  it("makes an owner's first key bring a preset on the provider's chat model, and the default main", async () => {
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
    // Mistral's own format first, as RisuAI sends Mistral.
    expect(await h.db.select().from(modelPresets)).toMatchObject([{ model: 'mistral-large-latest', format: 'mistral' }]);
    expect(await readJson(await h.call(app, 'GET', '/api/model-binding'))).toEqual({ main: 'echo/echo', sub: null });
  });
});

describe('AWS keys and Google service accounts', () => {
  const ACCESS_KEY = 'AKIAIOSFODNN7EXAMPLE';
  const SECRET_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
  /** Bedrock's model list, as `GET /foundation-models` answers it. */
  const foundationModels = () => Response.json({ modelSummaries: [
    { modelId: 'anthropic.claude-3-5-haiku-20241022-v1:0', modelName: 'Claude 3.5 Haiku', inputModalities: ['TEXT'], responseStreamingSupported: true },
    { modelId: 'anthropic.claude-sonnet-4-5-20250929-v1:0', modelName: 'Claude Sonnet 4.5', inputModalities: ['TEXT', 'IMAGE'], responseStreamingSupported: true },
  ] });

  it("seals each AWS key apart, keeps the region beside them, and signs the first preset's listing with them", async () => {
    const app = h.app();
    h.provider(foundationModels);
    const created = await h.call(app, 'POST', '/api/credentials', { provider: 'aws', accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY, sessionToken: 'FQoGZXIvYXdzEXAMPLE', region: 'eu-central-1' });
    expect(created.status).toBe(201);
    const body = await readJson(created);
    expect(body).toMatchObject({ kind: 'aws', provider: 'aws', label: 'AWS Bedrock', baseUrl: null, hint: 'AKI…MPLE · eu-central-1' });
    expect(JSON.stringify(await readJson(await h.call(app, 'GET', '/api/credentials')))).not.toContain(SECRET_KEY);
    const [row] = await h.db.select().from(credentials);
    expect(Object.keys(row!.secrets).sort()).toEqual(['accessKeyId', 'secretAccessKey', 'sessionToken']);
    expect(tokenCipher(SECRET).open(row!.secrets['secretAccessKey']!)).toBe(SECRET_KEY);
    expect(JSON.stringify(row!.secrets)).not.toContain(SECRET_KEY);
    expect(row!.meta).toEqual({ region: 'eu-central-1' });
    // The first preset: on Bedrock's list, a Sonnet.
    expect(h.sent[0]).toMatchObject({ url: 'https://bedrock.eu-central-1.amazonaws.com/foundation-models?byProvider=Anthropic&byOutputModality=TEXT', headers: { 'x-amz-security-token': 'FQoGZXIvYXdzEXAMPLE' } });
    expect(h.sent[0]!.headers['authorization']).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/eu-central-1\/bedrock\/aws4_request/);
    expect(await h.db.select().from(modelPresets)).toMatchObject([{ format: 'bedrock', model: 'anthropic.claude-sonnet-4-5-20250929-v1:0', credentialId: body.id }]);

    // The region alone may change; the preset's turns go to the new one.
    expect(await readJson(await h.call(app, 'PATCH', `/api/credentials/${body.id}`, { region: 'us-west-2' }))).toMatchObject({ hint: 'AKI…MPLE · us-west-2' });
    const [preset] = await h.db.select().from(modelPresets);
    h.provider(() => Response.json({ message: 'The security token included in the request is invalid.' }, { status: 403 }));
    expect(await readJson(await h.call(app, 'POST', `/api/model-presets/${preset!.id}/test`))).toEqual({ ok: false, code: 'provider_unauthorized', status: 403 });
    expect(h.sent.at(-1)!.url).toBe('https://bedrock-runtime.us-west-2.amazonaws.com/model/global.anthropic.claude-sonnet-4-5-20250929-v1%3A0/invoke-with-response-stream');

    for (const bad of [
      { provider: 'aws', accessKeyId: 'not a key', secretAccessKey: SECRET_KEY, region: 'us-east-1' },
      { provider: 'aws', accessKeyId: ACCESS_KEY, region: 'us-east-1' },
      { provider: 'aws', accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY, region: 'mars-1' },
      { provider: 'aws', accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
    ]) {
      const res = await h.call(app, 'POST', '/api/credentials', bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await h.call(app, 'PATCH', `/api/credentials/${body.id}`, { apiKey: KEY })).status).toBe(400);
  });

  it("seals a service account's private key, keeps its address and project, and checks it by minting a token", async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const file = JSON.stringify({ type: 'service_account', project_id: 'my-project', private_key_id: 'k1', private_key: privateKey, client_email: 'shizue@my-project.iam.gserviceaccount.com' });
    const app = h.app();
    const created = await h.call(app, 'POST', '/api/credentials', { provider: 'vertex', serviceAccount: file, region: 'asia-northeast3' });
    expect(created.status).toBe(201);
    const body = await readJson(created);
    expect(body).toMatchObject({ kind: 'gcp_service_account', provider: 'vertex', hint: 'shizue@my-project.iam.gserviceaccount.com · asia-northeast3' });
    const [row] = await h.db.select().from(credentials);
    expect(row!.meta).toEqual({ clientEmail: 'shizue@my-project.iam.gserviceaccount.com', projectId: 'my-project', region: 'asia-northeast3' });
    expect(tokenCipher(SECRET).open(row!.secrets['privateKey']!)).toBe(privateKey);
    expect(JSON.stringify(row!.secrets)).not.toContain('PRIVATE KEY');
    // Vertex lists no models: the first preset is on RisuAI's Gemini list, and no call was made.
    expect(h.sent).toEqual([]);
    expect(await h.db.select().from(modelPresets)).toMatchObject([{ format: 'vertex', model: 'gemini-3.8-flash' }]);

    h.provider(() => Response.json({ access_token: 'ya29.api-test', expires_in: 3599 }));
    expect(await readJson(await h.call(app, 'POST', `/api/credentials/${body.id}/test`))).toEqual({ ok: true });
    expect(h.sent[0]!.url).toBe('https://oauth2.googleapis.com/token');
    expect(new URLSearchParams(h.sent[0]!.text).get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');

    for (const bad of [{ provider: 'vertex', serviceAccount: '{}' }, { provider: 'vertex', serviceAccount: file, region: 'Seoul' }, { provider: 'vertex' }]) {
      expect((await h.call(app, 'POST', '/api/credentials', bad)).status, JSON.stringify(bad).slice(0, 60)).toBe(400);
    }
  });

  it('keeps AWS keys and service accounts to this computer, as every key is', async () => {
    const app = h.app();
    const phone = await h.phone();
    const res = await h.fromPhone(app, phone, 'POST', '/api/credentials', { provider: 'aws', accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY, region: 'us-east-1' });
    expect(res.status).toBe(403);
    expect(await h.db.select().from(credentials)).toEqual([]);
  });
});

describe("a new key's first model", () => {
  /** The ids OpenAI's `/models` gave a key (2026-10). */
  const OPENAI = [
    'babbage-002', 'chatgpt-4o-latest', 'codex-mini-latest', 'computer-use-preview', 'dall-e-3', 'davinci-002', 'gpt-3.5-turbo',
    'gpt-3.5-turbo-instruct', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-audio-preview', 'gpt-4o-mini', 'gpt-4o-mini-transcribe',
    'gpt-4o-realtime-preview', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-image-1', 'o3', 'o4-mini-deep-research',
    'omni-moderation-latest', 'sora-2', 'text-embedding-3-small', 'tts-1', 'whisper-1',
  ];
  const listing = (ids: string[]) => () => Response.json({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) });
  const listed = (ids: string[]) => ids.map((id) => ({ id, label: id }));

  it('is a chat model for an OpenAI key, whose list opens on a completions-only one', async () => {
    const app = h.app();
    h.provider(listing(OPENAI));
    await h.call(app, 'POST', '/api/credentials', { provider: 'openai', apiKey: KEY });
    expect(await h.db.select().from(modelPresets)).toMatchObject([{ format: 'openai-responses', model: 'gpt-5-mini' }]);
  });

  it("follows each provider's preference, then the first model a chat runs on", () => {
    expect(preferredModel('openai', listed(['babbage-002', 'davinci-002', 'gpt-3.5-turbo-instruct', 'gpt-4o-mini', 'gpt-4o']))).toMatchObject({ id: 'gpt-4o-mini' });
    expect(preferredModel('openai', listed(['babbage-002', 'davinci-002', 'tts-1', 'o3']))).toMatchObject({ id: 'o3' });
    // Anthropic lists newest first.
    expect(preferredModel('anthropic', listed(['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929'])))
      .toMatchObject({ id: 'claude-sonnet-4-6' });
    expect(preferredModel('google', listed(['gemini-embedding-001', 'gemini-2.5-flash-preview-tts', 'gemini-2.5-flash-image', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemma-3-27b-it'])))
      .toMatchObject({ id: 'gemini-2.5-flash' });
    expect(preferredModel('openrouter', listed(['01-ai/yi-large', 'anthropic/claude-sonnet-4.5', 'openai/gpt-5-mini']))).toMatchObject({ id: 'openai/gpt-5-mini' });
    expect(preferredModel('deepseek', listed(['deepseek-chat', 'deepseek-reasoner']))).toMatchObject({ id: 'deepseek-chat' });
    // DeepInfra's instruct models are its chat models.
    expect(preferredModel('deepinfra', listed(['BAAI/bge-m3', 'meta-llama/Llama-3.3-70B-Instruct']))).toMatchObject({ id: 'meta-llama/Llama-3.3-70B-Instruct' });
    expect(preferredModel('openai', listed(['whisper-1', 'text-embedding-3-small']))).toBeUndefined();
  });
});
