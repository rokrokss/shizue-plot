/**
 * PocketRisu's model registry in this app: an untrusted catalog checked whole,
 * the refresh's hash gate, which profiles are offered and where their requests
 * go, a key that never leaves its provider's address, PocketRisu's retries,
 * and a preset from before the registry matched to its profile.
 */
import { describe, expect, it } from 'vitest';
import { adapterFor, type ModelCredential } from '../src/formats/index.js';
import { setPath } from '../src/params.js';
import { bundledCatalog, firstProfileOf, offeredSnapshot, profileEntries, registryBaseOf, resolveSnapshot, validateCatalog } from '../src/registry/index.js';
import { legacyProfile } from '../src/registry/legacy.js';
import { fetchRegistry } from '../src/registry/remote.js';
import { migrateValues, parseProfileValues, profileOutputTokens } from '../src/registry/request.js';
import { retryingAdapter } from '../src/retry.js';
import { LLMError, type LLMAdapter, type StreamDelta, type StreamDone } from '../src/types.js';
import { drain, REQUEST } from './helpers.js';

const HASH = 'c'.repeat(64);

describe('the catalog', () => {
  it('leaves out what is not well formed, and refuses an envelope it cannot read', () => {
    const catalog = structuredClone(bundledCatalog()) as unknown as Record<string, any>;
    catalog['profiles']['google:gemini-38-flash'].schema.push({ key: 'evil', type: 'string', label: 'x', mapsTo: { target: 'body', path: 'constructor.prototype.x' } });
    catalog['profiles']['google:gemini-4-argon'].displayName = 7;
    catalog['profiles']['google:orphan'] = { ...catalog['profiles']['google:gemini-31-pro'], id: 'google:orphan', providerBaseId: 'nobody' };
    catalog['baseProviders']['openai'].adapterKind = 'openai-responses';
    const { catalog: checked, dropped } = validateCatalog(catalog);
    expect(dropped).toEqual(expect.arrayContaining(['profile:google:gemini-38-flash', 'profile:google:gemini-4-argon', 'profile:google:orphan', 'base:openai']));
    expect(checked.profiles['google:gemini-31-pro']).toBeDefined();
    // A base gone takes its profiles with it.
    expect(Object.keys(checked.profiles).some((id) => id.startsWith('openai:'))).toBe(false);

    for (const envelope of [null, [], { schemaVersion: 3, baseProviders: {}, profiles: {} }, { schemaVersion: 4, profiles: {} }, { schemaVersion: 4, hash: 'x', baseProviders: {}, profiles: {} }, { schemaVersion: 4, baseProviders: {}, profiles: {} }]) {
      expect(() => validateCatalog(envelope), JSON.stringify(envelope)).toThrow(TypeError);
    }
  });

  it("offers only the bases that are this app's providers, with their own address", () => {
    const entries = profileEntries(bundledCatalog());
    expect(new Set(entries.map((entry) => entry.provider))).toEqual(new Set(['google', 'anthropic', 'openai', 'openrouter', 'deepseek', 'deepinfra', 'nanogpt', 'ollama']));
    const snapshot = resolveSnapshot(bundledCatalog(), 'google:gemini-38-flash')!;
    expect(registryBaseOf(snapshot)).toMatchObject({ provider: 'google', format: 'google' });
    // A profile that names another address, adapter or auth is not one this app sends.
    expect(registryBaseOf({ ...snapshot, endpoint: { kind: 'static', url: 'https://collector.example/v1beta/models' } })).toBeNull();
    expect(registryBaseOf({ ...snapshot, auth: { kind: 'query' } })).toBeNull();
    expect(registryBaseOf({ ...snapshot, adapterKind: 'openai-compatible' })).toBeNull();
    expect(registryBaseOf({ ...snapshot, providerBaseId: 'vercel' })).toBeNull();
  });

  it("starts each provider on its first current profile, never a hidden one", () => {
    const catalog = bundledCatalog();
    expect(firstProfileOf(catalog, 'google')).toMatchObject({ id: 'google:gemini-4-argon', status: 'current' });
    expect(firstProfileOf(catalog, 'anthropic')).toMatchObject({ status: 'current' });
    expect(firstProfileOf(catalog, 'openai')).toMatchObject({ id: 'openai:gpt-61-sol' });
    expect(firstProfileOf(catalog, 'mistral')).toBeUndefined();
    for (const provider of ['google', 'anthropic', 'openai', 'openrouter', 'deepseek', 'deepinfra', 'nanogpt', 'ollama']) {
      expect(firstProfileOf(catalog, provider)?.status, provider).toBe('current');
    }
  });

  it("reads a profile's reply cap from its output field, its default, else its defaults", () => {
    const flash = offeredSnapshot(bundledCatalog(), 'google:gemini-38-flash')!.snapshot;
    expect(profileOutputTokens(flash, {})).toBe(8192);
    expect(profileOutputTokens(flash, { maxOutputTokens: 20000 })).toBe(20000);
    const opus = offeredSnapshot(bundledCatalog(), 'anthropic:opus-55')!.snapshot;
    expect(profileOutputTokens({ schema: opus.schema.filter((field) => field.key !== 'max_tokens'), defaults: { max_tokens: 4096 } }, {})).toBe(4096);
  });

  it("holds values to the schema, and carries them onto another profile where they fit", () => {
    const opus = offeredSnapshot(bundledCatalog(), 'anthropic:opus-55')!.snapshot;
    expect(() => parseProfileValues({ apiKey: 'sk-ant-1' }, opus.schema)).toThrow(/Unknown value/);
    expect(() => parseProfileValues({ max_tokens: 0 }, opus.schema)).toThrow(TypeError);
    expect(parseProfileValues({ effort: 'max', max_tokens: 64000, user_id: null }, opus.schema)).toEqual({ effort: 'max', max_tokens: 64000 });
    const sonnet45 = offeredSnapshot(bundledCatalog(), 'anthropic:sonnet-45')!.snapshot;
    const moved = migrateValues({ effort: 'max', max_tokens: 100000, top_k: 3 }, sonnet45.schema);
    expect(moved.dropped.sort()).toEqual(['effort', 'max_tokens']);
    expect(moved.values).toMatchObject({ top_k: 3, max_tokens: 4096 });
  });

  it('never sets a path through the prototype', () => {
    const body: Record<string, unknown> = {};
    setPath(body, '__proto__.polluted', true);
    setPath(body, 'constructor.prototype.polluted', true);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(body).toEqual({});
  });
});

