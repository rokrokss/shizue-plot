import { describe, expect, it } from 'vitest';
import { adapterFor, listModels, type ModelCredential, type PresetConfig } from '../src/formats/index.js';
import type { ChatGPTAccount } from '../src/chatgptAuth.js';
import { drain, recordingFetch, REQUEST as BASE, sse, streamed } from './helpers.js';

const REQUEST = { ...BASE, model: 'gpt-5.4' };

const preset = (overrides: Partial<PresetConfig> = {}): PresetConfig => ({
  format: 'openai-responses', endpoint: null, model: 'gpt-5.4', params: {}, capabilities: {}, ...overrides,
});
const key: ModelCredential = { kind: 'api_key', provider: 'openai', baseUrl: null, apiKey: 'sk-test-key' };
const env = { NODE_ENV: 'test' };
const REPLY = sse({ type: 'response.output_text.delta', delta: '안녕' }) + sse({ type: 'response.completed', response: { usage: { input_tokens: 9, output_tokens: 2 } } });

describe('OpenAI Responses with a key', () => {
  it("sends the plan's body with the sampling values, max_output_tokens and the verbosity, and the key", async () => {
    const { fetcher, sent } = recordingFetch(() => streamed(REPLY));
    const adapter = adapterFor(preset({ params: { temperature: 0.7, topP: 0.9, topK: 40, reasoningEffort: 'low', verbosity: 'high', maxTokens: 3000 } }), key, env, fetcher);
    const { text, done } = await drain(adapter.stream({ ...REQUEST, cacheKey: 'chat-1' }));
    expect(text).toBe('안녕');
    expect(done.usage).toEqual({ promptTokens: 9, completionTokens: 2 });
    expect(sent[0]!.url).toBe('https://api.openai.com/v1/responses');
    expect(sent[0]!.headers['authorization']).toBe('Bearer sk-test-key');
    // A key's request has no ChatGPT session header.
    expect(sent[0]!.headers['session_id']).toBeUndefined();
    expect(sent[0]!.body).toMatchObject({
      model: 'gpt-5.4', store: false, stream: true, instructions: 'You are the narrator.', prompt_cache_key: 'chat-1',
      max_output_tokens: 3000, temperature: 0.7, top_p: 0.9, reasoning: { effort: 'low' }, text: { verbosity: 'high' },
    });
    // Top-k is not a value this format takes.
    expect(sent[0]!.body).not.toHaveProperty('top_k');
    expect((sent[0]!.body!['input'] as { role: string }[]).map((item) => item.role)).toEqual(['developer', 'assistant', 'user', 'developer']);
  });

  it('ends a reply cut at its cap there, as a reply', async () => {
    const { fetcher } = recordingFetch(() => streamed(sse({ type: 'response.output_text.delta', delta: '잘린' }) + sse({ type: 'response.incomplete', response: { usage: { input_tokens: 1, output_tokens: 1 } } })));
    expect((await drain(adapterFor(preset(), key, env, fetcher).stream(REQUEST))).text).toBe('잘린');
  });

  it('tells a refused key by its status', async () => {
    const { fetcher } = recordingFetch(() => Response.json({ error: { message: 'Incorrect API key', code: 'invalid_api_key' } }, { status: 401 }));
    await expect(drain(adapterFor(preset(), key, env, fetcher).stream(REQUEST))).rejects.toMatchObject({ code: 'provider_unauthorized', status: 401 });
  });
});

describe('OpenAI Responses on the ChatGPT connection', () => {
  const account = (token: string): ChatGPTAccount => ({
    accessToken: async () => token,
    models: async () => [{ id: 'gpt-5.4', label: 'GPT-5.4', vision: true, reasoningEfforts: ['low', 'high'] }],
  });

  it('keeps the plan to its rules: the effort and the cache header, no sampling and no cap', async () => {
    const { fetcher, sent } = recordingFetch(() => streamed(REPLY));
    const adapter = adapterFor(preset({ params: { temperature: 0.7, reasoningEffort: 'high', maxTokens: 3000, stop: ['END'] } }), { kind: 'chatgpt', account: account('TOKEN') }, env, fetcher);
    await drain(adapter.stream({ ...REQUEST, cacheKey: 'chat-1' }));
    expect(sent[0]!.url).toBe('https://api.openai.com/v1/responses');
    expect(sent[0]!.headers).toMatchObject({ authorization: 'Bearer TOKEN', session_id: 'chat-1' });
    expect(sent[0]!.body).toMatchObject({ reasoning: { effort: 'high' }, prompt_cache_key: 'chat-1' });
    for (const field of ['temperature', 'max_output_tokens', 'top_p', 'stop']) expect(sent[0]!.body).not.toHaveProperty(field);
  });

  it("lists the account's own catalog", async () => {
    expect(await listModels('openai-responses', null, { kind: 'chatgpt', account: account('TOKEN') }, env)).toEqual([
      { id: 'gpt-5.4', label: 'GPT-5.4', vision: true, reasoningEfforts: ['low', 'high'] },
    ]);
  });
});
