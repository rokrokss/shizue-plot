import { describe, expect, it } from 'vitest';
import {
  adapterFor,
  availableFormats,
  connectionOf,
  credentialFits,
  formatOf,
  validateCredential,
  type ModelCredential,
} from '../src/formats/index.js';
import { applyParameters, parseCapabilities, parseModelParams, reformat, withPresetParams } from '../src/params.js';
import type { ChatGPTAccount } from '../src/chatgptAuth.js';
import { drain, recordingFetch, REQUEST, thrown } from './helpers.js';

const key = (provider: string, baseUrl: string | null = null): ModelCredential => ({ kind: 'api_key', provider, baseUrl, apiKey: 'sk-test' });

describe('the format registry', () => {
  it("offers RisuAI's formats but WebLLM and Plugin, and echo to the test runner alone", () => {
    const formats = [
      'openai-chat', 'openai-responses', 'anthropic', 'google', 'vertex', 'bedrock', 'mistral', 'cohere',
      'ollama', 'ooba', 'ooba-legacy', 'kobold', 'novelai', 'novellist', 'horde', 'openai-legacy', 'anthropic-legacy',
    ];
    expect(availableFormats({ NODE_ENV: 'test' }).map((format) => format.id)).toEqual([...formats, 'echo']);
    expect(availableFormats({ NODE_ENV: 'production' }).map((format) => format.id)).toEqual(formats);
    expect(formatOf('echo', { NODE_ENV: 'development' })).toBeUndefined();
    expect(thrown(() => adapterFor({ format: 'echo', endpoint: null, model: 'echo', params: {}, capabilities: {} }, undefined, { NODE_ENV: 'development' })))
      .toMatchObject({ code: 'format_unavailable', status: 400 });
  });

  it("sends a key only to its credential's address, and a keyless preset to its own", () => {
    const chat = formatOf('openai-chat', {})!;
    expect(connectionOf(chat, 'https://attacker.example/v1', key('deepseek')).baseUrl).toBe('https://api.deepseek.com');
    expect(connectionOf(chat, 'https://attacker.example/v1', key('custom', 'http://localhost:8000/v1')).baseUrl).toBe('http://localhost:8000/v1');
    expect(connectionOf(chat, 'http://localhost:11434/v1', undefined)).toEqual({ baseUrl: 'http://localhost:11434/v1', access: { kind: 'none' } });
    // A custom credential without its own address has nowhere to go.
    expect(thrown(() => connectionOf(chat, null, key('custom')))).toMatchObject({ code: 'endpoint_required' });
    expect(thrown(() => connectionOf(chat, null, undefined))).toMatchObject({ code: 'endpoint_required' });
  });

  it('holds a credential to the formats its provider speaks', () => {
    const anthropic = formatOf('anthropic', {})!;
    const responses = formatOf('openai-responses', {})!;
    expect(credentialFits(anthropic, { kind: 'api_key', provider: 'anthropic' })).toBe(true);
    expect(credentialFits(anthropic, { kind: 'api_key', provider: 'openai' })).toBe(false);
    expect(credentialFits(responses, { kind: 'chatgpt' })).toBe(true);
    expect(credentialFits(anthropic, { kind: 'chatgpt' })).toBe(false);
    expect(thrown(() => connectionOf(anthropic, null, key('openai')))).toMatchObject({ code: 'credential_format_mismatch' });
    expect(thrown(() => connectionOf(formatOf('google', {})!, null, undefined))).toMatchObject({ code: 'credential_required' });
  });

  it("sends AWS keys to their region's Bedrock and a service account to its project's Vertex, and neither anywhere else", () => {
    const bedrock = formatOf('bedrock', {})!;
    const vertex = formatOf('vertex', {})!;
    const aws: ModelCredential = { kind: 'aws', provider: 'aws', accessKeyId: 'AKIA', secretAccessKey: 's', region: 'eu-west-1' };
    const gcp: ModelCredential = { kind: 'gcp_service_account', provider: 'vertex', clientEmail: 'a@p.iam.gserviceaccount.com', privateKey: 'k', projectId: 'my-project', region: 'asia-northeast3' };
    expect(connectionOf(bedrock, 'https://attacker.example', aws)).toEqual({
      baseUrl: 'https://bedrock-runtime.eu-west-1.amazonaws.com',
      access: { kind: 'aws', accessKeyId: 'AKIA', secretAccessKey: 's', region: 'eu-west-1' },
    });
    expect(connectionOf(vertex, 'https://attacker.example', gcp).baseUrl).toBe('https://asia-northeast3-aiplatform.googleapis.com/v1/projects/my-project/locations/asia-northeast3');
    expect(credentialFits(bedrock, { kind: 'aws', provider: 'aws' })).toBe(true);
    expect(credentialFits(bedrock, { kind: 'api_key', provider: 'aws' })).toBe(false);
    expect(credentialFits(formatOf('anthropic', {})!, { kind: 'aws', provider: 'aws' })).toBe(false);
    expect(thrown(() => connectionOf(vertex, null, aws))).toMatchObject({ code: 'credential_format_mismatch' });
    expect(thrown(() => connectionOf(bedrock, null, undefined))).toMatchObject({ code: 'credential_required' });
    // A local server's format goes keyless to its own default address.
    expect(connectionOf(formatOf('kobold', {})!, null, undefined)).toEqual({ baseUrl: 'http://localhost:5001', access: { kind: 'none' } });
  });

  it("checks OpenRouter's key at /key, another key by listing models, and the ChatGPT connection by its catalog", async () => {
    const { fetcher, sent } = recordingFetch(() => Response.json({ data: [] }));
    await validateCredential(key('openrouter'), {}, fetcher);
    await validateCredential(key('anthropic'), {}, fetcher);
    expect(sent.map((request) => request.url)).toEqual(['https://openrouter.ai/api/v1/key', 'https://api.anthropic.com/v1/models?limit=1000']);
    expect(sent[0]!.headers['authorization']).toBe('Bearer sk-test');
    const refused = recordingFetch(() => Response.json({ error: { message: 'No auth credentials found' } }, { status: 401 }));
    await expect(validateCredential(key('openrouter'), {}, refused.fetcher)).rejects.toMatchObject({ code: 'provider_unauthorized' });
    let asked = 0;
    const account: ChatGPTAccount = { accessToken: async () => 'T', models: async () => { asked += 1; return []; } };
    await validateCredential({ kind: 'chatgpt', account }, {});
    expect(asked).toBe(1);
  });

  it('runs echo for the tests, with the delay its env sets', async () => {
    const adapter = adapterFor({ format: 'echo', endpoint: null, model: 'echo', params: {}, capabilities: {} }, undefined, { NODE_ENV: 'test' });
    expect((await drain(adapter.stream({ ...REQUEST, messages: [{ role: 'user', content: '안녕 리안' }] }))).text).toBe('안녕 리안');
  });
});

