/**
 * The formats that send the chat as one text (RisuAI's OpenAILegacyInstruct,
 * AnthropicLegacy, Ooba, OobaLegacy, Kobold, Horde, NovelAI and NovelList): the
 * body and headers each sends for the same request, its reply read from the
 * provider's documented shape, and its model list. Errors, abort and the idle
 * watch are `contract.test.ts`'s.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEGACY_STOPS } from '../src/formats/openaiLegacy.js';
import { adapterFor, listModels, validateCredential, type ModelCredential, type PresetConfig } from '../src/formats/index.js';
import { oobaStopStrings } from '../src/stringlize.js';
import { drain, recordingFetch, REQUEST as BASE, sse, streamed } from './helpers.js';

const env = { NODE_ENV: 'test' };
const REQUEST = { ...BASE, names: { char: 'Lia', user: 'Rin' } };
const key = (provider: string, baseUrl: string | null = null): ModelCredential => ({ kind: 'api_key', provider, baseUrl, apiKey: 'sk-test-key' });
const preset = (format: string, model: string, overrides: Partial<PresetConfig> = {}): PresetConfig => ({
  format, endpoint: null, model, params: {}, capabilities: {}, ...overrides,
});
/** A text completion chunk as OpenAI's `/completions` stream sends it (text-generation-webui's is the same). */
const piece = (text: string, finish: string | null = null) =>
  sse({ id: 'cmpl-1', object: 'text_completion', choices: [{ text, index: 0, logprobs: null, finish_reason: finish }], model: 'm' });

describe('OpenAI legacy instruct', () => {
  it("sends RisuAI's `## Role` prompt to /completions with its four stops, and cuts its reply as RisuAI does", async () => {
    const { fetcher, sent } = recordingFetch(() => streamed(
      piece(' Hello') + piece('##\nthere.') + piece('\nUs') + piece('er: hi', 'stop')
      + sse({ id: 'cmpl-1', object: 'text_completion', choices: [], usage: { prompt_tokens: 40, completion_tokens: 6 } }) + sse('[DONE]'),
    ));
    const adapter = adapterFor(preset('openai-legacy', 'gpt-3.5-turbo-instruct', { params: { temperature: 0.7, topK: 9 } }), key('openai'), env, fetcher);
    const { text, done } = await drain(adapter.stream({ ...REQUEST, model: 'gpt-3.5-turbo-instruct' }));
    // Cut at the request's own stop (`\nUser:`) beside RisuAI's four, and `##\n` taken out.
    expect(text).toBe(' Hellothere.');
    expect(done.usage).toEqual({ promptTokens: 40, completionTokens: 6 });
    expect(sent[0]!.url).toBe('https://api.openai.com/v1/completions');
    expect(sent[0]!.headers['authorization']).toBe('Bearer sk-test-key');
    expect(sent[0]!.body).toEqual({
      model: 'gpt-3.5-turbo-instruct',
      prompt: '\n## Instruction\nYou are the narrator.\n## Instruction\n[Start a new chat]\n## Assistant\nThe door creaks open.\n## User\nWho is there?\n## Instruction\nReply in two paragraphs.\n## Response\n',
      max_tokens: 1200,
      stream: true,
      stream_options: { include_usage: true },
      stop: LEGACY_STOPS,
      temperature: 0.7,
    });
  });

  it("lists OpenAI's completion models only, and NanoGPT's legacy endpoint with its key", async () => {
    const { fetcher, sent } = recordingFetch(() => Response.json({ data: ['gpt-4o', 'babbage-002', 'gpt-3.5-turbo-instruct', 'davinci-002'].map((id) => ({ id })) }));
    expect((await listModels('openai-legacy', null, key('openai'), env, fetcher)).map((model) => model.id)).toEqual(['babbage-002', 'davinci-002', 'gpt-3.5-turbo-instruct']);
    const nano = recordingFetch(() => streamed(piece('Hi', 'stop') + sse('[DONE]')));
    await drain(adapterFor(preset('openai-legacy', 'meta-llama/llama-3.3-70b'), key('nanogpt'), env, nano.fetcher).stream({ ...REQUEST, model: 'meta-llama/llama-3.3-70b' }));
    expect(nano.sent[0]).toMatchObject({ url: 'https://nano-gpt.com/api/v1/completions', headers: { authorization: 'Bearer sk-test-key' } });
    expect(nano.sent[0]!.body).not.toHaveProperty('stream_options');
    expect(sent[0]!.url).toBe('https://api.openai.com/v1/models');
  });
});

