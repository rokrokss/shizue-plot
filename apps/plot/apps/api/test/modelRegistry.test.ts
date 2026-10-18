/**
 * Model presets on PocketRisu's registry (ARCHITECTURE §7.1): the profiles
 * this app offers, a preset made from one with its values held to the
 * profile's schema, a turn through it as the profile writes the request, its
 * retries, the registry's refresh with everything fetched checked, and the
 * "update available" and "replace profile" flows. Provider and registry calls
 * are answered by stand-ins.
 */
import { messages, modelPresets } from '@shizue/db';
import { bundledCatalog, GEMINI_SAFETY } from '@shizue/llm';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../src/deps.js';
import { modelsHarness, readJson, readSse, sseBody } from './modelsHarness.js';

const h = modelsHarness();
const KEY = 'AIzaSyTestKeyForTheRegistrySuite000';

async function created(res: Response): Promise<any> {
  expect(res.status, await res.clone().text()).toBe(201);
  return readJson(res);
}

const geminiReply = (text: string) =>
  sseBody([
    { candidates: [{ content: { role: 'model', parts: [{ text: 'thinking it over', thought: true }] } }] },
    { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 4 } },
  ]);

/** A Google key, its first preset (the registry's first current Gemini) put aside, and a 3.8 Flash preset on it. */
async function flashPreset(app: Hono<AppEnv>) {
  const key = await created(await h.call(app, 'POST', '/api/credentials', { provider: 'google', apiKey: KEY }));
  await h.db.delete(modelPresets);
  const preset = await created(await h.call(app, 'POST', '/api/model-presets', { profileId: 'google:gemini-38-flash', credentialId: key.id }));
  return { key, preset };
}

async function chatOn(app: Hono<AppEnv>, main: string): Promise<string> {
  const plot = await created(await h.call(app, 'POST', '/api/plots', { name: '등대', description: '안개 낀 밤.', intros: ['불빛이 깜빡인다.'], style: { replyLength: 'short' } }));
  return (await created(await h.call(app, 'POST', '/api/chats', { plotId: plot.id, modelBinding: { main } }))).chat.id;
}

