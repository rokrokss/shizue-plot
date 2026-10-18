import { joinUrl, providerFailure, providerFetch, providerHttpError, redact } from '../http.js';
import { applyParameters, withPresetParams, type ParameterPlaces } from '../params.js';
import { addCallerStops, profileBody, wireModelId } from '../registry/request.js';
import { eventJson, IdleWatch, readSse, StopFilter } from '../stream.js';
import type { ChatMessage, ChatRequest, LLMAdapter, StreamDelta, StreamDone } from '../types.js';
import { CATALOG_TIMEOUT_MS, type AdapterConfig, type CatalogConfig, type ModelFormat, type ModelListing, type ProfileConfig } from './format.js';
import { postJson, watched } from './send.js';

export const ANTHROPIC_VERSION = '2023-06-01';

/** RisuAI's `ClaudeParameters` and its thinking budget's place. */
const PLACES: ParameterPlaces = {
  temperature: 'temperature',
  topK: 'top_k',
  topP: 'top_p',
  thinkingTokens: 'thinking.budget_tokens',
  reasoningEffort: 'output_config.effort',
};

type Block = (
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string } }
) & { cache_control?: { type: 'ephemeral' } };
interface Turn {
  role: 'user' | 'assistant';
  content: Block[];
}

/** A `data:` URL's media type and bytes, or null for any other URL. */
export function dataUrlParts(url: string): { mediaType: string; data: string } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return match ? { mediaType: match[1]!, data: match[2]! } : null;
}

const blocksOf = (content: ChatMessage['content'], prefix = ''): Block[] => {
  if (typeof content === 'string') return [{ type: 'text', text: prefix + content }];
  const blocks: Block[] = [];
  for (const part of content) {
    if (part.type === 'text') blocks.push({ type: 'text', text: (blocks.length === 0 ? prefix : '') + part.text });
    else {
      const bytes = dataUrlParts(part.url);
      blocks.push({ type: 'image', source: bytes ? { type: 'base64', media_type: bytes.mediaType, data: bytes.data } : { type: 'url', url: part.url } });
    }
  }
  return blocks;
};

/**
 * RisuAI's `requestClaude` turns: the system text and the system turns ahead of
 * the conversation as `system`; a system turn inside it as the user's
 * (`System: …`); turns of one role in a row as one, their texts joined by a
 * blank line; and a `Start` from the user ahead of a conversation that does not
 * open with one. Empty texts are dropped and the last assistant text loses its
 * trailing spaces, both of which the API refuses.
 */
export function anthropicTurns(req: Pick<ChatRequest, 'system' | 'messages'>): { system: string; messages: Turn[] } {
  const { system, messages } = cachedTurns(req);
  return { system, messages };
}

/**
 * `anthropicTurns` with where the prompt cache's marks fell: which turns hold
 * a message marked `cachePoint` (a turn made of several, if any of them is),
 * and whether a system turn that went into `system` was — or the system
 * string itself (`systemCachePoint`).
 */
