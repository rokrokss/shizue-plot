import { joinUrl } from '../http.js';
import { applyParameters, withPresetParams, type ModelCapabilities, type ParameterPlaces } from '../params.js';
import { StopFilter, Strip } from '../stream.js';
import { legacyInstructPrompt, textTurns } from '../stringlize.js';
import type { ChatRequest, LLMAdapter } from '../types.js';
import type { AdapterConfig, CatalogConfig, ModelFormat, ModelListing } from './format.js';
import { bearer, hostOf, listOpenAIModels, readChatCompletionsStream, USAGE_HOSTS } from './openaiChat.js';
import { postJson, watched } from './send.js';
import { capabilitiesOf } from './text.js';

/** What RisuAI's `requestOpenAILegacyInstruct` sends of its values. */
const PLACES: ParameterPlaces = {
  temperature: 'temperature',
  topP: 'top_p',
  presencePenalty: 'presence_penalty',
  frequencyPenalty: 'frequency_penalty',
};
/** RisuAI's own stop strings for the format, the four OpenAI takes. */
export const LEGACY_STOPS = ['User:', ' User:', 'user:', ' user:'];
/** System turns stand where they are, as `## Instruction` (the prompt's own heading for them). */
const REFORMAT: ModelCapabilities = {};

/** The `/completions` body: the `## Role` prompt, the cap, RisuAI's stop strings and the values. */
export function legacyCompletionsBody(req: ChatRequest, config: Pick<AdapterConfig, 'baseUrl' | 'capabilities'>): Record<string, unknown> {
  return applyParameters(
    {
      model: req.model,
      prompt: legacyInstructPrompt(textTurns(req, capabilitiesOf(REFORMAT, config))),
      max_tokens: req.maxTokens,
      stream: true,
      ...(USAGE_HOSTS.has(hostOf(config.baseUrl)) ? { stream_options: { include_usage: true } } : {}),
      stop: LEGACY_STOPS,
    },
    req,
    PLACES,
  );
}

/**
 * OpenAI's legacy text completions (RisuAI's `OpenAILegacyInstruct`):
 * `<base>/completions` with the bearer key, streamed as `choices[].text`, the
 * request's own stop strings kept here beside RisuAI's four, and every `##\n`
 * taken out of the reply as RisuAI does.
 */
function createAdapter(config: AdapterConfig): LLMAdapter {
  return {
    stream(request) {
      const req = withPresetParams(request, config.params);
      return watched(req, async function* (watch) {
        const response = await postJson(config, joinUrl(config.baseUrl, '/completions'), legacyCompletionsBody(req, config), { ...config.headers }, bearer(config), watch);
        return yield* readChatCompletionsStream(response, watch, new StopFilter([...LEGACY_STOPS, ...(req.stop ?? [])]), new Strip('##\n'));
      });
    },
  };
}

/** OpenAI's completion models are its instruct and base ones; any other address lists what it has. */
const COMPLETION_MODEL = /-instruct\b|^davinci-|^babbage-/;

async function listModels(config: CatalogConfig): Promise<ModelListing[]> {
  const models = await listOpenAIModels(config);
  return hostOf(config.baseUrl) === 'api.openai.com' ? models.filter((model) => COMPLETION_MODEL.test(model.id)) : models;
}

export const openAILegacy: ModelFormat = {
  id: 'openai-legacy',
  places: PLACES,
  key: 'required',
  defaultBaseUrl: 'https://api.openai.com/v1',
  reformat: REFORMAT,
  createAdapter,
  listModels,
};
