import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { anthropicTurns, messagesBody } from '../src/formats/anthropic.js';
import { adapterFor, listModels, type ModelCredential, type PresetConfig } from '../src/formats/index.js';
import { IDLE_TIMEOUT_MS } from '../src/stream.js';
import { LLMError } from '../src/types.js';
import { drain, liveFetch, recordingFetch, REQUEST as BASE, sse, streamed, thrown } from './helpers.js';

const REQUEST = { ...BASE, model: 'claude-sonnet-4-5' };

const preset = (overrides: Partial<PresetConfig> = {}): PresetConfig => ({
  format: 'anthropic', endpoint: null, model: 'claude-sonnet-4-5', params: {}, capabilities: {}, ...overrides,
});
const key: ModelCredential = { kind: 'api_key', provider: 'anthropic', baseUrl: null, apiKey: 'sk-ant-test' };
const env = { NODE_ENV: 'test' };

/** The stream Anthropic's Messages docs show, with a thinking block ahead of the text. */
const REPLY = [
  sse({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 25, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens: 1 } } }, 'message_start'),
  sse({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }, 'content_block_start'),
  sse({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '문을 연 사람은' } }, 'content_block_delta'),
  sse({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'EqQB' } }, 'content_block_delta'),
  sse({ type: 'content_block_stop', index: 0 }, 'content_block_stop'),
  sse({ type: 'ping' }, 'ping'),
  sse({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }, 'content_block_start'),
  sse({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '저예요, ' } }, 'content_block_delta'),
  sse({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '리안.' } }, 'content_block_delta'),
  sse({ type: 'content_block_stop', index: 1 }, 'content_block_stop'),
  sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 15 } }, 'message_delta'),
  sse({ type: 'message_stop' }, 'message_stop'),
].join('');

describe('Anthropic Messages', () => {
  it('sends the system text at the top level, a later system turn as the user’s, and the key and version headers', async () => {
    const { fetcher, sent } = recordingFetch(() => streamed(REPLY));
    const { text, reasoning, done } = await drain(adapterFor(preset({ params: { temperature: 0.9, topK: 40 } }), key, env, fetcher).stream(REQUEST));
    expect(text).toBe('저예요, 리안.');
    expect(reasoning).toBe('문을 연 사람은');
    expect(done.usage).toEqual({ promptTokens: 125, completionTokens: 15, cachedPromptTokens: 100 });
    expect(sent[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(sent[0]!.headers).toMatchObject({ 'x-api-key': 'sk-ant-test', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' });
    expect(sent[0]!.headers['authorization']).toBeUndefined();
    expect(sent[0]!.body).toEqual({
      model: 'claude-sonnet-4-5',
      max_tokens: 1200,
      stream: true,
      system: 'You are the narrator.\n\n[Start a new chat]',
      stop_sequences: ['\nUser:'],
      temperature: 0.9,
      top_k: 40,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Start' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'The door creaks open.' }] },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Who is there?' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } },
            { type: 'text', text: 'System: Reply in two paragraphs.' },
          ],
        },
      ],
    });
  });

  it('joins turns of one role, drops empty texts, and trims the partial a continue ends on', () => {
    expect(anthropicTurns({
      system: '',
      messages: [
        { role: 'user', content: 'a' }, { role: 'user', content: '' }, { role: 'user', content: 'b' },
        { role: 'assistant', content: [{ type: 'image', url: 'https://example.com/x.png' }] }, { role: 'assistant', content: 'partial  \n' },
      ],
    })).toEqual({
      system: '',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'a\n\nb' }] },
        { role: 'assistant', content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/x.png' } }, { type: 'text', text: 'partial' }] },
      ],
    });
  });

  it('turns thinking on with a budget on top of the reply, or adaptive with an effort, and sends no sampling beside it', () => {
    const budget = messagesBody({ ...REQUEST, thinkingTokens: 4096, temperature: 1, topK: 5, topP: 0.9, reasoningEffort: 'high' });
    expect(budget).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 4096 }, max_tokens: 1200 + 4096 });
    expect(budget).not.toHaveProperty('temperature');
    expect(budget).not.toHaveProperty('top_k');
    expect(budget).not.toHaveProperty('output_config');
    expect(messagesBody({ ...REQUEST, reasoningEffort: 'minimal' })).toMatchObject({ thinking: { type: 'adaptive' }, output_config: { effort: 'low' } });
    for (const body of [messagesBody({ ...REQUEST, reasoningEffort: 'none', temperature: 0.5 }), messagesBody({ ...REQUEST, thinkingTokens: 0, temperature: 0.5 })]) {
      expect(body).not.toHaveProperty('thinking');
      expect(body).not.toHaveProperty('output_config');
      expect(body).toMatchObject({ temperature: 0.5 });
    }
  });

  it('tells an error event as its type, after text or not', async () => {
    const { fetcher } = recordingFetch(() => streamed(
      sse({ type: 'message_start', message: { usage: { input_tokens: 1 } } }) +
      sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: '부분' } }) +
      sse({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 'error'),
    ));
    await expect(drain(adapterFor(preset(), key, env, fetcher).stream(REQUEST))).rejects.toMatchObject({ code: 'provider_unavailable', detail: 'Overloaded' });
  });

  it.each([[401, 'provider_unauthorized'], [429, 'provider_rate_limited'], [529, 'provider_unavailable'], [400, 'provider_bad_request']])('tells HTTP %i as %s', async (status, code) => {
    const { fetcher } = recordingFetch(() => Response.json({ type: 'error', error: { type: 'x', message: 'no' } }, { status }));
    await expect(drain(adapterFor(preset(), key, env, fetcher).stream(REQUEST))).rejects.toMatchObject({ code, status });
  });

  it('needs a key, and a stream cut before message_stop is not a reply', async () => {
    expect(thrown(() => adapterFor(preset(), undefined, env))).toMatchObject({ code: 'credential_required' });
    const { fetcher } = recordingFetch(() => streamed(sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: '부분' } })));
    await expect(drain(adapterFor(preset(), key, env, fetcher).stream(REQUEST))).rejects.toMatchObject({ code: 'provider_stream_interrupted' });
  });

  it('lists the models, which all read pictures', async () => {
    const { fetcher, sent } = recordingFetch(() => Response.json({ data: [{ id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5', type: 'model' }], has_more: false }));
    expect(await listModels('anthropic', null, key, env, fetcher)).toEqual([{ id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', vision: true }]);
    expect(sent[0]).toMatchObject({ url: 'https://api.anthropic.com/v1/models?limit=1000', headers: { 'x-api-key': 'sk-ant-test', 'anthropic-version': '2023-06-01' } });
  });
});

describe('Anthropic abort and idle timeout', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("passes the caller's abort through, and times a quiet stream out", async () => {
    const live = liveFetch();
    const caller = new AbortController();
    const next = adapterFor(preset(), key, env, live.fetcher).stream({ ...REQUEST, abortSignal: caller.signal }).next();
    await vi.advanceTimersByTimeAsync(0);
    caller.abort();
    expect(await next.catch((caught: unknown) => caught)).not.toBeInstanceOf(LLMError);

    const quiet = liveFetch();
    const stream = adapterFor(preset(), key, env, quiet.fetcher).stream(REQUEST).next();
    stream.catch(() => {});
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);
    await expect(stream).rejects.toMatchObject({ code: 'provider_timeout' });
  });
});