function cachedTurns(req: Pick<ChatRequest, 'system' | 'systemCachePoint' | 'messages'>): {
  system: string;
  messages: Turn[];
  cached: boolean[];
  systemCached: boolean;
} {
  const system: string[] = req.system ? [req.system] : [];
  const turns: Turn[] = [];
  const cached: boolean[] = [];
  let systemCached = req.systemCachePoint === true;
  const add = (role: Turn['role'], blocks: Block[], cachePoint: boolean): void => {
    const kept = blocks.filter((block) => block.type !== 'text' || block.text.length > 0);
    if (kept.length === 0) return;
    const last = turns.at(-1);
    if (last && last.role === role) {
      const tail = last.content.at(-1);
      const [head, ...rest] = kept;
      if (tail?.type === 'text' && head!.type === 'text') {
        last.content[last.content.length - 1] = { type: 'text', text: `${tail.text}\n\n${head!.text}` };
        last.content.push(...rest);
      } else last.content.push(...kept);
      if (cachePoint) cached[cached.length - 1] = true;
    } else {
      turns.push({ role, content: kept });
      cached.push(cachePoint);
    }
  };
  for (const message of req.messages) {
    const cachePoint = message.cachePoint === true;
    if (message.role === 'system') {
      if (turns.length === 0) {
        system.push(typeof message.content === 'string' ? message.content : blocksOf(message.content).flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n'));
        systemCached ||= cachePoint;
      } else add('user', blocksOf(message.content, 'System: '), cachePoint);
    } else add(message.role, blocksOf(message.content), cachePoint);
  }
  if (turns[0]?.role !== 'user') {
    turns.unshift({ role: 'user', content: [{ type: 'text', text: 'Start' }] });
    cached.unshift(false);
  }
  const last = turns.at(-1)!;
  if (last.role === 'assistant') {
    const tail = last.content.at(-1);
    if (tail?.type === 'text') {
      const trimmed = tail.text.trimEnd();
      if (trimmed) last.content[last.content.length - 1] = { type: 'text', text: trimmed };
      else last.content.pop();
      if (last.content.length === 0) {
        turns.pop();
        cached.pop();
      }
    }
  }
  return { system: system.join('\n\n').trim(), messages: turns, cached, systemCached };
}

/** The most prompt-cache breakpoints a request may carry. */
const MAX_CACHE_BREAKPOINTS = 4;

/**
 * A profile preset's Messages request, PocketRisu's `prepareAnthropicBody`
 * (`src/ts/preset/adapter/anthropicMessages.ts`): the profile's body (its
 * defaults and fields, thinking and effort among them), the caller's stop
 * strings in its stop field, then the turns as this format writes them with
 * `cache_control: {type: 'ephemeral'}` on the last block of each turn marked
 * `cachePoint` — the last ones, four at most counting a marked system, which
 * goes as a block to carry its own — then `system`, no tools, the preset's
 * model, PocketRisu's 4096 where the profile sets no `max_tokens`, and
 * `stream`.
 */
export function profileMessagesBody(config: Pick<AdapterConfig, 'params'> & { profile: ProfileConfig }, req: ChatRequest): Record<string, unknown> {
  const { snapshot, values } = config.profile;
  const body = profileBody(snapshot, values, config.params.extraBody);
  addCallerStops(body, snapshot, values, req.stop, Number.POSITIVE_INFINITY);
  const model = wireModelId(snapshot, values);
  const { system, messages, cached, systemCached } = cachedTurns(req);
  const cacheSystem = system.length > 0 && systemCached;
  const budget = MAX_CACHE_BREAKPOINTS - (cacheSystem ? 1 : 0);
  const flagged = cached.flatMap((flag, index) => (flag ? [index] : []));
  const marked = new Set(budget > 0 ? flagged.slice(-budget) : []);
  body['messages'] = messages.map((turn, index) => {
    if (!marked.has(index)) return turn;
    const content = turn.content.slice();
    content[content.length - 1] = { ...content[content.length - 1]!, cache_control: { type: 'ephemeral' } };
    return { ...turn, content };
  });
  if (system) body['system'] = cacheSystem ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : system;
  else delete body['system'];
  delete body['tools'];
  delete body['tool_choice'];
  body['model'] = model;
  if (body['max_tokens'] === undefined) body['max_tokens'] = PROFILE_FALLBACK_MAX_TOKENS;
  body['stream'] = true;
  return body;
}

/** PocketRisu's `ANTHROPIC_FALLBACK_MAX_TOKENS`: the cap a profile that names none is sent. */
const PROFILE_FALLBACK_MAX_TOKENS = 4096;

/**
 * The Messages API body. A thinking budget turns thinking on (`type: enabled`)
 * with the reply's cap on top of it — the budget must sit under `max_tokens` —
 * and an effort without one asks for adaptive thinking (RisuAI's thinking
 * types `budget` and `adaptive`). Thinking takes no temperature, top_k or a
 * top_p below 0.95, so those are not sent beside it.
 */
export function messagesBody(req: ChatRequest): Record<string, unknown> {
  const { system, messages } = anthropicTurns(req);
  const stop = (req.stop ?? []).filter((value) => value.trim());
  const body = applyParameters({ model: req.model, max_tokens: req.maxTokens, messages, stream: true }, req, PLACES);
  if (system) body['system'] = system;
  if (stop.length) body['stop_sequences'] = stop;
  const thinking = body['thinking'] as { budget_tokens?: number } | undefined;
  if (thinking && (thinking.budget_tokens ?? 0) > 0) {
    body['thinking'] = { type: 'enabled', budget_tokens: thinking.budget_tokens };
    body['max_tokens'] = req.maxTokens + thinking.budget_tokens!;
    delete body['output_config'];
  } else {
    delete body['thinking'];
    // Claude's efforts run from low up: `none` asks for no thinking, `minimal` for the least.
    const effort = req.reasoningEffort === 'minimal' ? 'low' : req.reasoningEffort;
    if (effort && effort !== 'none') {
      body['output_config'] = { effort };
      body['thinking'] = { type: 'adaptive' };
    } else delete body['output_config'];
  }
  if (body['thinking']) {
    delete body['temperature'];
    delete body['top_k'];
    delete body['top_p'];
  }
  return body;
}

/** The headers every Anthropic call carries. */
export const anthropicHeaders = (config: Pick<AdapterConfig, 'access' | 'headers'>): Record<string, string> => ({
  ...config.headers,
  ...(config.access.kind === 'key' ? { 'x-api-key': config.access.apiKey } : {}),
  'anthropic-version': ANTHROPIC_VERSION,
});

/** The codes Anthropic's error event types are told as. */
export const ERROR_TYPES: Record<string, string> = {
  authentication_error: 'provider_unauthorized',
  permission_error: 'provider_unauthorized',
  rate_limit_error: 'provider_rate_limited',
  overloaded_error: 'provider_unavailable',
  api_error: 'provider_unavailable',
  invalid_request_error: 'provider_bad_request',
  not_found_error: 'provider_not_found',
};

export interface AnthropicEvent {
  type: string;
  message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
  delta?: { type?: string; text?: string; thinking?: string; stop_reason?: string };
  usage?: { output_tokens?: number };
  error?: { type?: string; message?: string };
}

const invalid = () => providerFailure('provider_invalid_stream', 502);

/**
 * The Messages stream's events, however they arrived (SSE here, Bedrock's
 * event stream frames): a `text_delta` is the reply, a `thinking_delta` its
 * thinking, the usage is `message_start`'s and `message_delta`'s, and the reply
 * ends at `message_stop`; an `error` event is the provider's failure, after
 * text or not.
 */
export async function* readAnthropicEvents(events: AsyncIterable<AnthropicEvent>, stop: StopFilter): AsyncGenerator<StreamDelta, StreamDone> {
  let prompt = 0;
  let cached: number | undefined;
  let completion = 0;
  for await (const event of events) {
    if (event.type === 'message_start') {
      const usage = event.message?.usage;
      cached = usage?.cache_read_input_tokens;
      prompt = (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0);
      completion = usage?.output_tokens ?? 0;
    } else if (event.type === 'content_block_delta') {
      if (event.delta?.type === 'text_delta' && event.delta.text) {
        const out = stop.push(event.delta.text);
        if (out) yield { type: 'text', text: out };
      } else if (event.delta?.type === 'thinking_delta' && event.delta.thinking && !stop.done) {
        yield { type: 'reasoning', reasoning: event.delta.thinking };
      }
    } else if (event.type === 'message_delta') {
      if (typeof event.usage?.output_tokens === 'number') completion = event.usage.output_tokens;
    } else if (event.type === 'error') {
      throw providerFailure(ERROR_TYPES[event.error?.type ?? ''] ?? 'provider_unavailable', 502, redact(event.error?.message ?? ''));
    } else if (event.type === 'message_stop') {
      const rest = stop.flush();
      if (rest) yield { type: 'text', text: rest };
      return {
        usage: { promptTokens: prompt, completionTokens: completion, ...(typeof cached === 'number' ? { cachedPromptTokens: cached } : {}) },
      } satisfies StreamDone;
    }
  }
  throw providerFailure('provider_stream_interrupted', 502);
}

/** An SSE body's events as JSON. */
async function* sseEvents(body: ReadableStream<Uint8Array>, watch: IdleWatch): AsyncGenerator<AnthropicEvent> {
  for await (const block of readSse(body, watch, { invalid })) yield eventJson<AnthropicEvent>(block.data, invalid);
}

/**
 * Anthropic's Messages API: `x-api-key` and `anthropic-version`, the system
 * text at the top level, and the stream's events (`readAnthropicEvents`). A
 * profile preset's body is the profile's (`profileMessagesBody`), with its
 * additional headers and the SSE `Accept`.
 */
function createAdapter(config: AdapterConfig): LLMAdapter {
  return {
    stream(request) {
      const profile = config.profile;
      const req = profile ? request : withPresetParams(request, config.params);
      return watched(req, async function* (watch) {
        const url = joinUrl(config.baseUrl, '/messages');
        const response = profile
          ? await postJson({ ...config, params: {} }, url, profileMessagesBody({ ...config, profile }, req), { ...config.headers, ...config.params.extraHeaders, Accept: 'text/event-stream' }, anthropicHeaders(config), watch)
          : await postJson(config, url, messagesBody(req), { ...config.headers }, anthropicHeaders(config), watch);
        if (!response.body) throw providerFailure('provider_stream_interrupted', 502);
        return yield* readAnthropicEvents(sseEvents(response.body, watch), new StopFilter(req.stop));
      });
    },
  };
}

/** `GET <base>/models`, every page of it the first thousand hold. */
async function listModels(config: CatalogConfig): Promise<ModelListing[]> {
  const response = await providerFetch(config.fetch ?? fetch, joinUrl(config.baseUrl, '/models?limit=1000'), {
    headers: anthropicHeaders(config), signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  });
  if (!response.ok) throw await providerHttpError(response);
  const body = (await response.json().catch(() => null)) as { data?: unknown } | null;
  if (!body || !Array.isArray(body.data)) throw invalid();
  return body.data
    .filter((entry): entry is { id: string; display_name?: unknown } =>
      typeof entry === 'object' && entry !== null && typeof (entry as { id?: unknown }).id === 'string')
    .map((entry) => ({
      id: entry.id,
      label: typeof entry.display_name === 'string' && entry.display_name ? entry.display_name : entry.id,
      // Every Claude since the third reads pictures.
      vision: !/^claude-(?:2|instant)/.test(entry.id),
    }));
}

export const anthropic: ModelFormat = {
  id: 'anthropic',
  places: PLACES,
  key: 'required',
  defaultBaseUrl: 'https://api.anthropic.com/v1',
  createAdapter,
  listModels,
};