describe('Anthropic legacy (Text Completions)', () => {
  const completion = (text: string, stop: string | null = null) =>
    sse({ type: 'completion', completion: text, stop_reason: stop, model: 'claude-2.1' }, 'completion');

  it('sends the `\\n\\nHuman:` prompt to /complete with the key and version, and reads the completion events to their stop reason', async () => {
    const { fetcher, sent } = recordingFetch(() => streamed(completion(' 누구') + sse({ type: 'ping' }, 'ping') + completion('세요?') + completion('', 'stop_sequence')));
    const adapter = adapterFor(preset('anthropic-legacy', 'claude-2.1', { params: { temperature: 0.5, topK: 40 } }), key('anthropic'), env, fetcher);
    const { text, done } = await drain(adapter.stream({ ...REQUEST, model: 'claude-2.1' }));
    expect(text).toBe(' 누구세요?');
    expect(done.usage).toEqual({ promptTokens: 0, completionTokens: 0 });
    expect(sent[0]!.url).toBe('https://api.anthropic.com/v1/complete');
    expect(sent[0]!.headers).toMatchObject({ 'x-api-key': 'sk-test-key', 'anthropic-version': '2023-06-01' });
    expect(sent[0]!.body).toEqual({
      model: 'claude-2.1',
      // Claude 2.1 reads a first system turn bare, as its system prompt.
      prompt: '\n\nHuman: You are the narrator.\n\nSystem: [Start a new chat]\n\nAssistant: The door creaks open.\n\nHuman: Who is there?\n\nSystem: Reply in two paragraphs.\n\nAssistant: ',
      max_tokens_to_sample: 1200,
      stop_sequences: ['\n\nHuman:', '\n\nSystem:', '\n\nAssistant:', '\nUser:'],
      stream: true,
      temperature: 0.5,
      top_k: 40,
    });
  });

  it('tells an error event by its type, and a stream with no stop reason as cut', async () => {
    const overloaded = recordingFetch(() => streamed(completion('부분') + sse({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 'error')));
    await expect(drain(adapterFor(preset('anthropic-legacy', 'claude-2.0'), key('anthropic'), env, overloaded.fetcher).stream({ ...REQUEST, model: 'claude-2.0' })))
      .rejects.toMatchObject({ code: 'provider_unavailable', detail: 'Overloaded' });
    const cut = recordingFetch(() => streamed(completion('부분')));
    await expect(drain(adapterFor(preset('anthropic-legacy', 'claude-2.0'), key('anthropic'), env, cut.fetcher).stream({ ...REQUEST, model: 'claude-2.0' })))
      .rejects.toMatchObject({ code: 'provider_stream_interrupted' });
  });
});

describe('text-generation-webui (Ooba)', () => {
  it("sends the prompt through the preset's instruct template to /v1/completions, with RisuAI's stop strings, keyless", async () => {
    const { fetcher, sent } = recordingFetch(() => streamed(piece('저') + piece('예요.##\n') + piece('', 'stop') + sse('[DONE]')));
    const adapter = adapterFor(
      preset('ooba', 'loaded', { endpoint: 'http://localhost:5000/v1', params: { temperature: 0.9, minP: 0.1, instructTemplate: 'alpaca' } }),
      undefined, env, fetcher,
    );
    expect((await drain(adapter.stream({ ...REQUEST, model: 'loaded' }))).text).toBe('저예요.');
    expect(sent[0]!.url).toBe('http://localhost:5000/v1/completions');
    expect(sent[0]!.headers['authorization']).toBeUndefined();
    expect(sent[0]!.body).toEqual({
      // One system prompt first (RisuAI's flag for Ooba), the later system turn the user's.
      prompt: 'You are the narrator.\n\n[Start a new chat]\n\n### Response:\nThe door creaks open.\n\n### Instruction:\nWho is there?\n\n'
        + '### Instruction:\nsystem: Reply in two paragraphs.\n\n### Response:\n',
      max_tokens: 1200,
      stop: [...oobaStopStrings('Rin'), '\nUser:'],
      stream: true,
      temperature: 0.9,
      min_p: 0.1,
    });
  });

  it("goes ChatML where the preset names no template, and lists the server's models", async () => {
    const { fetcher, sent } = recordingFetch((request) => request.url.endsWith('/models')
      ? Response.json({ object: 'list', data: [{ id: 'Qwen3-8B-Q4_K_M.gguf', object: 'model' }] })
      : streamed(piece('네', 'stop') + sse('[DONE]')));
    await drain(adapterFor(preset('ooba', 'loaded', { endpoint: 'http://localhost:5000' }), undefined, env, fetcher).stream({ ...REQUEST, model: 'loaded' }));
    expect(String(sent[0]!.body!['prompt'])).toMatch(/^<\|im_start\|>system\nYou are the narrator\.\n\n\[Start a new chat\]<\|im_end\|>\n/);
    expect(String(sent[0]!.body!['prompt']).endsWith('<|im_start|>assistant\n')).toBe(true);
    expect(await listModels('ooba', 'http://localhost:5000', undefined, env, fetcher)).toEqual([{ id: 'Qwen3-8B-Q4_K_M.gguf', label: 'Qwen3-8B-Q4_K_M.gguf' }]);
    expect(sent[1]!.url).toBe('http://localhost:5000/v1/models');
  });
});

describe('text-generation-webui legacy (Ooba legacy, Mancer)', () => {
  it("posts to /api/v1/generate, a key in X-API-KEY, and cuts the whole reply where another speaker's line starts", async () => {
    const { fetcher, sent } = recordingFetch((request) => request.url.endsWith('/model')
      ? Response.json({ result: 'mythomax-l2-13b' })
      : Response.json({ results: [{ text: '문이 열린다.\nRin: 누구야' }] }));
    const adapter = adapterFor(preset('ooba-legacy', 'mythomax', { params: { topK: 20, instructTemplate: 'vicuna' } }), key('custom', 'https://mancer.example/webui/mythomax'), env, fetcher);
    expect((await drain(adapter.stream({ ...REQUEST, model: 'mythomax' }))).text).toBe('문이 열린다.\n');
    expect(sent[0]).toMatchObject({ url: 'https://mancer.example/webui/mythomax/api/v1/generate', headers: { 'x-api-key': 'sk-test-key' } });
    expect(sent[0]!.headers['authorization']).toBeUndefined();
    expect(sent[0]!.body).toMatchObject({ max_new_tokens: 1200, stopping_strings: [...oobaStopStrings('Rin'), '\nUser:'], top_k: 20 });
    expect(String(sent[0]!.body!['prompt']).endsWith('USER: system: Reply in two paragraphs.\nASSISTANT:')).toBe(true);
    expect(await listModels('ooba-legacy', null, key('custom', 'https://mancer.example/webui/mythomax'), env, fetcher)).toEqual([{ id: 'mythomax-l2-13b', label: 'mythomax-l2-13b' }]);
  });

  it('is not a reply without its results', async () => {
    const { fetcher } = recordingFetch(() => Response.json({ detail: 'nope' }));
    await expect(drain(adapterFor(preset('ooba-legacy', 'm', { endpoint: 'http://localhost:5000' }), undefined, env, fetcher).stream({ ...REQUEST, model: 'm' })))
      .rejects.toMatchObject({ code: 'provider_invalid_stream' });
  });
});

describe('Kobold', () => {
  const token = (text: string) => sse({ token: text }, 'message');

  it("streams from KoboldCpp's /api/extra/generate/stream with the template, the chat's context and Kobold's names for the values", async () => {
    const { fetcher, sent } = recordingFetch(() => streamed(token('Lia ') + token('웃는다.')));
    const adapter = adapterFor(preset('kobold', 'koboldcpp', { endpoint: 'http://localhost:5001/api/v1', params: { repetitionPenalty: 1.1, topA: 0.2, instructTemplate: 'llama3' } }), undefined, env, fetcher);
    expect((await drain(adapter.stream({ ...REQUEST, model: 'koboldcpp', contextTokens: 8192 }))).text).toBe('Lia 웃는다.');
    expect(sent[0]!.url).toBe('http://localhost:5001/api/extra/generate/stream');
    expect(sent[0]!.body).toMatchObject({ max_length: 1200, max_context_length: 8192, n: 1, stop_sequence: ['\nUser:'], rep_pen: 1.1, top_a: 0.2 });
    expect(String(sent[0]!.body!['prompt']).startsWith('<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\nYou are the narrator.')).toBe(true);
  });

  it('falls back to /api/v1/generate where the server has no stream, and sends no context it was not given', async () => {
    const { fetcher, sent } = recordingFetch((request) => request.url.endsWith('/stream')
      ? Response.json({ detail: 'Not Found' }, { status: 404 })
      : Response.json({ results: [{ text: '안녕.' }] }));
    expect((await drain(adapterFor(preset('kobold', 'x'), undefined, env, fetcher).stream({ ...REQUEST, model: 'x' }))).text).toBe('안녕.');
    expect(sent.map((request) => request.url)).toEqual(['http://localhost:5001/api/extra/generate/stream', 'http://localhost:5001/api/v1/generate']);
    expect(sent[1]!.body).not.toHaveProperty('max_context_length');
  });

  it("lists the model the server loaded, and sends KoboldCpp's password as a bearer key", async () => {
    const { fetcher, sent } = recordingFetch(() => Response.json({ result: 'koboldcpp/Mistral-Nemo-12B' }));
    expect(await listModels('kobold', null, key('custom', 'http://192.168.0.9:5001'), env, fetcher)).toEqual([{ id: 'koboldcpp/Mistral-Nemo-12B', label: 'koboldcpp/Mistral-Nemo-12B' }]);
    expect(sent[0]).toMatchObject({ url: 'http://192.168.0.9:5001/api/v1/model', headers: { authorization: 'Bearer sk-test-key' } });
  });
});

describe('AI Horde', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const waiting = { done: false, faulted: false, is_possible: true, processing: 1, waiting: 0, finished: 0, queue_position: 0, wait_time: 4, kudos: 10, generations: [] };

  it('queues the templated prompt with the anonymous key, asks every two seconds, and cuts the done text as RisuAI does', async () => {
    let polls = 0;
    const { fetcher, sent } = recordingFetch((request) => {
      if (request.url.endsWith('/async')) return Response.json({ id: 'job-1', kudos: 12 }, { status: 202 });
      polls += 1;
      return Response.json(polls < 2 ? waiting : { ...waiting, done: true, generations: [{ text: '“누구냐.”\nRin: 나야', model: 'm', state: 'ok' }] });
    });
    const adapter = adapterFor(preset('horde', 'koboldcpp/Mistral-Nemo', { params: { topK: 40, instructTemplate: 'mistral' } }), undefined, env, fetcher);
    const reply = drain(adapter.stream({ ...REQUEST, model: 'koboldcpp/Mistral-Nemo' }));
    await vi.advanceTimersByTimeAsync(4_000);
    expect((await reply).text).toBe('“누구냐.”\n');
    expect(sent.map((request) => `${request.method} ${request.url}`)).toEqual([
      'POST https://aihorde.net/api/v2/generate/text/async',
      'GET https://aihorde.net/api/v2/generate/text/status/job-1',
      'GET https://aihorde.net/api/v2/generate/text/status/job-1',
    ]);
    expect(sent[0]!.headers).toMatchObject({ apikey: '0000000000', 'client-agent': 'shizue:1:https://shizue.net' });
    expect(sent[0]!.body).toMatchObject({
      params: { n: 1, max_context_length: 4100, max_length: 1200, singleline: false, stop_sequence: ['\nUser:'], top_k: 40 },
      trusted_workers: false,
      slow_workers: true,
      dry_run: false,
      models: ['koboldcpp/Mistral-Nemo', 'koboldcpp/Mistral-Nemo', ' koboldcpp/Mistral-Nemo', 'koboldcpp/Mistral-Nemo '],
    });
    expect(String(sent[0]!.body!['prompt']).startsWith(' [INST] system: You are the narrator.\nsystem: [Start a new chat] [/INST] The door creaks open. ')).toBe(true);
  });

  it('withdraws a request no worker can serve, and one the caller stops', async () => {
    const impossible = recordingFetch((request) =>
      request.url.endsWith('/async') ? Response.json({ id: 'job-2' }, { status: 202 }) : Response.json({ ...waiting, is_possible: false }));
    const failed = drain(adapterFor(preset('horde', 'auto'), key('horde'), env, impossible.fetcher).stream({ ...REQUEST, model: 'auto', contextTokens: 2048 }));
    failed.catch(() => {});
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(failed).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(impossible.sent.at(-1)).toMatchObject({ method: 'DELETE', url: 'https://aihorde.net/api/v2/generate/text/status/job-2' });
    expect(impossible.sent[0]!.headers['apikey']).toBe('sk-test-key');
    expect(impossible.sent[0]!.body).not.toHaveProperty('models');
    expect(impossible.sent[0]!.body).toMatchObject({ params: { max_context_length: 2148 } });

    const caller = new AbortController();
    const queued = recordingFetch((request) => (request.url.endsWith('/async') ? Response.json({ id: 'job-3' }, { status: 202 }) : Response.json(waiting)));
    const stopped = drain(adapterFor(preset('horde', 'auto'), undefined, env, queued.fetcher).stream({ ...REQUEST, model: 'auto', abortSignal: caller.signal }));
    stopped.catch(() => {});
    await vi.advanceTimersByTimeAsync(2_500);
    caller.abort();
    const error = await stopped.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toHaveProperty('code', 'provider_unavailable');
    expect(queued.sent.at(-1)).toMatchObject({ method: 'DELETE', url: 'https://aihorde.net/api/v2/generate/text/status/job-3' });
  });

  it("lists the served text models after auto, most served first, and checks a key at /v2/find_user", async () => {
    const { fetcher, sent } = recordingFetch((request) => request.url.includes('find_user')
      ? Response.json({ username: 'rin#1', kudos: 50 })
      : Response.json([{ name: 'a/model', count: 1, type: 'text' }, { name: 'b/model', count: 9, type: 'text' }]));
    expect((await listModels('horde', null, undefined, env, fetcher)).map((model) => model.id)).toEqual(['auto', 'b/model', 'a/model']);
    expect(sent[0]!.url).toBe('https://aihorde.net/api/v2/status/models?type=text');
    await validateCredential(key('horde'), env, fetcher);
    expect(sent[1]).toMatchObject({ url: 'https://aihorde.net/api/v2/find_user', headers: { apikey: 'sk-test-key' } });
  });
});