describe('the model registry', () => {
  it("lists the profiles this app offers, each with whose key it takes, and none of a provider it lacks", async () => {
    const body = await readJson(await h.call(h.app(), 'GET', '/api/model-presets/registry'));
    expect(body).toMatchObject({ origin: 'bundled', hash: null, refreshable: false });
    const byId = Object.fromEntries(body.profiles.map((entry: any) => [entry.id, entry]));
    expect(byId['google:gemini-38-flash']).toMatchObject({ provider: 'google', format: 'google', status: 'current', modelId: 'gemini-3.8-flash', baseLabel: 'Google AI Studio (Gemini)' });
    expect(byId['google:gemini-25-flash']).toMatchObject({ status: 'outdated' });
    expect(byId['anthropic:opus-55']).toMatchObject({ provider: 'anthropic', format: 'anthropic' });
    expect(byId['ollama-cloud:glm-53']).toMatchObject({ provider: 'ollama', format: 'openai-chat' });
    const bases = new Set(body.profiles.map((entry: any) => entry.baseId));
    expect([...bases].sort()).toEqual(['anthropic', 'deepinfra', 'deepseek', 'google', 'nanogpt', 'ollama-cloud', 'openai', 'openrouter']);
  });

  it('makes a preset from a profile with its defaults, held to its key and its schema', async () => {
    const app = h.app();
    const { key, preset } = await flashPreset(app);
    expect(preset).toMatchObject({
      kind: 'profile', name: 'Gemini 3.8 Flash', format: 'google', model: 'gemini-3.8-flash', credentialId: key.id, endpoint: null,
      sourceProfile: { registryId: 'bundled', profileId: 'google:gemini-38-flash' },
      userValues: { modelId: 'gemini-3.8-flash', maxOutputTokens: 8192, includeThoughts: true },
      profileUpdate: 'none',
      profile: { status: 'current', displayName: 'Gemini 3.8 Flash' },
    });
    expect(preset.profileSnapshot.schema.map((field: any) => field.key)).toContain('thinkingLevel');

    const anthropic = await created(await h.call(app, 'POST', '/api/credentials', { provider: 'anthropic', apiKey: 'sk-ant-api03-abcdefghij' }));
    const refused: [Record<string, unknown>, string][] = [
      [{ profileId: 'google:nope' }, 'profile_unavailable'],
      // A gateway this app has no provider for is not offered.
      [{ profileId: 'vercel:gpt-61-sol' }, 'profile_unavailable'],
      [{ profileId: 'google:gemini-38-flash', credentialId: anthropic.id }, 'credential_format_mismatch'],
    ];
    for (const [body, code] of refused) {
      const res = await h.call(app, 'POST', '/api/model-presets', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await readJson(res)).code, JSON.stringify(body)).toBe(code);
    }

    const patched = await readJson(await h.call(app, 'PATCH', `/api/model-presets/${preset.id}`, {
      name: '플래시',
      userValues: { ...preset.userValues, thinkingLevel: 'high', temperature: 1 },
      params: { temperature: 0.3, extraBody: { cachedContent: 'cachedContents/abc' } },
      capabilities: { vision: false },
    }));
    expect(patched).toMatchObject({ name: '플래시', userValues: { thinkingLevel: 'high', temperature: 1, maxOutputTokens: 8192 }, params: { extraBody: { cachedContent: 'cachedContents/abc' } } });
    // A profile preset's sampling values are its fields; only the additional headers and body ride in `params`.
    expect(patched.params).not.toHaveProperty('temperature');
    for (const userValues of [{ temperature: 5 }, { apiKey: KEY }, { maxOutputTokens: 1.5 }, { includeThoughts: 'yes' }, { nope: 1 }]) {
      const res = await h.call(app, 'PATCH', `/api/model-presets/${preset.id}`, { userValues });
      expect(res.status, JSON.stringify(userValues)).toBe(400);
    }
  });

  it("runs a chat's turn on the profile's request — its own cap, RisuAI's safety settings — and answers", async () => {
    const app = h.app();
    const { preset } = await flashPreset(app);
    await h.call(app, 'PATCH', `/api/model-presets/${preset.id}`, { userValues: { ...preset.userValues, thinkingLevel: 'high' } });
    const chatId = await chatOn(app, preset.id);
    h.sent.length = 0;
    h.provider(() => geminiReply('누구세요?'));
    const events = await readSse(await h.call(app, 'POST', `/api/chats/${chatId}/messages`, { content: '거기 누구 있어요?' }));
    expect(events.at(-1)!.event).toBe('done');
    expect(h.sent).toHaveLength(1);
    const sent = h.sent[0]!;
    expect(sent.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse');
    expect(sent.headers['x-goog-api-key']).toBe(KEY);
    // A short plot asks for 600; the profile's 8192 is the wire's, for thinking and the reply together.
    expect(sent.body!['generationConfig']).toEqual({ maxOutputTokens: 8192, thinkingConfig: { thinkingLevel: 'high', includeThoughts: true }, responseLogprobs: false });
    // The new preset started with RisuAI's BLOCK_NONE on every category, where PocketRisu sends none.
    expect(sent.body!['safetySettings']).toEqual(GEMINI_SAFETY);
    const stored = await h.db.select().from(messages).where(eq(messages.chatId, chatId));
    expect(stored.map((message) => message.content)).toContain('누구세요?');
  });

  it('sends a failed request again twice, as PocketRisu does, before the reply begins', async () => {
    const app = h.app();
    const { preset } = await flashPreset(app);
    const chatId = await chatOn(app, preset.id);
    h.sent.length = 0;
    let calls = 0;
    h.provider(() => (++calls === 1 ? Response.json({ error: { message: 'overloaded' } }, { status: 503 }) : geminiReply('다시 왔다.')));
    expect((await readSse(await h.call(app, 'POST', `/api/chats/${chatId}/messages`, { content: '안녕' }))).at(-1)!.event).toBe('done');
    expect(calls).toBe(2);

    // A refusal is sent again too, and after the third the turn fails as the provider said.
    calls = 0;
    h.provider(() => {
      calls += 1;
      return Response.json({ error: { message: 'thinking level minimal is not supported' } }, { status: 400 });
    });
    const failed = await readSse(await h.call(app, 'POST', `/api/chats/${chatId}/messages`, { content: '또 안녕' }));
    expect(failed.at(-1)).toMatchObject({ event: 'error', data: { code: 'provider_bad_request' } });
    expect(calls).toBe(3);
  });

  it("tests a profile preset with the profile's own output cap", async () => {
    const app = h.app();
    const { preset } = await flashPreset(app);
    h.sent.length = 0;
    h.provider(() => geminiReply('OK'));
    expect(await readJson(await h.call(app, 'POST', `/api/model-presets/${preset.id}/test`))).toMatchObject({ ok: true, text: 'OK' });
    expect((h.sent[0]!.body!['generationConfig'] as Record<string, unknown>)['maxOutputTokens']).toBe(8192);
  });
});

/** A stand-in for the registry's address: `index.json` and `catalog.json`, from `catalog`. */
function registry(catalog: Record<string, unknown>, hash = 'a'.repeat(64)) {
  const asked: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    if (url.endsWith('/index.json')) return Response.json({ schemaVersion: 4, hash });
    if (url.includes('/catalog.json?h=')) return Response.json({ ...catalog, hash });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetcher, asked };
}

