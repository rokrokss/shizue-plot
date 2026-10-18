import { joinUrl, providerFailure, providerFetch, providerHttpError, redact, errorMessageOf } from '../http.js';
import { applyExtras, applyParameters, reformat, withPresetParams, type ParameterPlaces } from '../params.js';
import { eventJson, IdleWatch, readSse, StopFilter } from '../stream.js';
import type { ChatMessage, ChatRequest, LLMAdapter, StreamDone } from '../types.js';
import { CATALOG_TIMEOUT_MS, type AdapterConfig, type CatalogConfig, type ModelFormat, type ModelListing } from './format.js';

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

/** OpenAI's own API, whose reasoning models refuse `max_tokens` for `max_completion_tokens` (RisuAI's `OAICompletionTokens`). */
const isOpenAI = (baseUrl: string): boolean => hostOf(baseUrl) === 'api.openai.com';
/** Hosts known to take `stream_options.include_usage`; a strict server elsewhere may refuse the field. */
const USAGE_HOSTS = new Set(['api.openai.com', 'openrouter.ai', 'api.deepseek.com', 'api.deepinfra.com']);
const hostOf = (url: string): string => {
  try { return new URL(url).hostname; } catch { return ''; }
};
/** OpenAI takes at most four stop strings; whitespace alone is not one any provider takes. */
const sentStops = (stop: string[] | undefined): string[] => (stop ?? []).filter((value) => value.trim()).slice(0, 4);

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
  const body: Record<string, unknown> = {
    model: req.model,
    messages: messages.map(wireMessage),
    stream: true,
    ...(USAGE_HOSTS.has(hostOf(config.baseUrl)) ? { stream_options: { include_usage: true } } : {}),
    [isOpenAI(config.baseUrl) ? 'max_completion_tokens' : 'max_tokens']: req.maxTokens,
    ...(stop.length ? { stop } : {}),
  };
  return applyParameters(body, req, PLACES);
}

interface ChunkEvent {
  choices?: { delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null;
  error?: unknown;
}

const invalid = () => providerFailure('provider_invalid_stream', 502);

/**
 * Chat Completions over SSE with an optional bearer key — OpenAI, OpenRouter,
 * DeepSeek, DeepInfra, Mistral's OpenAI endpoint, LM Studio, llama.cpp, vLLM,
 * Ollama's `/v1`, any reverse proxy. `delta.content` is the reply and
 * `reasoning_content` (DeepSeek, llama.cpp, LM Studio) or `reasoning`
 * (OpenRouter, Ollama) its thinking. The reply ends at `[DONE]`, or at the end
 * of a body that gave a `finish_reason`.
 */
function createAdapter(config: AdapterConfig): LLMAdapter {
  const fetcher = config.fetch ?? fetch;
  return {
    async *stream(request) {
      const req = withPresetParams(request, config.params);
      const body = chatCompletionsBody(req, config);
      const headers: Record<string, string> = { ...config.headers };
      applyExtras(body, headers, config.params);
      headers['Content-Type'] = 'application/json';
      if (config.access.kind === 'key') headers['Authorization'] = `Bearer ${config.access.apiKey}`;
      const watch = new IdleWatch(req.abortSignal);
      const stop = new StopFilter(req.stop);
      try {
        watch.arm();
        const response = await providerFetch(fetcher, joinUrl(config.baseUrl, '/chat/completions'), {
          method: 'POST', signal: watch.signal, headers, body: JSON.stringify(body),
        });
        watch.disarm();
        if (!response.ok) throw await providerHttpError(response);
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
            const thinking = choice.delta?.reasoning_content ?? choice.delta?.reasoning;
            if (typeof thinking === 'string' && thinking && !stop.done) yield { type: 'reasoning', reasoning: thinking };
            const text = choice.delta?.content;
            if (typeof text === 'string' && text) {
              const out = stop.push(text);
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
        const rest = stop.flush();
        if (rest) yield { type: 'text', text: rest };
        return { usage };
      } catch (error) {
        if (watch.timedOut) throw providerFailure('provider_timeout', 504);
        throw error;
      } finally {
        watch.disarm();
      }
    },
  };
}

/** Model ids an OpenAI-shaped `/models` lists that are not chat models. */
const NOT_CHAT = /(embed|whisper|tts|dall-e|moderation|transcribe|realtime|audio|image|search|rerank)/i;

/** `GET <base>/models` in OpenAI's shape — and OpenRouter's, which says which models read pictures. */
export async function listOpenAIModels(config: CatalogConfig): Promise<ModelListing[]> {
  const headers: Record<string, string> = { ...config.headers };
  if (config.access.kind === 'key') headers['Authorization'] = `Bearer ${config.access.apiKey}`;
  const response = await providerFetch(config.fetch ?? fetch, joinUrl(config.baseUrl, '/models'), {
    headers, signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  });
  if (!response.ok) throw await providerHttpError(response);
  const body = (await response.json().catch(() => null)) as { data?: unknown } | null;
  if (!body || !Array.isArray(body.data)) throw providerFailure('provider_invalid_stream', 502);
  return body.data
    .filter((entry): entry is { id: string; name?: unknown; architecture?: { input_modalities?: unknown } } =>
      typeof entry === 'object' && entry !== null && typeof (entry as { id?: unknown }).id === 'string')
    .filter((entry) => !NOT_CHAT.test(entry.id))
    .map((entry) => {
      const modalities = entry.architecture?.input_modalities;
      return {
        id: entry.id,
        label: typeof entry.name === 'string' && entry.name ? entry.name : entry.id,
        ...(Array.isArray(modalities) ? { vision: modalities.includes('image') } : {}),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export const openAIChat: ModelFormat = {
  id: 'openai-chat',
  places: PLACES,
  key: 'optional',
  createAdapter,
  listModels: listOpenAIModels,
};
