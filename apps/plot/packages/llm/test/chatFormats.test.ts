/**
 * The chat formats RisuAI speaks beside the four families — Mistral's own,
 * Cohere's v1 chat, Ollama's native API — and NanoGPT's endpoints over the
 * families: the body and headers each sends for the same request, its stream
 * read from the provider's documented shape, and its model list.
 */
import { describe, expect, it } from 'vitest';
import { mistralTurns } from '../src/formats/mistral.js';
import { adapterFor, listModels, type ModelCredential, type PresetConfig } from '../src/formats/index.js';
import { drain, recordingFetch, REQUEST as BASE, sse, streamed } from './helpers.js';

const env = { NODE_ENV: 'test' };
const key = (provider: string, baseUrl: string | null = null): ModelCredential => ({ kind: 'api_key', provider, baseUrl, apiKey: 'sk-test-key' });
const preset = (format: string, model: string, overrides: Partial<PresetConfig> = {}): PresetConfig => ({
  format, endpoint: null, model, params: {}, capabilities: {}, ...overrides,
});
const ask = (model: string, extra: Partial<typeof BASE> = {}) => ({ ...BASE, model, ...extra });
/** Chat Completions' chunk, which Mistral's and NanoGPT's streams share. */
const chunk = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) =>
  sse({ id: 'c', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
/** One JSON object a line, as Ollama and Cohere stream. */
const lines = (...objects: unknown[]) => streamed(objects.map((object) => `${JSON.stringify(object)}\n`).join(''), { headers: { 'content-type': 'application/x-ndjson' } });

describe('Mistral', () => {
  it("sends RisuAI's Mistral turns and safe_prompt off to /chat/completions, and reads its stream with the thinking apart", async () => {
    const { fetcher, sent } = recordingFetch(() => streamed(
      chunk({ role: 'assistant', content: '' })
      + chunk({ content: [{ type: 'thinking', thinking: [{ type: 'text', text: '누가 왔지' }] }] })
      + chunk({ content: '누구' }) + chunk({ content: '세요?' }, 'stop', { usage: { prompt_tokens: 30, completion_tokens: 4, total_tokens: 34 } })
      + sse('[DONE]'),
    ));
    const adapter = adapterFor(preset('mistral', 'mistral-small-latest', { params: { temperature: 0.7, topK: 50, presencePenalty: 0.2 } }), key('mistral'), env, fetcher);
    const { text, reasoning, done } = await drain(adapter.stream(ask('mistral-small-latest')));
    expect(text).toBe('누구세요?');
    expect(reasoning).toBe('누가 왔지');
    expect(done.usage).toEqual({ promptTokens: 30, completionTokens: 4 });
    expect(sent[0]).toMatchObject({ url: 'https://api.mistral.ai/v1/chat/completions', headers: { authorization: 'Bearer sk-test-key' } });
    expect(sent[0]!.body).toEqual({
      model: 'mistral-small-latest',
      // RisuAI's flags (one system prompt, the user first, roles alternating), then its Mistral rules.
      messages: [
        { role: 'system', content: 'You are the narrator.\n\n[Start a new chat]' },
        { role: 'user', content: ' ' },
        { role: 'assistant', content: 'The door creaks open.' },
        { role: 'user', content: 'Who is there?\nsystem: Reply in two paragraphs.' },
      ],
      safe_prompt: false,
      max_tokens: 1200,
      stream: true,
      stop: ['\nUser:'],
      temperature: 0.7,
      presence_penalty: 0.2,
    });
  });

  it("follows RisuAI's own rules for a turn order the flags left alone", () => {
    expect(mistralTurns([
      { role: 'assistant', content: 'hi' }, { role: 'assistant', content: 'again' },
      { role: 'system', content: 'note' }, { role: 'user', content: 'yo' }, { role: 'system', content: 'more' },
    ])).toEqual([
      { role: 'system', content: 'assistant:hi' },
      { role: 'assistant', content: 'again' },
      { role: 'user', content: 'System:note\nyo\nSystem:more' },
    ]);
  });

  it("lists Mistral's chat models and which read pictures", async () => {
    const { fetcher } = recordingFetch(() => Response.json({ object: 'list', data: [
      { id: 'pixtral-large-latest', capabilities: { completion_chat: true, vision: true } },
      { id: 'mistral-ocr-latest', capabilities: { completion_chat: false, vision: true } },
      { id: 'mistral-embed', capabilities: { completion_chat: false } },
      { id: 'mistral-small-latest', capabilities: { completion_chat: true, vision: false } },
    ] }));
    expect(await listModels('mistral', null, key('mistral'), env, fetcher)).toEqual([
      { id: 'mistral-small-latest', label: 'mistral-small-latest', vision: false },
      { id: 'pixtral-large-latest', label: 'pixtral-large-latest', vision: true },
    ]);
  });
});

describe('Cohere', () => {
  const STREAM = [
    { is_finished: false, event_type: 'stream-start', generation_id: 'g1' },
    { is_finished: false, event_type: 'text-generation', text: '누구' },
    { is_finished: false, event_type: 'text-generation', text: '세요?' },
    {
      is_finished: true, event_type: 'stream-end', finish_reason: 'COMPLETE',
      response: { response_id: 'r1', text: '누구세요?', generation_id: 'g1', finish_reason: 'COMPLETE', meta: { api_version: { version: '1' }, billed_units: { input_tokens: 31, output_tokens: 4 } } },
    },
  ];

  it("sends RisuAI's v1 chat body — the last user turn as message, the first system as preamble — and reads its line stream", async () => {
    const { fetcher, sent } = recordingFetch(() => lines(...STREAM));
    const adapter = adapterFor(preset('cohere', 'command-r-plus-08-2024', { params: { temperature: 0.3, topK: 40, topP: 0.9 } }), key('cohere'), env, fetcher);
    const { text, done } = await drain(adapter.stream(ask('command-r-plus-08-2024')));
    expect(text).toBe('누구세요?');
    expect(done.usage).toEqual({ promptTokens: 31, completionTokens: 4 });
    expect(sent[0]).toMatchObject({ url: 'https://api.cohere.com/v1/chat', headers: { authorization: 'Bearer sk-test-key' } });
    expect(sent[0]!.body).toEqual({
      model: 'command-r-plus-08-2024',
      message: 'Who is there?\nsystem: Reply in two paragraphs.',
      chat_history: [{ role: 'USER', message: ' ' }, { role: 'CHATBOT', message: 'The door creaks open.' }],
      preamble: 'You are the narrator.\n\n[Start a new chat]',
      max_tokens: 1200,
      stop_sequences: ['\nUser:'],
      safety_mode: 'NONE',
      stream: true,
      temperature: 0.3,
      k: 40,
      p: 0.9,
    });
  });

  it("puts what follows the last user turn after it, as RisuAI does, and leaves 2024's first models on their own safety mode", async () => {
    const { fetcher, sent } = recordingFetch(() => lines(...STREAM));
    await drain(adapterFor(preset('cohere', 'command-r-03-2024'), key('cohere'), env, fetcher).stream(ask('command-r-03-2024', {
      system: '', messages: [{ role: 'user', content: 'Go on.' }, { role: 'assistant', content: 'She' }],
    })));
    expect(sent[0]!.body).toMatchObject({ message: '\nGo on.assistant: \nShe', chat_history: [] });
    expect(sent[0]!.body).not.toHaveProperty('safety_mode');
    expect(sent[0]!.body).not.toHaveProperty('preamble');
  });

  it('tells a failed finish, and a stream with no end, and lists the chat models', async () => {
    const toxic = recordingFetch(() => lines(STREAM[1], { ...STREAM[3], finish_reason: 'ERROR_TOXIC' }));
    await expect(drain(adapterFor(preset('cohere', 'command-a'), key('cohere'), env, toxic.fetcher).stream(ask('command-a')))).rejects.toMatchObject({ code: 'provider_refused' });
    const cut = recordingFetch(() => lines(STREAM[0], STREAM[1]));
    await expect(drain(adapterFor(preset('cohere', 'command-a'), key('cohere'), env, cut.fetcher).stream(ask('command-a')))).rejects.toMatchObject({ code: 'provider_stream_interrupted' });
    const listing = recordingFetch(() => Response.json({ models: [{ name: 'command-a-03-2025', endpoints: ['chat', 'generate'] }, { name: 'command-r7b-12-2024', endpoints: ['chat'] }] }));
    expect(await listModels('cohere', null, key('cohere'), env, listing.fetcher)).toEqual([
      { id: 'command-a-03-2025', label: 'command-a-03-2025' },
      { id: 'command-r7b-12-2024', label: 'command-r7b-12-2024' },
    ]);
    expect(listing.sent[0]!.url).toBe('https://api.cohere.com/v1/models?endpoint=chat&page_size=1000');
  });
});

describe('Ollama (native)', () => {
  const at = '2026-10-18T00:00:00Z';

  it('streams /api/chat with the options it reads, a picture as images, and the thinking apart', async () => {
    const { fetcher, sent } = recordingFetch(() => lines(
      { model: 'qwen3:8b', created_at: at, message: { role: 'assistant', content: '', thinking: '문 소리' }, done: false },
      { model: 'qwen3:8b', created_at: at, message: { role: 'assistant', content: '누구' }, done: false },
      { model: 'qwen3:8b', created_at: at, message: { role: 'assistant', content: '세요?' }, done: false },
      { model: 'qwen3:8b', created_at: at, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 26, eval_count: 3 },
    ));
    const adapter = adapterFor(preset('ollama', 'qwen3:8b', { endpoint: 'http://localhost:11434/v1', params: { temperature: 0.6, repetitionPenalty: 1.05, reasoningEffort: 'none' } }), undefined, env, fetcher);
    const { text, reasoning, done } = await drain(adapter.stream(ask('qwen3:8b', { contextTokens: 16384 })));
    expect(text).toBe('누구세요?');
    expect(reasoning).toBe('문 소리');
    expect(done.usage).toEqual({ promptTokens: 26, completionTokens: 3 });
    expect(sent[0]!.url).toBe('http://localhost:11434/api/chat');
    expect(sent[0]!.headers['authorization']).toBeUndefined();
    expect(sent[0]!.body).toEqual({
      model: 'qwen3:8b',
      messages: [
        { role: 'system', content: 'You are the narrator.' },
        { role: 'system', content: '[Start a new chat]' },
        { role: 'assistant', content: 'The door creaks open.' },
        { role: 'user', content: 'Who is there?', images: ['aGk='] },
        { role: 'system', content: 'Reply in two paragraphs.' },
      ],
      stream: true,
      options: { num_predict: 1200, num_ctx: 16384, stop: ['\nUser:'], temperature: 0.6, repeat_penalty: 1.05 },
      think: false,
    });
  });

  it("takes an effort as Ollama's think level, sends Ollama Cloud its key, and tells an error line", async () => {
    const { fetcher, sent } = recordingFetch(() => lines({ error: 'model requires more system memory' }));
    await expect(drain(adapterFor(preset('ollama', 'gpt-oss:120b', { params: { reasoningEffort: 'xhigh' } }), key('ollama'), env, fetcher).stream(ask('gpt-oss:120b'))))
      .rejects.toMatchObject({ code: 'provider_unavailable', detail: 'model requires more system memory' });
    expect(sent[0]).toMatchObject({ url: 'https://ollama.com/api/chat', headers: { authorization: 'Bearer sk-test-key' }, body: { think: 'high' } });
    expect(sent[0]!.body!['options']).not.toHaveProperty('num_ctx');
  });

  it('lists the pulled models but those that only embed', async () => {
    const { fetcher, sent } = recordingFetch(() => Response.json({ models: [
      { name: 'bge-m3:latest', model: 'bge-m3:latest', capabilities: ['embedding'] },
      { name: 'gemma3:12b', model: 'gemma3:12b', capabilities: ['completion', 'vision'] },
      { name: 'old:7b', model: 'old:7b' },
    ] }));
    expect(await listModels('ollama', null, undefined, env, fetcher)).toEqual([
      { id: 'gemma3:12b', label: 'gemma3:12b', vision: true },
      { id: 'old:7b', label: 'old:7b' },
    ]);
    expect(sent[0]!.url).toBe('http://localhost:11434/api/tags');
  });
});

describe("NanoGPT's endpoints over the families", () => {
  it('sends Chat Completions, Responses, Messages and legacy completions to nano-gpt.com with its key', async () => {
    const { fetcher, sent } = recordingFetch((request) => {
      if (request.url.endsWith('/chat/completions')) return streamed(chunk({ content: '네' }, 'stop') + sse('[DONE]'));
      if (request.url.endsWith('/responses')) {
        return streamed(sse({ type: 'response.output_text.delta', delta: '네' }) + sse({ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } }));
      }
      return streamed(sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: '네' } }) + sse({ type: 'message_stop' }));
    });
    const nano = key('nanogpt');
    for (const format of ['openai-chat', 'openai-responses', 'anthropic']) {
      expect((await drain(adapterFor(preset(format, 'gpt-5.4-mini'), nano, env, fetcher).stream(ask('gpt-5.4-mini')))).text, format).toBe('네');
    }
    expect(sent.map((request) => request.url)).toEqual([
      'https://nano-gpt.com/api/v1/chat/completions',
      'https://nano-gpt.com/api/v1/responses',
      'https://nano-gpt.com/api/v1/messages',
    ]);
    expect(sent[0]!.headers['authorization']).toBe('Bearer sk-test-key');
    // RisuAI's `OAICompletionTokens` for NanoGPT.
    expect(sent[0]!.body).toMatchObject({ max_completion_tokens: 1200 });
    expect(sent[1]!.headers['authorization']).toBe('Bearer sk-test-key');
    expect(sent[2]!.headers['x-api-key']).toBe('sk-test-key');
  });

  it("goes to the subscription's own address where the key was entered with it, and lists its models", async () => {
    const { fetcher, sent } = recordingFetch((request) => request.url.endsWith('/models')
      ? Response.json({ object: 'list', data: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', capabilities: { vision: false } }] })
      : streamed(chunk({ content: '네' }, 'stop') + sse('[DONE]')));
    const subscription = key('nanogpt', 'https://nano-gpt.com/api/subscription/v1');
    await drain(adapterFor(preset('openai-chat', 'deepseek-v4-pro'), subscription, env, fetcher).stream(ask('deepseek-v4-pro')));
    expect(sent[0]!.url).toBe('https://nano-gpt.com/api/subscription/v1/chat/completions');
    expect(await listModels('openai-chat', null, subscription, env, fetcher)).toEqual([{ id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', vision: false }]);
  });
});
