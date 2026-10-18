import { joinUrl, providerFailure, providerFetch, providerHttpError, redact } from '../http.js';
import { applyParameters, withPresetParams, type ModelCapabilities, type ParameterPlaces } from '../params.js';
import { StopFilter } from '../stream.js';
import { novelListPrompt, novelListReply, speakersOf, textTurns } from '../stringlize.js';
import type { ChatRequest, LLMAdapter, StreamDone } from '../types.js';
import { CATALOG_TIMEOUT_MS, type AdapterConfig, type CatalogConfig, type ModelFormat, type ModelListing } from './format.js';
import { bearer } from './openaiChat.js';
import { jsonOf, postJson, watched } from './send.js';
import { capabilitiesOf, whole } from './text.js';

/** The values NovelList takes, by its names. */
const PLACES: ParameterPlaces = {
  temperature: 'temperature',
  topP: 'top_p',
  topK: 'top_k',
  repetitionPenalty: 'rep_pen',
  topA: 'top_a',
};
/** RisuAI's NovelList models have no flags: every system turn goes as the user's. */
const REFORMAT: ModelCapabilities = { systemPrompt: 'none' };
/** RisuAI's NovelList settings (`defaultAIN`), which the preset's own values are laid over. */
const AIN = { top_p: 0.7, top_k: 140, rep_pen: 1.0625, top_a: 0.08, rep_pen_slope: 1.7, rep_pen_range: 1024, typical_p: 1.0, badwords: '' };

/**
 * RisuAI's `requestNovelList` body: NovelList's transcript (`novelListPrompt`),
 * the cap as `length`, the model, RisuAI's settings, and the stop tokens joined
 * by `<<|>>` — `「`, where the next speaker's quote would open, and the
 * request's own.
 */
export function novelListBody(req: ChatRequest, config: Pick<AdapterConfig, 'capabilities'>): Record<string, unknown> {
  const { char, user } = speakersOf(req);
  return applyParameters(
    {
      text: novelListPrompt(textTurns(req, capabilitiesOf(REFORMAT, config)), char, user),
      length: req.maxTokens,
      ...AIN,
      model: req.model,
      stoptokens: ['「', ...(req.stop ?? []).filter((value) => value.trim())].join('<<|>>'),
    },
    req,
    PLACES,
  );
}

/**
 * NovelList, the AI Novelist API (RisuAI's `NovelList` format):
 * `<base>/api` with the bearer key, answered whole as `data[0]` — or with an
 * `error` beside a 200 — and read back as the character's part
 * (`novelListReply`).
 */
function createAdapter(config: AdapterConfig): LLMAdapter {
  return {
    stream(request) {
      const req = withPresetParams(request, config.params);
      return watched(req, async function* (watch) {
        const { char, user } = speakersOf(req);
        const response = await postJson(config, joinUrl(config.baseUrl, '/api'), novelListBody(req, config), { ...config.headers }, bearer(config), watch);
        const body = await jsonOf<{ data?: unknown[]; error?: unknown }>(response, watch);
        if (body.error) throw providerFailure('provider_request_failed', 502, redact(String(body.error)));
        const output = body.data?.[0];
        if (typeof output !== 'string') throw providerFailure('provider_invalid_stream', 502);
        yield* whole(novelListReply(output, char, user), new StopFilter(req.stop));
        return { usage: { promptTokens: 0, completionTokens: 0 } } satisfies StreamDone;
      });
    },
  };
}

/** NovelList lists no models: the two RisuAI offers. */
const MODELS: ModelListing[] = [
  { id: 'supertrin', label: 'SuperTrin' },
  { id: 'damsel', label: 'Damsel' },
];

/** A one-character generation, which needs the key: the listing does not. */
async function checkKey(config: CatalogConfig): Promise<void> {
  const response = await providerFetch(config.fetch ?? fetch, joinUrl(config.baseUrl, '/api'), {
    method: 'POST',
    headers: { ...config.headers, 'Content-Type': 'application/json', ...bearer(config) },
    body: JSON.stringify({ text: '「', length: 1, model: MODELS[0]!.id }),
    signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  });
  if (!response.ok) throw await providerHttpError(response);
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  if (body?.error) throw providerFailure('provider_unauthorized', 401, redact(String(body.error)));
}

export const novelList: ModelFormat = {
  id: 'novellist',
  places: PLACES,
  key: 'required',
  defaultBaseUrl: 'https://api.tringpt.com',
  reformat: REFORMAT,
  createAdapter,
  listModels: async () => MODELS,
  checkKey,
};