describe('the refresh', () => {
  const serve = (catalog: unknown, catalogHash = HASH) => {
    const asked: string[] = [];
    const fetcher = (async (input: string | URL | Request) => {
      asked.push(String(input));
      return String(input).endsWith('index.json') ? Response.json({ schemaVersion: 4, hash: HASH }) : Response.json({ ...(catalog as object), hash: catalogHash });
    }) as typeof fetch;
    return { fetcher, asked };
  };

  it("fetches the catalog only when the index names another hash, and checks it", async () => {
    const catalog = structuredClone(bundledCatalog());
    const fresh = serve(catalog);
    const updated = await fetchRegistry('https://registry.example/main', undefined, fresh.fetcher);
    expect(updated).toMatchObject({ status: 'updated', hash: HASH, dropped: [] });
    expect(fresh.asked).toEqual(['https://registry.example/main/index.json', `https://registry.example/main/catalog.json?h=${HASH}`]);
    const same = serve(catalog);
    expect(await fetchRegistry('https://registry.example/main/', HASH, same.fetcher)).toEqual({ status: 'unchanged', hash: HASH });
    expect(same.asked).toHaveLength(1);
    await expect(fetchRegistry('https://registry.example/main/', undefined, serve(catalog, 'd'.repeat(64)).fetcher)).rejects.toThrow(/disagree/);
    await expect(fetchRegistry('https://registry.example/main/', undefined, serve({ schemaVersion: 4, baseProviders: {}, profiles: {} }).fetcher)).rejects.toThrow(/not one this app reads/);
  });

  it('refuses a catalog past its size, whatever the server says of it', async () => {
    const big = 'x'.repeat(17 * 1024 * 1024);
    const fetcher = (async (input: string | URL | Request) =>
      String(input).endsWith('index.json')
        ? Response.json({ schemaVersion: 4, hash: HASH })
        : new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(big)); controller.close(); } }))) as typeof fetch;
    await expect(fetchRegistry('https://registry.example/', undefined, fetcher)).rejects.toThrow(/too large/);
  });
});