describe('NovelAI', () => {
  const newToken = (token: string, final = false) => sse({ token, ptr: 0, final, logprobs: null }, 'newToken');

  it("streams RisuAI's NovelAI transcript and parameters from /ai/generate-stream with the bearer token", async () => {
    const { fetcher, sent } = recordingFetch(() => streamed(newToken(' 문을') + newToken(' 연다.\nRin:') + newToken(' 뭐야', true)));
    const adapter = adapterFor(preset('novelai', 'kayra-v1', { params: { temperature: 1.1, topK: 20, frequencyPenalty: 0.1 } }), key('novelai'), env, fetcher);
    expect((await drain(adapter.stream({ ...REQUEST, model: 'kayra-v1' }))).text).toBe(' 문을 연다.\n');
    expect(sent[0]).toMatchObject({ url: 'https://text.novelai.net/ai/generate-stream', headers: { authorization: 'Bearer sk-test-key' } });
    const body = sent[0]!.body as { input: string; model: string; parameters: Record<string, unknown> };
    expect(body.input).toBe('You are the narrator.\n⁂\nLia: The door creaks open.\nRin: Who is there?\nReply in two paragraphs.\nLia:');
    expect(body.model).toBe('kayra-v1');
    expect(body.parameters).toMatchObject({
      temperature: 1.1, top_k: 20, repetition_penalty_frequency: 0.1,
      // RisuAI's preset under the preset's own values.
      top_p: 0.85, top_a: 0.1, tail_free_sampling: 0.915, repetition_penalty: 2.8, repetition_penalty_range: 2048, repetition_penalty_slope: 0.02,
      repetition_penalty_presence: 0, typical_p: 1,
      max_length: 1200, min_length: 1, use_string: true, return_full_text: false, prefix: 'vanilla', order: [6, 2, 3, 0, 4, 1, 5, 8],
      stop_sequences: [[49287], [49405]], generate_until_sentence: true, use_cache: false, cfg_scale: 1, mirostat_tau: 0,
    });
    expect((body.parameters['bad_words_ids'] as number[][]).length).toBe(317);
    expect((body.parameters['repetition_penalty_whitelist'] as number[]).length).toBe(73);
  });

  it("offers RisuAI's two models, checks a token with a one-token generation, and is cut without its final token", async () => {
    expect(await listModels('novelai', null, key('novelai'), env)).toEqual([{ id: 'kayra-v1', label: 'Kayra' }, { id: 'clio-v1', label: 'Clio' }]);
    const { fetcher, sent } = recordingFetch(() => Response.json({ output: '⁂' }, { status: 201 }));
    await validateCredential(key('novelai'), env, fetcher);
    expect(sent[0]).toMatchObject({ url: 'https://text.novelai.net/ai/generate', method: 'POST', body: { model: 'kayra-v1', parameters: { max_length: 1 } } });
    const cut = recordingFetch(() => streamed(newToken('부분')));
    await expect(drain(adapterFor(preset('novelai', 'kayra-v1'), key('novelai'), env, cut.fetcher).stream({ ...REQUEST, model: 'kayra-v1' }))).rejects.toMatchObject({ code: 'provider_stream_interrupted' });
  });
});