describe("a preset's values", () => {
  it("lay over the caller's request: the values, the preset's cap in place of the caller's, and both sets of stop strings", () => {
    expect(withPresetParams({ ...REQUEST, temperature: 0.2 }, { temperature: 0.9, maxTokens: 4000, stop: ['END'], extraBody: { a: 1 } })).toEqual({
      ...REQUEST, temperature: 0.9, maxTokens: 4000, stop: ['\nUser:', 'END'],
    });
    expect(withPresetParams(REQUEST, {})).toEqual(REQUEST);
  });

  it("go where the format takes them, and not at all where it does not (RisuAI's applyParameters)", () => {
    expect(applyParameters({ model: 'm' }, { temperature: 0.5, topK: 3, thinkingTokens: 100 }, { temperature: 'temperature', thinkingTokens: 'a.b.c' }))
      .toEqual({ model: 'm', temperature: 0.5, a: { b: { c: 100 } } });
  });

  it("move system turns and join roles for a strict chat template (RisuAI's reformater)", () => {
    const messages = [
      { role: 'system' as const, content: 'one' }, { role: 'system' as const, content: 'two' },
      { role: 'assistant' as const, content: 'hi' }, { role: 'system' as const, content: 'note' }, { role: 'user' as const, content: 'yo' },
    ];
    expect(reformat(messages)).toEqual(messages);
    expect(reformat(messages, { systemPrompt: 'first', alternateRoles: true, startWithUser: true })).toEqual([
      { role: 'system', content: 'one\n\ntwo' },
      { role: 'user', content: ' ' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'system: note\nyo' },
    ]);
    expect(reformat(messages, { systemPrompt: 'none' })[0]).toEqual({ role: 'user', content: 'system: one' });
  });

  it('are refused out of range, unknown or unsafe', () => {
    expect(parseModelParams({ temperature: 0.8, topK: 40, reasoningEffort: 'high', verbosity: 'low', maxTokens: 2000, stop: ['\n'], extraHeaders: { 'X-A': '1' }, extraBody: { seed: 1 }, topP: null }))
      .toEqual({ temperature: 0.8, topK: 40, reasoningEffort: 'high', verbosity: 'low', maxTokens: 2000, stop: ['\n'], extraHeaders: { 'X-A': '1' }, extraBody: { seed: 1 } });
    for (const bad of [
      { temperature: 3 }, { topK: 1.5 }, { frequencyPenalty: -3 }, { reasoningEffort: 'HIGH' }, { verbosity: 'max' }, { maxTokens: 0 },
      { stop: [''] }, { extraHeaders: { 'Content-Length': '1' } }, { extraHeaders: { 'X-A': 'a\r\nB: c' } }, { nope: 1 }, [],
    ]) expect(() => parseModelParams(bad), JSON.stringify(bad)).toThrow(TypeError);
    expect(parseCapabilities({ vision: true, systemPrompt: 'first' })).toEqual({ vision: true, systemPrompt: 'first' });
    expect(() => parseCapabilities({ vision: 'yes' })).toThrow(TypeError);
  });
});
