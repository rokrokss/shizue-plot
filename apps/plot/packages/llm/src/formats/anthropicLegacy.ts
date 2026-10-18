import { joinUrl, providerFailure, redact } from '../http.js';
import { applyParameters, withPresetParams, type ParameterPlaces } from '../params.js';
import { eventJson, readSse, StopFilter } from '../stream.js';
import { claudeLegacyPrompt, textTurns } from '../stringlize.js';
import type { ChatRequest, LLMAdapter, StreamDone } from '../types.js';
import { anthropic, anthropicHeaders, ERROR_TYPES } from './anthropic.js';
import type { AdapterConfig, ModelFormat } from './format.js';
import { postJson, watched } from './send.js';

/** RisuAI's `ClaudeParameters`, as the Text Completions API names them. */
const PLACES: ParameterPlaces = { temperature: 'temperature', topP: 'top_p', topK: 'top_k' };
/** The turn markers the model would go on to write, which end its reply (RisuAI's `stop_sequences`). */
export const CLAUDE_LEGACY_STOPS = ['\n\nHuman:', '\n\nSystem:', '\n\nAssistant:'];

/** The `/complete` body: the `\n\nHuman:` prompt, `max_tokens_to_sample`, the turn markers and the request's stops. */
export function completeBody(req: ChatRequest): Record<string, unknown> {
  return applyParameters(
    {
      model: req.model,
      prompt: claudeLegacyPrompt(textTurns(req, {}), req.model),
      max_tokens_to_sample: req.maxTokens,
      stop_sequences: [...CLAUDE_LEGACY_STOPS, ...(req.stop ?? []).filter((value) => value.trim())],
      stream: true,
    },
    req,
    PLACES,
  );
}

interface CompletionEvent {
  type?: string;
  completion?: string;
  stop_reason?: string | null;
  error?: { type?: string; message?: string };
}

const invalid = () => providerFailure('provider_invalid_stream', 502);

/**
 * Anthropic's legacy Text Completions (RisuAI's `AnthropicLegacy`, as RisuAI
 * sent it until 2024-03): `<base>/complete` with `x-api-key` and
 * `anthropic-version`, streamed as `completion` events; the reply ends at the
 * one with a `stop_reason`, and an `error` event is told by its type as the
 * Messages API's are. The API reports no usage.
 */
function createAdapter(config: AdapterConfig): LLMAdapter {
  return {
    stream(request) {
      const req = withPresetParams(request, config.params);
      return watched(req, async function* (watch) {
        const response = await postJson(config, joinUrl(config.baseUrl, '/complete'), completeBody(req), { ...config.headers }, anthropicHeaders(config), watch);
        if (!response.body) throw providerFailure('provider_stream_interrupted', 502);
        const stop = new StopFilter(req.stop);
        for await (const block of readSse(response.body, watch, { invalid })) {
          const event = eventJson<CompletionEvent>(block.data, invalid);
          if (event.type === 'error') {
            throw providerFailure(ERROR_TYPES[event.error?.type ?? ''] ?? 'provider_unavailable', 502, redact(event.error?.message ?? ''));
          }
          if (event.type !== 'completion') continue;
          if (event.completion) {
            const out = stop.push(event.completion);
            if (out) yield { type: 'text', text: out };
          }
          if (event.stop_reason) {
            const rest = stop.flush();
            if (rest) yield { type: 'text', text: rest };
            return { usage: { promptTokens: 0, completionTokens: 0 } } satisfies StreamDone;
          }
        }
        throw providerFailure('provider_stream_interrupted', 502);
      });
    },
  };
}

export const anthropicLegacy: ModelFormat = {
  id: 'anthropic-legacy',
  places: PLACES,
  key: 'required',
  defaultBaseUrl: 'https://api.anthropic.com/v1',
  createAdapter,
  listModels: (config) => anthropic.listModels(config),
};
