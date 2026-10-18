import { errorMessageOf, joinUrl, providerFailure, providerFetch, providerHttpError, redact } from '../http.js';
import { applyParameters, withPresetParams, type ModelCapabilities, type ParameterPlaces } from '../params.js';
import { eventJson, readSse, StopFilter } from '../stream.js';
import { novelAIPrompt, speakerChunks, speakersOf, textTurns } from '../stringlize.js';
import type { ChatRequest, LLMAdapter, StreamDone } from '../types.js';
import { CATALOG_TIMEOUT_MS, type AdapterConfig, type CatalogConfig, type ModelFormat, type ModelListing } from './format.js';
import { bearer } from './openaiChat.js';
import { postJson, watched } from './send.js';
import { capabilitiesOf } from './text.js';

/** The values NovelAI's samplers take, by its names under `parameters`. */
const PLACES: ParameterPlaces = {
  temperature: 'parameters.temperature',
  topK: 'parameters.top_k',
  topP: 'parameters.top_p',
  topA: 'parameters.top_a',
  repetitionPenalty: 'parameters.repetition_penalty',
  frequencyPenalty: 'parameters.repetition_penalty_frequency',
  presencePenalty: 'parameters.repetition_penalty_presence',
};
/** RisuAI's flag for its NovelAI models: system turns stand where they are. */
const REFORMAT: ModelCapabilities = {};

/** RisuAI's NovelAI preset (`prebuiltNAIpresets`), which the preset's own values are laid over. */
const PRESET = {
  top_k: 12,
  top_p: 0.85,
  top_a: 0.1,
  tail_free_sampling: 0.915,
  repetition_penalty: 2.8,
  repetition_penalty_range: 2048,
  repetition_penalty_slope: 0.02,
  repetition_penalty_frequency: 0.03,
  repetition_penalty_presence: 0,
  typical_p: 1,
};

/** RisuAI's `repetition_penalty_whitelist`: token ids of NovelAI's tokenizer the penalty spares (punctuation, digits, line breaks). */
const REPETITION_WHITELIST = [
  49256, 49264, 49231, 49230, 49287, 85, 49255, 49399, 49262, 336, 333, 432, 363, 468, 492, 745, 401, 426, 623, 794, 1096, 2919, 2072, 7379, 1259,
  2110, 620, 526, 487, 16562, 603, 805, 761, 2681, 942, 8917, 653, 3513, 506, 5301, 562, 5010, 614, 10942, 539, 2976, 462, 5189, 567, 2032, 123,
  124, 125, 126, 127, 128, 129, 130, 131, 132, 588, 803, 1040, 49209, 4, 5, 6, 7, 8, 9, 10, 11, 12,
];

/** RisuAI's `NovelAIBadWordIds`: token ids of NovelAI's tokenizer never generated (brackets and the like). */
const BAD_WORD_IDS = [
  60, 62, 544, 683, 696, 880, 905, 1008, 1019, 1084, 1092, 1181, 1184, 1254, 1447, 1570, 1656, 2194, 2470, 2479, 2498, 2947, 3138, 3291, 3455,
  3725, 3851, 3891, 3921, 3951, 4207, 4299, 4622, 4681, 5013, 5032, 5180, 5218, 5290, 5413, 5456, 5709, 5749, 5774, 6038, 6257, 6334, 6660, 6904,
  7082, 7086, 7254, 7444, 7748, 8001, 8088, 8168, 8562, 8605, 8795, 8850, 9014, 9102, 9259, 9318, 9336, 9502, 9686, 9793, 9855, 9899, 9955, 10148,
  10174, 10943, 11326, 11337, 11661, 12004, 12084, 12159, 12520, 12977, 13380, 13488, 13663, 13811, 13976, 14412, 14598, 14767, 15640, 15707,
  15775, 15830, 16079, 16354, 16369, 16445, 16595, 16614, 16731, 16943, 17278, 17281, 17548, 17555, 17981, 18022, 18095, 18297, 18413, 18736,
  18772, 18990, 19181, 20095, 20197, 20481, 20629, 20871, 20879, 20924, 20977, 21375, 21382, 21391, 21687, 21810, 21828, 21938, 22367, 22372,
  22734, 23405, 23505, 23734, 23741, 23781, 24237, 24254, 24345, 24430, 25416, 25896, 26119, 26635, 26842, 26991, 26997, 27075, 27114, 27468,
  27501, 27618, 27655, 27720, 27829, 28052, 28118, 28231, 28532, 28571, 28591, 28653, 29013, 29547, 29650, 29925, 30522, 30537, 30996, 31011,
  31053, 31096, 31148, 31258, 31350, 31379, 31422, 31789, 31830, 32214, 32666, 32871, 33094, 33376, 33440, 33805, 34368, 34398, 34417, 34418,
  34419, 34476, 34494, 34607, 34758, 34761, 34904, 34993, 35117, 35138, 35237, 35487, 35830, 35869, 36033, 36134, 36320, 36399, 36487, 36586,
  36676, 36692, 36786, 37077, 37594, 37596, 37786, 37982, 38475, 38791, 39083, 39258, 39487, 39822, 40116, 40125, 41000, 41018, 41256, 41305,
  41361, 41447, 41449, 41512, 41604, 42041, 42274, 42368, 42696, 42767, 42804, 42854, 42944, 42989, 43134, 43144, 43189, 43521, 43782, 44082,
  44162, 44270, 44308, 44479, 44524, 44965, 45114, 45301, 45382, 45443, 45472, 45488, 45507, 45564, 45662, 46265, 46267, 46275, 46295, 46462,
  46468, 46576, 46694, 47093, 47384, 47389, 47446, 47552, 47686, 47744, 47916, 48064, 48167, 48392, 48471, 48664, 48701, 49021, 49193, 49236,
  49550, 49694, 49806, 49824, 50001, 50256, 0, 1, 3, 49356, 1431, 31715, 34387, 20765, 30702, 10691, 49333, 1266, 19438, 43145, 26523, 41471,
  2936, 23,
].map((id) => [id]);

