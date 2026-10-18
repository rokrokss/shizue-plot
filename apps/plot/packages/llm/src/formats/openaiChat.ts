import { errorMessageOf, joinUrl, providerFailure, providerFetch, providerHttpError, redact } from '../http.js';
import { applyParameters, reformat, withPresetParams, type ParameterPlaces } from '../params.js';
import { eventJson, IdleWatch, readSse, StopFilter, Strip } from '../stream.js';
import type { ChatMessage, ChatRequest, LLMAdapter, StreamDelta, StreamDone } from '../types.js';
import { CATALOG_TIMEOUT_MS, type AdapterConfig, type CatalogConfig, type ModelFormat, type ModelListing } from './format.js';
import { postJson, watched } from './send.js';

/**
 * What a Chat Completions server takes: OpenRouter's list in RisuAI's model
 * table (the widest of the OpenAI-compatible ones), with the reasoning effort
 * and verbosity OpenAI's reasoning models read. A local server ignores what it
 * does not know, or refuses it — the preset sends only what its owner set.
 */
const PLACES: ParameterPlaces = {
  temperature: 'temperature',
  topP: 'top_p',
  topK: 'top_k',
  minP: 'min_p',
  topA: 'top_a',
  repetitionPenalty: 'repetition_penalty',
  frequencyPenalty: 'frequency_penalty',
  presencePenalty: 'presence_penalty',
  reasoningEffort: 'reasoning_effort',
  verbosity: 'verbosity',
};

/**
 * OpenAI's own API, whose reasoning models refuse `max_tokens` for
 * `max_completion_tokens`, and NanoGPT's, which RisuAI sends it the same way
 * (RisuAI's `OAICompletionTokens`).
 */
const COMPLETION_TOKEN_HOSTS = new Set(['api.openai.com', 'nano-gpt.com']);
/** Hosts known to take `stream_options.include_usage`; a strict server elsewhere may refuse the field. */
export const USAGE_HOSTS = new Set(['api.openai.com', 'openrouter.ai', 'api.deepseek.com', 'api.deepinfra.com']);
export const hostOf = (url: string): string => {
  try { return new URL(url).hostname; } catch { return ''; }
};
/** OpenAI takes at most four stop strings; whitespace alone is not one any provider takes. */
export const sentStops = (stop: string[] | undefined): string[] => (stop ?? []).filter((value) => value.trim()).slice(0, 4);
/** The headers a bearer key goes in, where there is one. */
export const bearer = (config: Pick<AdapterConfig, 'access'>): Record<string, string> =>
  config.access.kind === 'key' && config.access.apiKey ? { Authorization: `Bearer ${config.access.apiKey}` } : {};