describe('the registry refresh', () => {
  const env = { NODE_ENV: 'test', MODEL_REGISTRY_URL: 'http://registry.test/main/' };

  it('keeps a checked newer catalog, offers its update, and applies it carrying the values over', async () => {
    const bundled = structuredClone(bundledCatalog());
    const flash = bundled.profiles['google:gemini-38-flash']!;
    // The registry revised 3.8 Flash: a newer stamp, its seed field gone, a new one added.
    bundled.profiles['google:gemini-38-flash'] = {
      ...flash,
      updatedAt: (flash.updatedAt ?? 0) + 1000,
      version: flash.version + 1,
      schema: [...flash.schema.filter((field) => field.key !== 'seed'), { key: 'mediaResolution', type: 'string', label: 'Media Resolution', default: 'MEDIA_RESOLUTION_LOW', mapsTo: { target: 'body', path: 'generationConfig.mediaResolution' } }],
    };
    // A profile that would send the key elsewhere, and one with a path into the prototype, are not taken.
    bundled.profiles['google:gemini-37-flash'] = { ...bundled.profiles['google:gemini-37-flash']!, endpoint: { kind: 'static', url: 'https://collector.example/v1beta/models' } };
    bundled.profiles['google:gemini-36-flash'] = { ...bundled.profiles['google:gemini-36-flash']!, schema: [{ key: 'x', type: 'string', label: 'x', mapsTo: { target: 'body', path: '__proto__.polluted' } }] };
    const stand = registry(bundled as unknown as Record<string, unknown>);
    const app = h.app({ env, registryFetch: stand.fetcher });
    const { preset } = await flashPreset(app);
    await h.call(app, 'PATCH', `/api/model-presets/${preset.id}`, { userValues: { ...preset.userValues, seed: 7, temperature: 0.5 } });

    expect(await readJson(await h.call(app, 'POST', '/api/model-presets/registry/refresh', { force: true }))).toEqual({ ok: true, changed: true, downloaded: true });
    expect(stand.asked).toEqual(['http://registry.test/main/index.json', `http://registry.test/main/catalog.json?h=${'a'.repeat(64)}`]);
    const state = await readJson(await h.call(app, 'GET', '/api/model-presets/registry'));
    expect(state).toMatchObject({ origin: 'remote', source: 'http://registry.test/main/', hash: 'a'.repeat(64), refreshable: true });
    const offered = new Set(state.profiles.map((entry: any) => entry.id));
    expect(offered.has('google:gemini-37-flash')).toBe(false);
    expect(offered.has('google:gemini-36-flash')).toBe(false);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();

    const [listed] = (await readJson(await h.call(app, 'GET', '/api/model-presets'))).filter((entry: any) => entry.id === preset.id);
    expect(listed.profileUpdate).toBe('updatable');
    const updated = await readJson(await h.call(app, 'PATCH', `/api/model-presets/${preset.id}`, { profileId: 'google:gemini-38-flash' }));
    expect(updated).toMatchObject({ profileUpdate: 'none', sourceProfile: { profileUpdatedAt: (flash.updatedAt ?? 0) + 1000, profileVersion: flash.version + 1 } });
    expect(updated.userValues).toMatchObject({ temperature: 0.5, mediaResolution: 'MEDIA_RESOLUTION_LOW' });
    expect(updated.userValues).not.toHaveProperty('seed');
  });

  it('replaces a profile with another, keeping a key of the same provider and dropping one of another', async () => {
    const app = h.app();
    const { key, preset } = await flashPreset(app);
    const argon = await readJson(await h.call(app, 'PATCH', `/api/model-presets/${preset.id}`, { profileId: 'google:gemini-4-argon' }));
    expect(argon).toMatchObject({ model: 'gemini-4-argon', credentialId: key.id, sourceProfile: { profileId: 'google:gemini-4-argon' }, userValues: { maxOutputTokens: 8192 } });
    const claude = await readJson(await h.call(app, 'PATCH', `/api/model-presets/${preset.id}`, { profileId: 'anthropic:opus-55' }));
    expect(claude).toMatchObject({ format: 'anthropic', model: 'claude-opus-5-5', credentialId: null });
    const [row] = await h.db.select().from(modelPresets).where(eq(modelPresets.id, preset.id));
    expect(row!.profileSnapshot?.providerBaseId).toBe('anthropic');
  });

  it('keeps what it had when the registry answers wrong, and is off unless an address is named', async () => {
    const wrongHash = registry(structuredClone(bundledCatalog()) as unknown as Record<string, unknown>);
    const mismatched = (async (input: string | URL | Request) => {
      const response = await wrongHash.fetcher(input);
      if (String(input).includes('catalog.json')) return Response.json({ ...((await response.json()) as Record<string, unknown>), hash: 'b'.repeat(64) });
      return response;
    }) as typeof fetch;
    const app = h.app({ env, registryFetch: mismatched });
    const res = await readJson(await h.call(app, 'POST', '/api/model-presets/registry/refresh', { force: true }));
    expect(res).toMatchObject({ ok: false, changed: false });
    expect(res.error).toMatch(/disagree/);
    expect((await readJson(await h.call(app, 'GET', '/api/model-presets/registry'))).origin).toBe('bundled');

    const broken = registry({ schemaVersion: 3, baseProviders: {}, profiles: {} });
    const refused = await readJson(await h.call(h.app({ env, registryFetch: broken.fetcher }), 'POST', '/api/model-presets/registry/refresh', { force: true }));
    expect(refused).toMatchObject({ ok: false });
    // The tests reach no registry unless they name one.
    expect(await readJson(await h.call(h.app(), 'POST', '/api/model-presets/registry/refresh', { force: true }))).toMatchObject({ ok: false, error: 'registry refresh is off' });
  });
});

