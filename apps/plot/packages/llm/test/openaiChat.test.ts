import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adapterFor, listModels, type ModelCredential, type PresetConfig } from '../src/formats/index.js';
import { IDLE_TIMEOUT_MS } from '../src/stream.js';
import { LLMError } from '../src/types.js';
import { drain, liveFetch, recordingFetch, REQUEST, sse, streamed } from './helpers.js';

const preset = (overrides: Partial<PresetConfig> = {}): PresetConfig => ({
  format: 'openai-chat', endpoint: 'http://localhost:1234/v1', model: 'model-x', params: {}, capabilities: {}, ...overrides,
});
const key = (provider: string, baseUrl: string | null = null): ModelCredential => ({ kind: 'api_key', provider, baseUrl, apiKey: 'sk-test-key' });
const env = { NODE_ENV: 'test' };
/** OpenAI's documented chunk shape. */
const chunk = (delta: Record<string, unknown>, finish: string | null = null) => sse({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] });
const REPLY = chunk({ role: 'assistant', content: '' }) + chunk({ content: '누구' }) + chunk({ content: '세요?' }) + chunk({}, 'stop')
  + sse({ id: 'c1', choices: [], usage: { prompt_tokens: 42, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 32 } } }) + sse('[DONE]');

describe('OpenAI-compatible Chat Completions', () => {
  it('sends the conversation to a keyless local server with no Authorization and only the values the preset set', async () => {
    const { fetcher, sent } = recordingFetch(() => streamed(REPLY));
    const adapter = adapterFor(preset({ params: { temperature: 0.8, minP: 0.05, repetitionPenalty: 1.1 } }), undefined, env, fetcher);
    const { text, done } = await drain(adapter.stream(REQUEST));
    expect(text).toBe('누구세요?');
    expect(done.usage).toEqual({ promptTokens: 42, completionTokens: 3, cachedPromptTokens: 32 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('http://localhost:1234/v1/chat/completions');
    expect(sent[0]!.headers['authorization']).toBeUndefined();
    expect(sent[0]!.body).toEqual({
      model: 'model-x',
      messages: [
        { role: 'system', content: 'You are the narrator.' },
        { role: 'system', content: '[Start a new chat]' },
        { role: 'assistant', content: 'The door creaks open.' },
        { role: 'user', content: [{ type: 'text', text: 'Who is there?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGk=' } }] },
        { role: 'system', content: 'Reply in two paragraphs.' },
      ],
      stream: true,
      max_tokens: 1200,
      stop: ['\nUser:'],
      temperature: 0.8,
      min_p: 0.05,
      repetition_penalty: 1.1,
    });
  });

  it("sends OpenAI's own API the bearer key, max_completion_tokens and the usage option, to the key's address whatever the preset names", async () => {
    const { fetcher, sent } = recordingFetch(() => streamed(REPLY));
    const adapter = adapterFor(preset({ endpoint: 'https://attacker.example/v1', params: { reasoningEffort: 'high', verbosity: 'low' } }), key('openai'), env, fetcher);
    await drain(adapter.stream(REQUEST));
    expect(sent[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(sent[0]!.headers['authorization']).toBe('Bearer sk-test-key');
    expect(sent[0]!.body).toMatchObject({ max_completion_tokens: 1200, stream_options: { include_usage: true }, reasoning_effort: 'high', verbosity: 'low' });
    expect(sent[0]!.body).not.toHaveProperty('max_tokens');
  });

  it("carries OpenRouter's attribution headers, and the preset's extra headers and body without replacing the key", async () => {
    const { fetcher, sent } = recordingFetch(() => streamed(REPLY));
    const adapter = adapterFor(
      preset({ params: { extraHeaders: { Authorization: 'Bearer stolen', 'X-Custom': '1' }, extraBody: { 'provider.order': ['DeepInfra'], transforms: [] } } }),
      key('openrouter'), env, fetcher,
    );
    await drain(adapter.stream(REQUEST));
    expect(sent[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(sent[0]!.headers).toMatchObject({ 'http-referer': 'https://shizue.net', 'x-title': 'shizue', 'x-custom': '1', authorization: 'Bearer sk-test-key' });
    expect(sent[0]!.body).toMatchObject({ provider: { order: ['DeepInfra'] }, transforms: [] });
  });

  it("goes to a custom key's own address", async () => {
    const { fetcher, sent } = recordingFetch(() => streamed(REPLY));
    await drain(adapterFor(preset(), key('custom', 'https://proxy.example/v1/'), env, fetcher).stream(REQUEST));
    expect(sent[0]!.url).toBe('https://proxy.example/v1/chat/completions');
  });

  it('keeps reasoning_content and reasoning out of the reply and gives them apart', async () => {
    const { fetcher } = recordingFetch(() => streamed(
      chunk({ reasoning_content: '생각 ' }) + chunk({ reasoning: '더' }) + chunk({ content: '답' }, 'stop') + sse('[DONE]'),
    ));
    const { text, reasoning } = await drain(adapterFor(preset(), undefined, env, fetcher).stream(REQUEST));
    expect(text).toBe('답');
    expect(reasoning).toBe('생각 더');
  });

  it('stops at a stop string the server did not, and sends OpenAI at most four', async () => {
    const { fetcher, sent } = recordingFetch(() => streamed(chunk({ content: 'Hi.\nUs' }) + chunk({ content: 'er: more' }) + chunk({}, 'stop') + sse('[DONE]')));
    const { text } = await drain(adapterFor(preset(), undefined, env, fetcher).stream({ ...REQUEST, stop: ['\nUser:', 'a', 'b', 'c', 'd', ' '] }));
    expect(text).toBe('Hi.');
    expect(sent[0]!.body!['stop']).toEqual(['\nUser:', 'a', 'b', 'c']);
  });

  it('takes a body that ends after its finish reason without [DONE], and not one that just ends', async () => {
    const ended = recordingFetch(() => streamed(chunk({ content: '끝' }, 'stop')));
    expect((await drain(adapterFor(preset(), undefined, env, ended.fetcher).stream(REQUEST))).text).toBe('끝');
    const cut = recordingFetch(() => streamed(chunk({ content: '중간' })));
    await expect(drain(adapterFor(preset(), undefined, env, cut.fetcher).stream(REQUEST))).rejects.toMatchObject({ code: 'provider_stream_interrupted' });
  });

  it.each([
    [401, 'provider_unauthorized'],
    [403, 'provider_unauthorized'],
    [402, 'provider_quota'],
    [429, 'provider_rate_limited'],
    [400, 'provider_bad_request'],
    [404, 'provider_not_found'],
    [500, 'provider_unavailable'],
    [503, 'provider_unavailable'],
  ])('tells a %i as %s, with the provider words in the log detail and the key out of them', async (status, code) => {
    const { fetcher } = recordingFetch(() => Response.json({ error: { message: 'Incorrect API key provided: sk-proj-abcdefghijklmnop1234', type: 'invalid_request_error' } }, { status }));
    const error = await drain(adapterFor(preset(), key('openai'), env, fetcher).stream(REQUEST)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LLMError);
    expect(error).toMatchObject({ code, status });
    expect((error as LLMError).detail).toContain('Incorrect API key provided');
    expect((error as LLMError).detail).not.toContain('sk-proj');
  });

  it('tells an error in the middle of the stream, and a server nobody answers at', async () => {
    const midway = recordingFetch(() => streamed(chunk({ content: '부분' }) + sse({ error: { code: 502, message: 'upstream died' } })));
    await expect(drain(adapterFor(preset(), undefined, env, midway.fetcher).stream(REQUEST))).rejects.toMatchObject({ code: 'provider_unavailable', detail: 'upstream died' });
    const refused: typeof fetch = async () => { throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:1234') }); };
    await expect(drain(adapterFor(preset(), undefined, env, refused).stream(REQUEST))).rejects.toMatchObject({ code: 'provider_unreachable' });
  });

  it('lists the models behind an address, and what OpenRouter says reads pictures', async () => {
    const { fetcher, sent } = recordingFetch(() => Response.json({ data: [
      { id: 'b-model', name: 'B', architecture: { input_modalities: ['text', 'image'] } },
      { id: 'a-model' },
      { id: 'text-embedding-3-small' },
    ] }));
    expect(await listModels('openai-chat', null, key('openrouter'), env, fetcher)).toEqual([
      { id: 'a-model', label: 'a-model' },
      { id: 'b-model', label: 'B', vision: true },
    ]);
    expect(sent[0]).toMatchObject({ url: 'https://openrouter.ai/api/v1/models', headers: { authorization: 'Bearer sk-test-key' } });
  });
});

describe('Chat Completions abort and idle timeout', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("passes the caller's abort through as an abort", async () => {
    const live = liveFetch();
    const caller = new AbortController();
    const next = adapterFor(preset(), undefined, env, live.fetcher).stream({ ...REQUEST, abortSignal: caller.signal }).next();
    await vi.advanceTimersByTimeAsync(0);
    caller.abort();
    const error = await next.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(LLMError);
  });

  it('gives up on a stream that goes quiet, as a timeout of its own', async () => {
    const live = liveFetch();
    // No stop strings, so the first piece is not held back as a stop's possible start.
    const stream = adapterFor(preset(), undefined, env, live.fetcher).stream({ ...REQUEST, stop: [] });
    live.send(chunk({ content: '부분' }));
    expect((await stream.next()).value).toEqual({ type: 'text', text: '부분' });
    const rest = stream.next();
    rest.catch(() => {});
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);
    await expect(rest).rejects.toMatchObject({ code: 'provider_timeout', status: 504 });
  });
});