/** One turn as Chat Completions takes it: pictures only on the reader's turns, as `image_url` parts. */
function wireMessage(message: ChatMessage): Record<string, unknown> {
  if (typeof message.content === 'string') return { role: message.role, content: message.content };
  if (message.role !== 'user') {
    return { role: message.role, content: message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n') };
  }
  return {
    role: 'user',
    content: message.content.map((part) =>
      part.type === 'image' ? { type: 'image_url', image_url: { url: part.url } } : { type: 'text', text: part.text }),
  };
}

/** The request body for `req`, RisuAI's `requestOpenAI` without its tools, bias and multi-generation. */
export function chatCompletionsBody(req: ChatRequest, config: Pick<AdapterConfig, 'baseUrl' | 'capabilities'>): Record<string, unknown> {
  const messages = reformat([...(req.system ? [{ role: 'system' as const, content: req.system }] : []), ...req.messages], config.capabilities);
  const stop = sentStops(req.stop);
  const host = hostOf(config.baseUrl);
  const body: Record<string, unknown> = {
    model: req.model,
    messages: messages.map(wireMessage),
    stream: true,
    ...(USAGE_HOSTS.has(host) ? { stream_options: { include_usage: true } } : {}),
    [COMPLETION_TOKEN_HOSTS.has(host) ? 'max_completion_tokens' : 'max_tokens']: req.maxTokens,
    ...(stop.length ? { stop } : {}),
  };
  return applyParameters(body, req, PLACES);
}

/** A content part of Mistral's reasoning models, whose `delta.content` is a list. */
type ContentChunk = { type?: string; text?: string; thinking?: ContentChunk[] };

interface ChunkEvent {
  choices?: {
    delta?: { content?: string | ContentChunk[] | null; reasoning_content?: string | null; reasoning?: string | null };
    /** A text completion's piece (`/completions`). */
    text?: string | null;
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null;
  error?: unknown;
}

const invalid = () => providerFailure('provider_invalid_stream', 502);

/** A `delta.content` list's words and its thinking (Mistral's `thinking` chunks). */
function contentChunks(chunks: ContentChunk[]): { text: string; thinking: string } {
  let text = '';
  let thinking = '';
  for (const chunk of chunks) {
    if (chunk.type === 'text' && typeof chunk.text === 'string') text += chunk.text;
    else if (chunk.type === 'thinking') thinking += contentChunks(chunk.thinking ?? []).text;
  }
  return { text, thinking };
}

/**
 * An OpenAI-shaped stream of chunks — Chat Completions' `delta.content`, or a
 * text completion's `text` — read to `[DONE]`, or to the end of a body that
 * gave a `finish_reason`: the reply through `stop` (and `strip`, RisuAI's
 * `##\n` removal for the text formats), the thinking — `reasoning_content`
 * (DeepSeek, llama.cpp, LM Studio), `reasoning` (OpenRouter, Ollama) or
 * Mistral's `thinking` chunks — apart, and the usage where it is reported.
 */
export async function* readChatCompletionsStream(
  response: Response,
  watch: IdleWatch,
  stop: StopFilter,
  strip?: Strip,
): AsyncGenerator<StreamDelta, StreamDone> {
  if (!response.body) throw providerFailure('provider_stream_interrupted', 502);
  let usage: StreamDone['usage'] = { promptTokens: 0, completionTokens: 0 };
  let finished = false;
  for await (const block of readSse(response.body, watch, { invalid })) {
    if (block.data === '[DONE]') {
      finished = true;
      break;
    }
    const chunk = eventJson<ChunkEvent>(block.data, invalid);
    if (chunk.error) throw providerFailure('provider_unavailable', 502, redact(errorMessageOf(chunk)));
    for (const choice of chunk.choices ?? []) {
      const content = choice.delta?.content;
      const parts = Array.isArray(content) ? contentChunks(content) : null;
      const thinking = choice.delta?.reasoning_content ?? choice.delta?.reasoning ?? parts?.thinking;
      if (typeof thinking === 'string' && thinking && !stop.done) yield { type: 'reasoning', reasoning: thinking };
      const text = parts ? parts.text : typeof content === 'string' ? content : choice.text;
      if (typeof text === 'string' && text) {
        const passed = stop.push(text);
        const out = strip ? strip.push(passed) : passed;
        if (out) yield { type: 'text', text: out };
      }
      if (choice.finish_reason) finished = true;
    }
    if (chunk.usage) {
      const cached = chunk.usage.prompt_tokens_details?.cached_tokens;
      usage = {
        promptTokens: chunk.usage.prompt_tokens ?? 0,
        completionTokens: chunk.usage.completion_tokens ?? 0,
        ...(typeof cached === 'number' ? { cachedPromptTokens: cached } : {}),
      };
    }
  }
  if (!finished) throw providerFailure('provider_stream_interrupted', 502);
  const passed = stop.flush();
  const rest = strip ? strip.push(passed) + strip.flush() : passed;
  if (rest) yield { type: 'text', text: rest };
  return { usage };
}

/**
 * Chat Completions over SSE with an optional bearer key — OpenAI, OpenRouter,
 * DeepSeek, DeepInfra, NanoGPT, Mistral's OpenAI endpoint, LM Studio,
 * llama.cpp, vLLM, Ollama's `/v1`, any reverse proxy (`readChatCompletionsStream`).
 */
function createAdapter(config: AdapterConfig): LLMAdapter {
  return {
    stream(request) {
      const req = withPresetParams(request, config.params);
      return watched(req, async function* (watch) {
        const response = await postJson(config, joinUrl(config.baseUrl, '/chat/completions'), chatCompletionsBody(req, config), { ...config.headers }, bearer(config), watch);
        return yield* readChatCompletionsStream(response, watch, new StopFilter(req.stop));
      });
    },
  };
}

/** Model ids an OpenAI-shaped `/models` lists that are not chat models. */
const NOT_CHAT = /(embed|whisper|tts|dall-e|moderation|transcribe|realtime|audio|image|search|rerank)/i;

interface ListedModel {
  id: string;
  name?: unknown;
  /** OpenRouter's. */
  architecture?: { input_modalities?: unknown };
  /** Mistral's and NanoGPT's. */
  capabilities?: { completion_chat?: unknown; vision?: unknown };
}

/**
 * `GET <base>/models` in OpenAI's shape — and OpenRouter's, which says which
 * models read pictures, and Mistral's and NanoGPT's, which say which chat and
 * which read pictures (`capabilities`).
 */
export async function listOpenAIModels(config: CatalogConfig): Promise<ModelListing[]> {
  const response = await providerFetch(config.fetch ?? fetch, joinUrl(config.baseUrl, '/models'), {
    headers: { ...config.headers, ...bearer(config) }, signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  });
  if (!response.ok) throw await providerHttpError(response);
  const body = (await response.json().catch(() => null)) as { data?: unknown } | null;
  if (!body || !Array.isArray(body.data)) throw providerFailure('provider_invalid_stream', 502);
  return body.data
    .filter((entry): entry is ListedModel => typeof entry === 'object' && entry !== null && typeof (entry as { id?: unknown }).id === 'string')
    .filter((entry) => !NOT_CHAT.test(entry.id) && entry.capabilities?.completion_chat !== false)
    .map((entry) => {
      const modalities = entry.architecture?.input_modalities;
      const vision = Array.isArray(modalities) ? modalities.includes('image') : entry.capabilities?.vision;
      return {
        id: entry.id,
        label: typeof entry.name === 'string' && entry.name ? entry.name : entry.id,
        ...(typeof vision === 'boolean' ? { vision } : {}),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export const openAIChat: ModelFormat = {
  id: 'openai-chat',
  places: PLACES,
  key: 'optional',
  reformat: {},
  createAdapter,
  listModels: listOpenAIModels,
};
