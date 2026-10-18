import { providerFailure } from '../http.js';
import { applyParameters, withPresetParams, type ModelCapabilities, type ParameterPlaces } from '../params.js';
import { eventJson, readSse, StopFilter } from '../stream.js';
import { LLMError, type ChatRequest, type LLMAdapter, type StreamDone } from '../types.js';
import type { AdapterConfig, ModelFormat } from './format.js';
import { bearer } from './openaiChat.js';
import { loadedModel } from './ooba.js';
import { jsonOf, postJson, watched } from './send.js';
import { serverRoot, templatePrompt } from './text.js';

/** RisuAI's Kobold parameters, `repetition_penalty` as Kobold's `rep_pen`. */
const PLACES: ParameterPlaces = {
  temperature: 'temperature',
  topP: 'top_p',
  repetitionPenalty: 'rep_pen',
  topK: 'top_k',
  topA: 'top_a',
};
/** RisuAI's flags for its Kobold model: one system prompt, first. */
const REFORMAT: ModelCapabilities = { systemPrompt: 'first' };

/**
 * RisuAI's `requestKobold` body: the templated prompt, the cap as
 * `max_length`, the chat's context as `max_context_length` where the request
 * has one, one generation, and the request's stop strings.
 */
export function koboldBody(req: ChatRequest, config: Pick<AdapterConfig, 'capabilities' | 'params'>): Record<string, unknown> {
  const { prompt } = templatePrompt(req, config, REFORMAT);
  const stop = (req.stop ?? []).filter((value) => value.trim());
  return applyParameters(
    {
      prompt,
      max_length: req.maxTokens,
      ...(req.contextTokens ? { max_context_length: req.contextTokens } : {}),
      n: 1,
      ...(stop.length ? { stop_sequence: stop } : {}),
    },
    req,
    PLACES,
  );
}

const invalid = () => providerFailure('provider_invalid_stream', 502);

/**
 * KoboldAI and KoboldCpp: KoboldCpp's stream (`<root>/api/extra/generate/stream`,
 * SSE of `{token}` pieces, done at the body's end) where the server has it, and
 * otherwise — a 404 there — the generate API RisuAI uses
 * (`<root>/api/v1/generate`, `results[0].text` whole). A KoboldCpp password goes
 * as a bearer key.
 */
function createAdapter(config: AdapterConfig): LLMAdapter {
  return {
    stream(request) {
      const req = withPresetParams(request, config.params);
      return watched(req, async function* (watch) {
        const root = serverRoot(config.baseUrl);
        const body = koboldBody(req, config);
        const stop = new StopFilter(req.stop);
        let response: Response;
        try {
          response = await postJson(config, `${root}/api/extra/generate/stream`, body, { ...config.headers }, bearer(config), watch);
        } catch (error) {
          if (!(error instanceof LLMError && error.code === 'provider_not_found')) throw error;
          const blocking = await postJson(config, `${root}/api/v1/generate`, body, { ...config.headers }, bearer(config), watch);
          const result = await jsonOf<{ results?: { text?: unknown }[] }>(blocking, watch);
          const text = result.results?.[0]?.text;
          if (typeof text !== 'string') throw invalid();
          const out = stop.push(text) + stop.flush();
          if (out) yield { type: 'text', text: out };
          return { usage: { promptTokens: 0, completionTokens: 0 } } satisfies StreamDone;
        }
        if (!response.body) throw providerFailure('provider_stream_interrupted', 502);
        for await (const block of readSse(response.body, watch, { invalid })) {
          const event = eventJson<{ token?: unknown }>(block.data, invalid);
          if (typeof event.token === 'string' && event.token) {
            const out = stop.push(event.token);
            if (out) yield { type: 'text', text: out };
          }
        }
        const rest = stop.flush();
        if (rest) yield { type: 'text', text: rest };
        return { usage: { promptTokens: 0, completionTokens: 0 } } satisfies StreamDone;
      });
    },
  };
}

export const kobold: ModelFormat = {
  id: 'kobold',
  places: PLACES,
  key: 'optional',
  defaultBaseUrl: 'http://localhost:5001',
  reformat: REFORMAT,
  instructTemplate: true,
  createAdapter,
  listModels: (config) => loadedModel(config, bearer(config)),
};
