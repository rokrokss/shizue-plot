/**
 * Golden requests for registry profile presets: for each profile and values,
 * the request this app sends is PocketRisu's to the byte — the URL, the JSON
 * body as text (key order included), and the headers, the provider's
 * attribution aside. PocketRisu's side is its adapters' own code
 * (`pocketrisuOracle.ts`, f71e1cc) over the same bundled catalog; the turns are
 * ones both write alike (a system text, then alternating turns), since a
 * profile preset keeps this app's turn layout (§7.1).
 */
import { describe, expect, it } from 'vitest';
import { adapterFor, type ModelCredential } from '../src/formats/index.js';
import raw from '../src/registry/bundled.json' with { type: 'json' };
import { bundledCatalog, registryBaseOf, resolveSnapshot } from '../src/registry/index.js';
import type { ChatMessage, ChatRequest, ContentPart } from '../src/types.js';
import { pocketRisuRequest, resolveSnapshot as pocketSnapshot, type OracleMessage } from './pocketrisuOracle.js';

const SYSTEM = 'You are the narrator of a slow-burn mystery. Stay in character.';
const CHAT: ChatMessage[] = [
  { role: 'user', content: 'The lantern flickers. Who is there?' },
  { role: 'assistant', content: 'A tall figure steps out of the fog, holding a letter sealed in red wax.' },
  { role: 'user', content: 'I take the letter and break the seal.' },
];
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const WITH_IMAGE: ChatMessage[] = [
  CHAT[0]!,
  CHAT[1]!,
  { role: 'user', content: [{ type: 'text', text: 'This is the letter I found.' }, { type: 'image', url: `data:image/png;base64,${PIXEL}` }] },
];
/** A system text and two of the reader's turns marked for Claude's prompt cache. */
const CACHED: ChatMessage[] = [
  { role: 'system', content: SYSTEM, cachePoint: true },
  { ...CHAT[0]!, cachePoint: true },
  CHAT[1]!,
  { ...CHAT[2]!, cachePoint: true },
];

interface Case {
  name: string;
  profileId: string;
  values?: Record<string, unknown>;
  system?: string;
  messages?: ChatMessage[];
}

const CASES: Case[] = [
  { name: 'Gemini 3.8 Flash, defaults', profileId: 'google:gemini-38-flash' },
  { name: 'Gemini 3.8 Flash, high thinking with thoughts and a stop', profileId: 'google:gemini-38-flash', values: { thinkingLevel: 'high', includeThoughts: true, temperature: 1, stopSequences: ['\nUser:'] } },
  { name: 'Gemini 4 Argon, defaults', profileId: 'google:gemini-4-argon' },
  { name: 'Gemini 4 Argon, low thinking, its own cap and safety', profileId: 'google:gemini-4-argon', values: { thinkingLevel: 'low', includeThoughts: true, maxOutputTokens: 16384, safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' }] } },
  { name: 'Gemini 3.1 Pro, defaults', profileId: 'google:gemini-31-pro' },
  { name: 'Gemini 3.1 Pro, a picture and sampling', profileId: 'google:gemini-31-pro', values: { temperature: 0.7, topP: 0.95, topK: 40, thinkingLevel: 'low' }, messages: WITH_IMAGE },
  { name: 'Claude Opus 5.5, defaults', profileId: 'anthropic:opus-55' },
  { name: 'Claude Opus 5.5, xhigh effort and a bigger cap', profileId: 'anthropic:opus-55', values: { effort: 'xhigh', max_tokens: 32000 } },
  { name: 'Claude Sonnet 5, defaults', profileId: 'anthropic:sonnet-5' },
  { name: 'Claude Sonnet 5, cache points on the system and two turns', profileId: 'anthropic:sonnet-5', values: { effort: 'high' }, system: '', messages: CACHED },
  { name: 'Claude Sonnet 4.5, defaults', profileId: 'anthropic:sonnet-45' },
  { name: 'Claude Sonnet 4.5, budget thinking, a stop and a picture', profileId: 'anthropic:sonnet-45', values: { thinking_type: 'enabled', thinking_budget_tokens: 2048, max_tokens: 8192, stop_sequences: ['\nUser:'] }, messages: WITH_IMAGE },
  { name: 'GPT-6.1 Sol, defaults', profileId: 'openai:gpt-61-sol' },
  { name: 'GPT-6.1 Sol, max effort, low verbosity and a picture', profileId: 'openai:gpt-61-sol', values: { reasoning_effort: 'max', verbosity: 'low', seed: 7 }, messages: WITH_IMAGE },
  { name: 'o3, defaults', profileId: 'openai:o3' },
  { name: 'o3, high effort and a stop', profileId: 'openai:o3', values: { reasoning_effort: 'high', stop: ['\nUser:'] } },
  { name: 'OpenRouter Claude Opus 5.5, defaults', profileId: 'openrouter:claude-opus-55' },
  { name: 'OpenRouter catch-all, a typed model with routing', profileId: 'openrouter:openai-compatible', values: { modelId: 'mistralai/mistral-large-2512', temperature: 0.8, min_p: 0.05, provider: { order: ['mistral'], allow_fallbacks: false } } },
  { name: 'OpenRouter Gemini 3.8 Flash, an effort', profileId: 'openrouter:gemini-38-flash', values: { reasoning_effort: 'medium' } },
  { name: 'DeepSeek V4.1 Flash thinking, defaults', profileId: 'deepseek:v41-flash-thinking' },
  { name: 'NanoGPT GPT-6.1 Sol, defaults', profileId: 'nanogpt:gpt-61-sol' },
  { name: 'Ollama Cloud GLM 5.3, defaults', profileId: 'ollama-cloud:glm-53' },
];

/** What PocketRisu's browser seeds a new preset with: every field's default. */
function seeded(snapshot: { schema: { key: string; default?: unknown }[] }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of snapshot.schema) if (field.default !== undefined) out[field.key] = field.default;
  return out;
}

/** Our turns as PocketRisu's adapter messages: the system text first, pictures as raw base64. */
function oracleMessages(system: string, messages: ChatMessage[]): OracleMessage[] {
  const out: OracleMessage[] = system ? [{ role: 'system', content: system }] : [];
  for (const message of messages) {
    const parts: ContentPart[] = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
    const text = parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
    const images = parts.flatMap((part) => {
      if (part.type !== 'image') return [];
      const match = /^data:([^;,]+);base64,(.*)$/s.exec(part.url)!;
      return [{ kind: 'image' as const, base64: match[2]!, mime: match[1]! }];
    });
    out.push({ role: message.role, content: text, ...(images.length ? { images } : {}), ...(message.cachePoint ? { cachePoint: true } : {}) });
  }
  return out;
}

const USAGE_HOSTS = new Set(['api.openai.com', 'openrouter.ai', 'api.deepseek.com', 'api.deepinfra.com']);
const lower = (headers: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));

