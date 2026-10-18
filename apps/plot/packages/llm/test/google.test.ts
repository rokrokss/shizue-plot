import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateContentBody, geminiContents } from '../src/formats/google.js';
import { GEMINI_SAFETY } from '../src/geminiSafety.js';
import { adapterFor, listModels, type ModelCredential, type PresetConfig } from '../src/formats/index.js';
import { IDLE_TIMEOUT_MS } from '../src/stream.js';
import { LLMError } from '../src/types.js';
import { drain, liveFetch, recordingFetch, REQUEST as BASE, sse, streamed } from './helpers.js';

const REQUEST = { ...BASE, model: 'gemini-2.5-flash' };

const preset = (overrides: Partial<PresetConfig> = {}): PresetConfig => ({
  format: 'google', endpoint: null, model: 'gemini-2.5-flash', params: {}, capabilities: {}, ...overrides,
});
const key: ModelCredential = { kind: 'api_key', provider: 'google', baseUrl: null, apiKey: 'AIzaTestKey' };
const env = { NODE_ENV: 'test' };
/** `streamGenerateContent?alt=sse` as Google's docs show it: candidates of parts, usage on the way. */
const part = (text: string, thought = false, finishReason?: string) =>
  sse({ candidates: [{ content: { role: 'model', parts: [{ text, ...(thought ? { thought: true } : {}) }] }, ...(finishReason ? { finishReason } : {}) }] });
const REPLY = part('누가 ', true) + part('왔는지 본다') + part('누구세요?')
  + sse({ candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 5, thoughtsTokenCount: 4, cachedContentTokenCount: 10 } });

describe('Google Gemini (AI Studio)', () => {
  it('streams with the key in x-goog-api-key, the system text as systemInstruction, and BLOCK_NONE everywhere', async () => {
    const { fetcher, sent } = recordingFetch(() => streamed(REPLY));
    const { text, reasoning, done } = await drain(adapterFor(preset({ params: { temperature: 1.2, topK: 0, topP: 0.95 } }), key, env, fetcher).stream(REQUEST));
    expect(text).toBe('왔는지 본다누구세요?');
    expect(reasoning).toBe('누가 ');
    expect(done.usage).toEqual({ promptTokens: 30, completionTokens: 9, cachedPromptTokens: 10 });
    expect(sent[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse');
    expect(sent[0]!.url).not.toContain('AIza');
    expect(sent[0]!.headers['x-goog-api-key']).toBe('AIzaTestKey');
    expect(sent[0]!.body).toEqual({
      contents: [
        { role: 'user', parts: [{ text: 'Start' }] },
        { role: 'model', parts: [{ text: 'The door creaks open.' }] },
        { role: 'user', parts: [{ text: 'Who is there?\nsystem:Reply in two paragraphs.' }, { inlineData: { mimeType: 'image/png', data: 'aGk=' } }] },
      ],
      safetySettings: GEMINI_SAFETY,
      generationConfig: { maxOutputTokens: 1200, stopSequences: ['\nUser:'], temperature: 1.2, topP: 0.95 },
      systemInstruction: { parts: [{ text: 'You are the narrator.\n\n[Start a new chat]' }] },
    });
    expect(GEMINI_SAFETY.map((entry) => entry.threshold)).toEqual(Array(5).fill('BLOCK_NONE'));
  });

  it('asks for the thoughts with a budget (2.5) or a level (3), the budget winning when both are set', () => {
    expect(generateContentBody({ ...REQUEST, thinkingTokens: 1024 }).generationConfig).toMatchObject({ thinkingConfig: { thinkingBudget: 1024, includeThoughts: true } });
    expect(generateContentBody({ ...REQUEST, reasoningEffort: 'xhigh' }).generationConfig).toMatchObject({ thinkingConfig: { thinkingLevel: 'high', includeThoughts: true } });
    const both = generateContentBody({ ...REQUEST, thinkingTokens: 0, reasoningEffort: 'low' }).generationConfig as { thinkingConfig: Record<string, unknown> };
    expect(both.thinkingConfig).toEqual({ thinkingBudget: 0, includeThoughts: true });
    expect(generateContentBody(REQUEST).generationConfig).not.toHaveProperty('thinkingConfig');
  });

  it('joins one role in a row and leaves out a picture the API cannot fetch', () => {
    expect(geminiContents({
      system: '',
      messages: [
        { role: 'user', content: 'a' }, { role: 'user', content: [{ type: 'text', text: 'b' }, { type: 'image', url: 'https://example.com/x.png' }] },
        { role: 'assistant', content: 'c' }, { role: 'system', content: 'note' },
      ],
    }).contents).toEqual([
      { role: 'user', parts: [{ text: 'a\n\nb' }] },
      { role: 'model', parts: [{ text: 'c' }] },
      { role: 'user', parts: [{ text: 'system:note' }] },
    ]);
  });

  it('tells a blocked prompt and a reply stopped for safety before any text as refused, and a cut stream as interrupted', async () => {
    const blocked = recordingFetch(() => streamed(sse({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } })));
    await expect(drain(adapterFor(preset(), key, env, blocked.fetcher).stream(REQUEST))).rejects.toMatchObject({ code: 'provider_refused', detail: 'PROHIBITED_CONTENT' });
    const safety = recordingFetch(() => streamed(sse({ candidates: [{ finishReason: 'SAFETY' }] })));
    await expect(drain(adapterFor(preset(), key, env, safety.fetcher).stream(REQUEST))).rejects.toMatchObject({ code: 'provider_refused' });
    const cut = recordingFetch(() => streamed(part('부분')));
    await expect(drain(adapterFor(preset(), key, env, cut.fetcher).stream(REQUEST))).rejects.toMatchObject({ code: 'provider_stream_interrupted' });
  });

  it.each([[400, 'provider_bad_request'], [403, 'provider_unauthorized'], [429, 'provider_rate_limited'], [500, 'provider_unavailable']])('tells HTTP %i as %s', async (status, code) => {
    const { fetcher } = recordingFetch(() => Response.json({ error: { code: status, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }, { status }));
    const error = await drain(adapterFor(preset(), key, env, fetcher).stream(REQUEST)).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code, status, detail: 'API key not valid. Please pass a valid API key.' });
  });

  it('lists the models that generate content, by the id the path takes', async () => {
    const { fetcher, sent } = recordingFetch(() => Response.json({ models: [
      { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
      { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
    ] }));
    expect(await listModels('google', null, key, env, fetcher)).toEqual([{ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', vision: true }]);
    expect(sent[0]).toMatchObject({ url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', headers: { 'x-goog-api-key': 'AIzaTestKey' } });
  });
});

describe('Gemini abort and idle timeout', () => {
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