/**
 * RisuAI's `requestNovelAI` body: NovelAI's transcript (`novelAIPrompt`), the
 * model, and RisuAI's parameters — its fixed ones (the sampler order, string
 * in and out, the whitelist, bad words and stop tokens, no CFG or Mirostat)
 * and its preset, with the preset's own values over them.
 */
export function novelAIBody(req: ChatRequest, config: Pick<AdapterConfig, 'capabilities'>): Record<string, unknown> {
  const { char, user } = speakersOf(req);
  return applyParameters(
    {
      input: novelAIPrompt(textTurns(req, capabilitiesOf(REFORMAT, config)), char, user),
      model: req.model,
      parameters: {
        ...PRESET,
        max_length: req.maxTokens,
        min_length: 1,
        generate_until_sentence: true,
        use_cache: false,
        use_string: true,
        return_full_text: false,
        prefix: 'vanilla',
        order: [6, 2, 3, 0, 4, 1, 5, 8],
        repetition_penalty_whitelist: REPETITION_WHITELIST,
        stop_sequences: [[49287], [49405]],
        bad_words_ids: BAD_WORD_IDS,
        logit_bias_exp: [],
        mirostat_lr: 1,
        mirostat_tau: 0,
        cfg_scale: 1,
        cfg_uc: '',
      },
    },
    req,
    PLACES,
  );
}

const invalid = () => providerFailure('provider_invalid_stream', 502);

/**
 * NovelAI's text generation (RisuAI's `NovelAI` format), streamed:
 * `<base>/ai/generate-stream` with the bearer token, whose events carry the
 * reply a `token` at a time until one marked `final`. The reply is cut where
 * another speaker's line starts, as RisuAI's `unstringlizeChat` cuts it.
 */
function createAdapter(config: AdapterConfig): LLMAdapter {
  return {
    stream(request) {
      const req = withPresetParams(request, config.params);
      return watched(req, async function* (watch) {
        const { char, user } = speakersOf(req);
        const response = await postJson(config, joinUrl(config.baseUrl, '/ai/generate-stream'), novelAIBody(req, config), { ...config.headers }, bearer(config), watch);
        if (!response.body) throw providerFailure('provider_stream_interrupted', 502);
        const stop = new StopFilter([...speakerChunks(char, user), ...(req.stop ?? [])]);
        for await (const block of readSse(response.body, watch, { invalid })) {
          const event = eventJson<{ token?: unknown; final?: unknown; error?: unknown; message?: unknown }>(block.data, invalid);
          if (event.error) throw providerFailure('provider_unavailable', 502, redact(errorMessageOf(event)));
          if (typeof event.token === 'string' && event.token) {
            const out = stop.push(event.token);
            if (out) yield { type: 'text', text: out };
          }
          if (event.final === true) {
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

/** NovelAI lists no models: the two RisuAI offers. */
const MODELS: ModelListing[] = [
  { id: 'kayra-v1', label: 'Kayra' },
  { id: 'clio-v1', label: 'Clio' },
];

/** A one-token generation, which needs the token (`/ai/generate`); text generation costs a subscriber nothing. */
async function checkKey(config: CatalogConfig): Promise<void> {
  const response = await providerFetch(config.fetch ?? fetch, joinUrl(config.baseUrl, '/ai/generate'), {
    method: 'POST',
    headers: { ...config.headers, 'Content-Type': 'application/json', ...bearer(config) },
    body: JSON.stringify({ input: '⁂', model: MODELS[0]!.id, parameters: { max_length: 1, min_length: 1, use_string: true } }),
    signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  });
  if (!response.ok) throw await providerHttpError(response);
}

export const novelAI: ModelFormat = {
  id: 'novelai',
  places: PLACES,
  key: 'required',
  defaultBaseUrl: 'https://text.novelai.net',
  reformat: REFORMAT,
  createAdapter,
  listModels: async () => MODELS,
  checkKey,
};