describe('NovelList', () => {
  it("posts RisuAI's NovelList transcript and settings to /api, and reads the character's part of the reply", async () => {
    const { fetcher, sent } = recordingFetch(() => Response.json({ data: ['だれ？」と彼女は言った。\n\nRin 「私だよ」'] }));
    const adapter = adapterFor(preset('novellist', 'supertrin', { params: { temperature: 0.8, topK: 50 } }), key('novellist'), env, fetcher);
    expect((await drain(adapter.stream({ ...REQUEST, model: 'supertrin' }))).text).toBe('「だれ？」\nと彼女は言った。');
    expect(sent[0]).toMatchObject({ url: 'https://api.tringpt.com/api', headers: { authorization: 'Bearer sk-test-key' } });
    expect(sent[0]!.body).toEqual({
      // No flags: every system turn goes as the user's, as RisuAI's reformater makes it.
      text: 'system: You are the narrator.\n\nsystem: [Start a new chat]\n\nThe door creaks open.\n\nWho is there?\n\nsystem: Reply in two paragraphs.\n\nLia 「',
      length: 1200,
      top_p: 0.7, top_k: 50, rep_pen: 1.0625, top_a: 0.08, rep_pen_slope: 1.7, rep_pen_range: 1024, typical_p: 1, badwords: '',
      temperature: 0.8,
      model: 'supertrin',
      stoptokens: '「<<|>>\nUser:',
    });
  });

  it('tells an error beside a 200, and offers its two models', async () => {
    const { fetcher } = recordingFetch(() => Response.json({ error: 'invalid token' }));
    await expect(drain(adapterFor(preset('novellist', 'damsel'), key('novellist'), env, fetcher).stream({ ...REQUEST, model: 'damsel' })))
      .rejects.toMatchObject({ code: 'provider_request_failed', detail: 'invalid token' });
    await expect(validateCredential(key('novellist'), env, fetcher)).rejects.toMatchObject({ code: 'provider_unauthorized' });
    expect((await listModels('novellist', null, key('novellist'), env)).map((model) => model.id)).toEqual(['supertrin', 'damsel']);
  });
});