async function ourRequest(profileId: string, values: Record<string, unknown>, request: ChatRequest) {
  const snapshot = resolveSnapshot(bundledCatalog(), profileId)!;
  const base = registryBaseOf(snapshot)!;
  const credential: ModelCredential = { kind: 'api_key', provider: base.provider, baseUrl: null, apiKey: 'test-key-1234' };
  let sent: { url: string; headers: Record<string, string>; body: string } | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    sent = { url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: String(init?.body) };
    throw new DOMException('stop', 'AbortError');
  };
  const adapter = adapterFor({ format: base.format, endpoint: null, model: '', params: {}, capabilities: {}, profile: { snapshot, values } }, credential, {}, fetcher);
  await adapter.stream(request).next().catch(() => undefined);
  return sent!;
}

describe('registry profile requests, as PocketRisu sends them', () => {
  it('takes the bundled catalog whole and resolves every profile as PocketRisu does', () => {
    const catalog = bundledCatalog();
    expect(Object.keys(catalog.baseProviders)).toHaveLength(Object.keys(raw.baseProviders).length);
    expect(Object.keys(catalog.profiles)).toHaveLength(Object.keys(raw.profiles).length);
    for (const id of Object.keys(raw.profiles)) {
      expect(JSON.parse(JSON.stringify(resolveSnapshot(catalog, id))), id).toEqual(JSON.parse(JSON.stringify(pocketSnapshot(raw as never, id))));
    }
  });

  for (const entry of CASES) {
    it(entry.name, async () => {
      const oracleSnapshot = pocketSnapshot(raw as never, entry.profileId);
      const values = { ...seeded(oracleSnapshot), ...(entry.values ?? {}) };
      const system = entry.system ?? SYSTEM;
      const messages = entry.messages ?? CHAT;
      const theirs = pocketRisuRequest(oracleSnapshot, values, oracleMessages(system, messages), 'test-key-1234', USAGE_HOSTS.has(new URL(oracleSnapshot.endpoint.url!).hostname));
      const ours = await ourRequest(entry.profileId, values, { model: '', system, messages, maxTokens: 1200 });
      expect(ours.url).toBe(theirs.url);
      expect(ours.body).toBe(theirs.body);
      const { 'http-referer': _referer, 'x-title': _title, ...headers } = ours.headers;
      expect(headers).toEqual(lower(theirs.headers));
    });
  }

  it('sends what each profile ships with: the reply cap, thinking, and nothing the model refuses', async () => {
    const body = async (profileId: string, values: Record<string, unknown> = {}) =>
      JSON.parse((await ourRequest(profileId, { ...seeded(pocketSnapshot(raw as never, profileId)), ...values }, { model: '', system: SYSTEM, messages: CHAT, maxTokens: 30 })).body) as Record<string, any>;
    // The caller's 30-token cap is never the wire's: the profile's own output field is.
    const flash = await body('google:gemini-38-flash');
    expect(flash['generationConfig']).toEqual({ maxOutputTokens: 8192, thinkingConfig: { includeThoughts: false }, responseLogprobs: false });
    expect(flash).not.toHaveProperty('safetySettings');
    const argon = await body('google:gemini-4-argon');
    expect(argon['generationConfig']['maxOutputTokens']).toBe(32768);
    expect(argon['generationConfig']).not.toHaveProperty('temperature');
    const opus = await body('anthropic:opus-55', { temperature: undefined });
    expect(opus).toMatchObject({ max_tokens: 4096, thinking: { type: 'adaptive' }, stream: true, model: 'claude-opus-5-5' });
    expect(opus).not.toHaveProperty('temperature');
    const sol = await body('openai:gpt-61-sol');
    expect(sol).toMatchObject({ model: 'gpt-6.1-sol', max_completion_tokens: 8192, logprobs: false, stream: true, stream_options: { include_usage: true } });
    expect(sol).not.toHaveProperty('parallel_tool_calls');
    expect(sol).not.toHaveProperty('max_tokens');
  });
});
