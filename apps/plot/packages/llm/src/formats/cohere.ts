import { errorMessageOf, joinUrl, providerFailure, providerFetch, providerHttpError, redact } from '../http.js';
import { applyParameters, withPresetParams, type ModelCapabilities, type ParameterPlaces } from '../params.js';
import { readJsonLines, StopFilter } from '../stream.js';
import { textTurns } from '../stringlize.js';
import type { ChatRequest, LLMAdapter, StreamDone } from '../types.js';
import { CATALOG_TIMEOUT_MS, type AdapterConfig, type CatalogConfig, type ModelFormat, type ModelListing } from './format.js';
import { bearer } from './openaiChat.js';
import { postJson, watched } from './send.js';
import { capabilitiesOf } from './text.js';

/** RisuAI's Cohere parameters, `top_k` and `top_p` by Cohere's names. */
const PLACES: ParameterPlaces = {
  temperature: 'temperature',
  topK: 'k',
  topP: 'p',
  presencePenalty: 'presence_penalty',
  frequencyPenalty: 'frequency_penalty',
};
/** RisuAI's flags for its Command models. */
const REFORMAT: ModelCapabilities = { systemPrompt: 'first', alternateRoles: true, startWithUser: true };
/** The two models RisuAI leaves on Cohere's own safety mode: they predate `safety_mode`. */
const SAFETY_DEFAULT = new Set(['command-r-03-2024', 'command-r-plus-04-2024']);
const ROLES = { user: 'USER', assistant: 'CHATBOT', system: 'SYSTEM' } as const;

/**
 * RisuAI's `requestCohere` body for the v1 chat API: the last user turn as
 * `message` (with what came after it, each after its role, when the request
 * does not end on it), a first system turn as `preamble`, the rest as
 * `chat_history`, and `safety_mode: NONE`. RisuAI sends no model and no cap,
 * and puts a preamble with no history in the message's place; this sends the
 * preset's model and the cap, and the preamble as a preamble always.
 */
export function cohereBody(req: ChatRequest, config: Pick<AdapterConfig, 'capabilities'>): Record<string, unknown> {
  const turns = textTurns(req, capabilitiesOf(REFORMAT, config));
  let message = '';
  let last = turns.at(-1);
  if (last?.role === 'user') {
    message = last.content;
    turns.pop();
  } else {
    while (last?.role !== 'user') {
      last = turns.pop();
      if (!last) throw providerFailure('provider_bad_request', 400, 'Cohere needs a user turn to answer');
      message = `${last.role === 'user' ? '' : `${last.role}: `}\n${last.content}${message}`;
    }
  }
  const preamble = turns[0]?.role === 'system' ? turns.shift()!.content : '';
  const stop = (req.stop ?? []).filter((value) => value.trim());
  return applyParameters(
    {
      model: req.model,
      message,
      chat_history: turns.filter((turn) => turn.content).map((turn) => ({ role: ROLES[turn.role], message: turn.content })),
      ...(preamble ? { preamble } : {}),
      max_tokens: req.maxTokens,
      ...(stop.length ? { stop_sequences: stop } : {}),
      ...(SAFETY_DEFAULT.has(req.model) ? {} : { safety_mode: 'NONE' }),
      stream: true,
    },
    req,
    PLACES,
  );
}

interface CohereEvent {
  event_type?: string;
  text?: string;
  finish_reason?: string;
  response?: { meta?: { billed_units?: { input_tokens?: number; output_tokens?: number }; tokens?: { input_tokens?: number; output_tokens?: number } } };
  error?: unknown;
  message?: unknown;
}

/** The finish reasons that are failures, and what they are told as. */
const FAILED: Record<string, string> = { ERROR: 'provider_unavailable', ERROR_TOXIC: 'provider_refused', ERROR_LIMIT: 'provider_bad_request' };
const invalid = () => providerFailure('provider_invalid_stream', 502);

/**
 * Cohere's v1 chat (RisuAI's `Cohere` format), streamed: `<base>/chat` with
 * the bearer key, answered with one JSON object a line — `text-generation`
 * pieces are the reply, `stream-end` ends it with its finish reason and usage.
 */
function createAdapter(config: AdapterConfig): LLMAdapter {
  return {
    stream(request) {
      const req = withPresetParams(request, config.params);
      return watched(req, async function* (watch) {
        const response = await postJson(config, joinUrl(config.baseUrl, '/chat'), cohereBody(req, config), { ...config.headers }, bearer(config), watch);
        if (!response.body) throw providerFailure('provider_stream_interrupted', 502);
        const stop = new StopFilter(req.stop);
        for await (const line of readJsonLines(response.body, watch, { invalid })) {
          const event = line as CohereEvent;
          if (event.event_type === 'text-generation' && typeof event.text === 'string' && event.text) {
            const out = stop.push(event.text);
            if (out) yield { type: 'text', text: out };
          } else if (event.event_type === 'stream-end') {
            const failed = FAILED[event.finish_reason ?? ''];
            if (failed) throw providerFailure(failed, 502, event.finish_reason);
            const rest = stop.flush();
            if (rest) yield { type: 'text', text: rest };
            const usage = event.response?.meta?.billed_units ?? event.response?.meta?.tokens;
            return { usage: { promptTokens: usage?.input_tokens ?? 0, completionTokens: usage?.output_tokens ?? 0 } } satisfies StreamDone;
          } else if (!event.event_type && (event.error || event.message)) {
            throw providerFailure('provider_unavailable', 502, redact(errorMessageOf(event)));
          }
        }
        throw providerFailure('provider_stream_interrupted', 502);
      });
    },
  };
}

/** `GET <base>/models?endpoint=chat`: the models that chat, by name. */
async function listModels(config: CatalogConfig): Promise<ModelListing[]> {
  const response = await providerFetch(config.fetch ?? fetch, joinUrl(config.baseUrl, '/models?endpoint=chat&page_size=1000'), {
    headers: { ...config.headers, ...bearer(config) }, signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  });
  if (!response.ok) throw await providerHttpError(response);
  const body = (await response.json().catch(() => null)) as { models?: unknown } | null;
  if (!body || !Array.isArray(body.models)) throw invalid();
  return body.models
    .filter((entry): entry is { name: string } => typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string')
    .map((entry) => ({ id: entry.name, label: entry.name }));
}

export const cohere: ModelFormat = {
  id: 'cohere',
  places: PLACES,
  key: 'required',
  defaultBaseUrl: 'https://api.cohere.com/v1',
  reformat: REFORMAT,
  createAdapter,
  listModels,
};