describe("a profile preset's address", () => {
  it("goes to its key's own address whatever the profile names, and refuses a key of another provider", async () => {
    const offered = offeredSnapshot(bundledCatalog(), 'google:gemini-38-flash')!;
    // A snapshot kept from a registry that named another address is refused, never sent there.
    const elsewhere = { ...offered.snapshot, endpoint: { kind: 'static' as const, url: 'https://collector.example/v1beta/models' } };
    const sent: string[] = [];
    const fetcher = (async (input: string | URL | Request) => {
      sent.push(String(input));
      throw new DOMException('stop', 'AbortError');
    }) as typeof fetch;
    const key = (provider: string, baseUrl: string | null = null): ModelCredential => ({ kind: 'api_key', provider, baseUrl, apiKey: 'AIzaKey' });
    const preset = (snapshot = offered.snapshot) => ({ format: 'google', endpoint: 'https://attacker.example', model: '', params: {}, capabilities: {}, profile: { snapshot, values: {} } });
    expect(() => adapterFor(preset(elsewhere), key('google'), {}, fetcher)).toThrow(LLMError);
    expect(() => adapterFor(preset(), key('anthropic'), {}, fetcher)).toThrow(/does not speak/);
    expect(() => adapterFor(preset(), undefined, {}, fetcher)).toThrow(/needs a key/);
    await adapterFor(preset(), key('google', 'http://localhost:9999/v1beta'), {}, fetcher).stream(REQUEST).next().catch(() => undefined);
    expect(sent).toEqual(['http://localhost:9999/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse']);
  });
});

describe("PocketRisu's retries", () => {
  const failing = (failures: LLMError[], deltas: StreamDelta[] = [{ type: 'text', text: 'ok' }]): { adapter: LLMAdapter; calls: () => number } => {
    let calls = 0;
    return {
      calls: () => calls,
      adapter: {
        async *stream(): AsyncGenerator<StreamDelta, StreamDone> {
          const failure = failures[calls++];
          if (failure) throw failure;
          for (const delta of deltas) yield delta;
          return { usage: { promptTokens: 1, completionTokens: 1 } };
        },
      },
    };
  };
  const noWait = async () => undefined;

  it('sends a request again twice when it fails before the reply begins', async () => {
    const twice = failing([new LLMError('provider_unavailable', 'x', 503), new LLMError('provider_bad_request', 'y', 400)]);
    expect((await drain(retryingAdapter(twice.adapter, 2, noWait).stream(REQUEST))).text).toBe('ok');
    expect(twice.calls()).toBe(3);
    const thrice = failing([0, 1, 2].map(() => new LLMError('provider_rate_limited', 'z', 429)));
    await expect(drain(retryingAdapter(thrice.adapter, 2, noWait).stream(REQUEST))).rejects.toMatchObject({ code: 'provider_rate_limited' });
    expect(thrice.calls()).toBe(3);
  });

  it("never tries again what cannot change, a stop, or a reply already begun", async () => {
    const config = failing([new LLMError('credential_required', 'x', 400)]);
    await expect(drain(retryingAdapter(config.adapter, 2, noWait).stream(REQUEST))).rejects.toMatchObject({ code: 'credential_required' });
    expect(config.calls()).toBe(1);
    const stopped = new AbortController();
    stopped.abort();
    const aborted = failing([new LLMError('provider_unavailable', 'x', 503)]);
    await expect(drain(retryingAdapter(aborted.adapter, 2, noWait).stream({ ...REQUEST, abortSignal: stopped.signal }))).rejects.toBeInstanceOf(LLMError);
    expect(aborted.calls()).toBe(1);
    let calls = 0;
    const midway: LLMAdapter = {
      async *stream() {
        calls += 1;
        yield { type: 'text', text: '반쯤' };
        throw new LLMError('provider_stream_interrupted', 'cut', 502);
      },
    };
    await expect(drain(retryingAdapter(midway, 2, noWait).stream(REQUEST))).rejects.toMatchObject({ code: 'provider_stream_interrupted' });
    expect(calls).toBe(1);
  });
});

describe('presets from before the registry', () => {
  it("match a profile by the key's provider and the model, a thinking variant where the preset thought", () => {
    const catalog = bundledCatalog();
    expect(legacyProfile(catalog, { provider: 'google', model: 'models/gemini-3.8-flash', params: {} })).toMatchObject({ profileId: 'google:gemini-38-flash', format: 'google' });
    expect(legacyProfile(catalog, { provider: 'deepseek', model: 'deepseek-flash', params: {} })?.profileId).toBe('deepseek:v41-flash');
    expect(legacyProfile(catalog, { provider: 'deepseek', model: 'deepseek-flash', params: { reasoningEffort: 'high' } })?.profileId).toBe('deepseek:v41-flash-thinking');
    // A model only a catch-all would take stays a custom preset.
    expect(legacyProfile(catalog, { provider: 'openrouter', model: 'some-lab/unlisted', params: {} })).toBeNull();
    expect(legacyProfile(catalog, { provider: 'mistral', model: 'mistral-large-latest', params: {} })).toBeNull();
    const argon = legacyProfile(catalog, { provider: 'google', model: 'gemini-4-argon', params: { reasoningEffort: 'minimal', temperature: 1 } })!;
    // Argon takes neither `minimal` nor a temperature.
    expect(argon.dropped.sort()).toEqual(['reasoningEffort', 'temperature']);
  });
});
