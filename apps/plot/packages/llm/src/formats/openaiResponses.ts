import { CHATGPT_RESOURCE, createChatGPTAdapter, readResponsesStream, responseBody, type ResponsesFailures } from '../chatgptResponses.js';
import { joinUrl, providerFailure, providerFetch, providerHttpError } from '../http.js';
import { applyExtras, applyParameters, withPresetParams, type ParameterPlaces } from '../params.js';
import { IdleWatch } from '../stream.js';
import type { LLMAdapter } from '../types.js';
import type { AdapterConfig, CatalogConfig, ModelFormat, ModelListing } from './format.js';
import { listOpenAIModels } from './openaiChat.js';

/** What the Responses API takes with a key (RisuAI's `buildResponsesBody`). */
const PLACES: ParameterPlaces = {
  temperature: 'temperature',
  topP: 'top_p',
  reasoningEffort: 'reasoning.effort',
  verbosity: 'text.verbosity',
};

/** A key's failures: the HTTP status's codes, and a capped reply is a reply. */
const KEY_FAILURES: ResponsesFailures = {
  failed: (code) => providerFailure(code === 'rate_limit_exceeded' ? 'provider_rate_limited' : 'provider_unavailable', 502, code),
  incomplete: () => null,
  invalid: () => providerFailure('provider_invalid_stream', 502),
  interrupted: () => providerFailure('provider_stream_interrupted', 502),
};

/**
 * The OpenAI Responses API with a key: the body the ChatGPT plan sends
 * (`responseBody` — the system text as instructions, system turns as developer
 * turns, the trailing ones joined, `store: false`, the prompt cache's key), and
 * on top of it what a key may send that the plan may not: the sampling values,
 * `max_output_tokens` and the verbosity. A reply cut at its cap
 * (`response.incomplete`) ends there as a reply, as a capped Chat Completions
 * reply does.
 */
function createKeyAdapter(config: AdapterConfig, apiKey: string): LLMAdapter {
  const fetcher = config.fetch ?? fetch;
  return {
    async *stream(request) {
      const req = withPresetParams(request, config.params);
      const body = applyParameters({ ...responseBody(req), max_output_tokens: req.maxTokens }, req, PLACES);
      const headers: Record<string, string> = { ...config.headers };
      applyExtras(body, headers, config.params);
      Object.assign(headers, { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' });
      const watch = new IdleWatch(req.abortSignal);
      try {
        watch.arm();
        const response = await providerFetch(fetcher, joinUrl(config.baseUrl, '/responses'), {
          method: 'POST', signal: watch.signal, headers, body: JSON.stringify(body),
        });
        watch.disarm();
        if (!response.ok) throw await providerHttpError(response);
        return yield* readResponsesStream(response, req, watch, KEY_FAILURES);
      } catch (error) {
        if (watch.timedOut) throw providerFailure('provider_timeout', 504);
        throw error;
      } finally {
        watch.disarm();
      }
    },
  };
}

/**
 * The plan's adapter with the preset's effort and stop strings: the only values
 * the plan takes. The API has already dropped an effort the account's catalog
 * does not advertise for the model.
 */
function createPlanAdapter(config: AdapterConfig, accessToken: (rejected?: string) => Promise<string>): LLMAdapter {
  const plan = createChatGPTAdapter(accessToken, config.fetch ?? fetch);
  return {
    stream(request) {
      const { reasoningEffort, stop } = config.params;
      return plan.stream({
        ...request,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(stop?.length ? { stop: [...(request.stop ?? []), ...stop] } : {}),
      });
    },
  };
}

export const openAIResponses: ModelFormat = {
  id: 'openai-responses',
  places: PLACES,
  key: 'required',
  chatgpt: ['reasoningEffort'],
  defaultBaseUrl: CHATGPT_RESOURCE,
  createAdapter(config) {
    if (config.access.kind === 'chatgpt') return createPlanAdapter(config, config.access.accessToken);
    if (config.access.kind === 'key') return createKeyAdapter(config, config.access.apiKey);
    throw providerFailure('credential_required', 400);
  },
  async listModels(config: CatalogConfig): Promise<ModelListing[]> {
    if (config.access.kind === 'chatgpt') return config.access.models();
    if (config.access.kind !== 'key') throw providerFailure('credential_required', 400);
    return listOpenAIModels(config);
  },
};
