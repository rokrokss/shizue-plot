import { providerFailure, providerFetch, providerHttpError } from '../http.js';
import { applyParameters, withPresetParams, type ModelCapabilities, type ParameterPlaces } from '../params.js';
import { StopFilter, Strip } from '../stream.js';
import { oobaStopStrings, speakerChunks, speakersOf } from '../stringlize.js';
import type { ChatRequest, LLMAdapter } from '../types.js';
import { CATALOG_TIMEOUT_MS, type AdapterConfig, type CatalogConfig, type ModelFormat, type ModelListing } from './format.js';
import { bearer, listOpenAIModels, readChatCompletionsStream } from './openaiChat.js';
import { jsonOf, postJson, watched } from './send.js';
import { serverRoot, templatePrompt, whole } from './text.js';

/**
 * text-generation-webui (RisuAI's `Ooba` and `OobaLegacy`): the chat through
 * the preset's instruct template, cut at RisuAI's stop strings for it.
 */

/** RisuAI's flags for its Ooba and Mancer models: one system prompt, first. */
const REFORMAT: ModelCapabilities = { systemPrompt: 'first' };

/** What text-generation-webui's completions take of the values (RisuAI's `OobaParams` and the OpenAI ones). */
const PLACES: ParameterPlaces = {
  temperature: 'temperature',
  topP: 'top_p',
  topK: 'top_k',
  minP: 'min_p',
  topA: 'top_a',
  repetitionPenalty: 'repetition_penalty',
  frequencyPenalty: 'frequency_penalty',
  presencePenalty: 'presence_penalty',
};

/** The `/v1/completions` body RisuAI's `requestOoba` sends: the templated prompt, the cap and its stop strings, streamed. */
export function oobaBody(req: ChatRequest, config: Pick<AdapterConfig, 'capabilities' | 'params'>): Record<string, unknown> {
  const { prompt, user } = templatePrompt(req, config, REFORMAT);
  return applyParameters({ prompt, max_tokens: req.maxTokens, stop: [...oobaStopStrings(user), ...(req.stop ?? [])], stream: true }, req, PLACES);
}

/**
 * The current text-generation-webui API: `<root>/v1/completions`, its
 * OpenAI-compatible stream (`readChatCompletionsStream`), a bearer key where
 * the server was started with one, and every `##\n` taken out as RisuAI does.
 */
function createOobaAdapter(config: AdapterConfig): LLMAdapter {
  return {
    stream(request) {
      const req = withPresetParams(request, config.params);
      return watched(req, async function* (watch) {
        const body = oobaBody(req, config);
        const response = await postJson(config, `${serverRoot(config.baseUrl)}/v1/completions`, body, { ...config.headers }, bearer(config), watch);
        return yield* readChatCompletionsStream(response, watch, new StopFilter(body['stop'] as string[]), new Strip('##\n'));
      });
    },
  };
}

export const ooba: ModelFormat = {
  id: 'ooba',
  places: PLACES,
  key: 'optional',
  defaultBaseUrl: 'http://localhost:5000',
  reformat: REFORMAT,
  instructTemplate: true,
  createAdapter: createOobaAdapter,
  listModels: (config) => listOpenAIModels({ ...config, baseUrl: `${serverRoot(config.baseUrl)}/v1` }),
};

/** What the legacy API takes of the values. */
const LEGACY_PLACES: ParameterPlaces = {
  temperature: 'temperature',
  topP: 'top_p',
  topK: 'top_k',
  minP: 'min_p',
  topA: 'top_a',
  repetitionPenalty: 'repetition_penalty',
};

/**
 * The `/api/v1/generate` body RisuAI's `requestOobaLegacy` sends: the templated
 * prompt, `max_new_tokens` and its stop strings. RisuAI's fixed defaults for
 * the rest are not sent, nor its `truncation_length`, which it sets to the
 * reply's cap; the server's own stand.
 */
export function oobaLegacyBody(req: ChatRequest, config: Pick<AdapterConfig, 'capabilities' | 'params'>): Record<string, unknown> {
  const { prompt, user } = templatePrompt(req, config, REFORMAT);
  return applyParameters({ prompt, max_new_tokens: req.maxTokens, stopping_strings: [...oobaStopStrings(user), ...(req.stop ?? [])] }, req, LEGACY_PLACES);
}

/**
 * text-generation-webui's legacy blocking API (and Mancer, whose key goes in
 * `X-API-KEY`): `<root>/api/v1/generate`, answered whole as `results[0].text`,
 * which is cut where another speaker's line starts as RisuAI's
 * `unstringlizeChat` cuts it. RisuAI streams it over a WebSocket; this does
 * not.
 */
function createOobaLegacyAdapter(config: AdapterConfig): LLMAdapter {
  return {
    stream(request) {
      const req = withPresetParams(request, config.params);
      return watched(req, async function* (watch) {
        const { char, user } = speakersOf(req);
        const auth: Record<string, string> = config.access.kind === 'key' && config.access.apiKey ? { 'X-API-KEY': config.access.apiKey } : {};
        const response = await postJson(config, `${serverRoot(config.baseUrl)}/api/v1/generate`, oobaLegacyBody(req, config), { ...config.headers }, auth, watch);
        const body = await jsonOf<{ results?: { text?: unknown }[] }>(response, watch);
        const text = body.results?.[0]?.text;
        if (typeof text !== 'string') throw providerFailure('provider_invalid_stream', 502);
        yield* whole(text, new StopFilter([...speakerChunks(char, user), ...(req.stop ?? [])]));
        return { usage: { promptTokens: 0, completionTokens: 0 } };
      });
    },
  };
}

/** `GET <root>/api/v1/model`: the one model the server has loaded (`{result}`), as Kobold's is told too. */
export async function loadedModel(config: CatalogConfig, headers: Record<string, string>): Promise<ModelListing[]> {
  const response = await providerFetch(config.fetch ?? fetch, `${serverRoot(config.baseUrl)}/api/v1/model`, {
    headers: { ...config.headers, ...headers }, signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  });
  if (!response.ok) throw await providerHttpError(response);
  const body = (await response.json().catch(() => null)) as { result?: unknown } | null;
  if (!body || typeof body.result !== 'string') throw providerFailure('provider_invalid_stream', 502);
  return body.result ? [{ id: body.result, label: body.result }] : [];
}

export const oobaLegacy: ModelFormat = {
  id: 'ooba-legacy',
  places: LEGACY_PLACES,
  key: 'optional',
  defaultBaseUrl: 'http://localhost:5000',
  reformat: REFORMAT,
  instructTemplate: true,
  createAdapter: createOobaLegacyAdapter,
  listModels: (config) => loadedModel(config, config.access.kind === 'key' && config.access.apiKey ? { 'X-API-KEY': config.access.apiKey } : {}),
};
