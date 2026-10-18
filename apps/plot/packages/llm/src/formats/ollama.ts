import { errorMessageOf, joinUrl, providerFailure, providerFetch, providerHttpError, redact } from '../http.js';
import { applyParameters, reformat, withPresetParams, type ParameterPlaces } from '../params.js';
import { readJsonLines, StopFilter } from '../stream.js';
import { contentText, type ChatRequest, type LLMAdapter, type StreamDone } from '../types.js';
import { dataUrlParts } from './anthropic.js';
import { CATALOG_TIMEOUT_MS, type AdapterConfig, type CatalogConfig, type ModelFormat, type ModelListing } from './format.js';
import { bearer } from './openaiChat.js';
import { postJson, watched } from './send.js';
import { capabilitiesOf, serverRoot } from './text.js';

/**
 * Ollama's sampling options under `options`, and its thinking switch. RisuAI
 * sends Ollama only `think`; the native API reads these as its own.
 */
const PLACES: ParameterPlaces = {
  temperature: 'options.temperature',
  topP: 'options.top_p',
  topK: 'options.top_k',
  minP: 'options.min_p',
  repetitionPenalty: 'options.repeat_penalty',
  frequencyPenalty: 'options.frequency_penalty',
  presencePenalty: 'options.presence_penalty',
  reasoningEffort: 'think',
};
/** RisuAI's `ollamaThinkingMode` from the effort words: off, or a level (which Ollama reads as on for a model that has none). */
const THINK: Record<string, boolean | string> = { none: false, minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'high' };

/**
 * The `/api/chat` body: the turns with their words, a reader's pictures as
 * `images` (the bytes of a `data:` URL; the API fetches no address), `think`
 * from the effort, and in `options` the cap (`num_predict`), the chat's context
 * (`num_ctx`), the stop strings and the values.
 */
export function ollamaBody(req: ChatRequest, config: Pick<AdapterConfig, 'capabilities'>): Record<string, unknown> {
  const messages = reformat([...(req.system ? [{ role: 'system' as const, content: req.system }] : []), ...req.messages], capabilitiesOf({}, config));
  const stop = (req.stop ?? []).filter((value) => value.trim());
  const body = applyParameters(
    {
      model: req.model,
      messages: messages.map((message) => {
        const images = message.role === 'user' && typeof message.content !== 'string'
          ? message.content.flatMap((part) => (part.type === 'image' ? [dataUrlParts(part.url)?.data ?? ''] : [])).filter(Boolean)
          : [];
        return { role: message.role, content: contentText(message.content), ...(images.length ? { images } : {}) };
      }),
      stream: true,
      options: {
        num_predict: req.maxTokens,
        ...(req.contextTokens ? { num_ctx: req.contextTokens } : {}),
        ...(stop.length ? { stop } : {}),
      },
    },
    { ...req, reasoningEffort: undefined },
    PLACES,
  );
  const think = req.reasoningEffort ? THINK[req.reasoningEffort] : undefined;
  if (think !== undefined) body['think'] = think;
  return body;
}

interface OllamaChunk {
  message?: { content?: string; thinking?: string };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: unknown;
}

const invalid = () => providerFailure('provider_invalid_stream', 502);

/**
 * Ollama's native chat (RisuAI's `Ollama` format): `<root>/api/chat`, keyless
 * on this computer or with Ollama Cloud's bearer key, answered with one JSON
 * object a line — `message.content` is the reply, `message.thinking` its
 * thinking, and the one marked `done` ends it with the token counts.
 */
function createAdapter(config: AdapterConfig): LLMAdapter {
  return {
    stream(request) {
      const req = withPresetParams(request, config.params);
      return watched(req, async function* (watch) {
        const response = await postJson(config, `${serverRoot(config.baseUrl)}/api/chat`, ollamaBody(req, config), { ...config.headers }, bearer(config), watch);
        if (!response.body) throw providerFailure('provider_stream_interrupted', 502);
        const stop = new StopFilter(req.stop);
        for await (const line of readJsonLines(response.body, watch, { invalid })) {
          const chunk = line as OllamaChunk;
          if (chunk.error) throw providerFailure('provider_unavailable', 502, redact(errorMessageOf(chunk)));
          const thinking = chunk.message?.thinking;
          if (thinking && !stop.done) yield { type: 'reasoning', reasoning: thinking };
          const text = chunk.message?.content;
          if (text) {
            const out = stop.push(text);
            if (out) yield { type: 'text', text: out };
          }
          if (chunk.done) {
            const rest = stop.flush();
            if (rest) yield { type: 'text', text: rest };
            return { usage: { promptTokens: chunk.prompt_eval_count ?? 0, completionTokens: chunk.eval_count ?? 0 } } satisfies StreamDone;
          }
        }
        throw providerFailure('provider_stream_interrupted', 502);
      });
    },
  };
}

/** `GET <root>/api/tags`: the pulled models, but those that only embed; pictures where Ollama says (`capabilities`). */
async function listModels(config: CatalogConfig): Promise<ModelListing[]> {
  const response = await providerFetch(config.fetch ?? fetch, joinUrl(serverRoot(config.baseUrl), '/api/tags'), {
    headers: { ...config.headers, ...bearer(config) }, signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  });
  if (!response.ok) throw await providerHttpError(response);
  const body = (await response.json().catch(() => null)) as { models?: unknown } | null;
  if (!body || !Array.isArray(body.models)) throw invalid();
  return body.models
    .filter((entry): entry is { name?: unknown; model?: unknown; capabilities?: unknown } => typeof entry === 'object' && entry !== null)
    .flatMap((entry) => {
      const id = typeof entry.model === 'string' && entry.model ? entry.model : typeof entry.name === 'string' ? entry.name : '';
      const capabilities = Array.isArray(entry.capabilities) ? entry.capabilities : null;
      if (!id || (capabilities && !capabilities.includes('completion'))) return [];
      return [{
        id,
        label: typeof entry.name === 'string' && entry.name ? entry.name : id,
        ...(capabilities ? { vision: capabilities.includes('vision') } : {}),
      }];
    });
}

export const ollama: ModelFormat = {
  id: 'ollama',
  places: PLACES,
  key: 'optional',
  defaultBaseUrl: 'http://localhost:11434',
  reformat: {},
  createAdapter,
  listModels,
};
