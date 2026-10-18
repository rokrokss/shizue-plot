import { joinUrl, providerFailure, providerFetch, providerHttpError } from '../http.js';
import { applyExtras, applyParameters, withPresetParams, type ModelCapabilities, type ParameterPlaces } from '../params.js';
import { StopFilter } from '../stream.js';
import { speakerChunks } from '../stringlize.js';
import type { ChatRequest, LLMAdapter, StreamDone } from '../types.js';
import { CATALOG_TIMEOUT_MS, type AdapterConfig, type CatalogConfig, type ModelFormat, type ModelListing } from './format.js';
import { jsonOf, watched } from './send.js';
import { templatePrompt, whole } from './text.js';

/** The values Horde's workers take; RisuAI sends its temperature, top_k and top_p. */
const PLACES: ParameterPlaces = {
  temperature: 'params.temperature',
  topK: 'params.top_k',
  topP: 'params.top_p',
  topA: 'params.top_a',
  repetitionPenalty: 'params.rep_pen',
};
/** RisuAI's Horde models have no flags: every system turn goes as the user's. */
const REFORMAT: ModelCapabilities = { systemPrompt: 'none' };
/** The key anyone may use, which RisuAI sends when none is set. */
export const ANONYMOUS_KEY = '0000000000';
/** RisuAI's default context (`maxContext`), for a request that names none; Horde's own is far shorter. */
const DEFAULT_CONTEXT = 4000;
/** How often RisuAI asks whether a generation is done. */
export const POLL_MS = 2000;
const CLIENT_AGENT = 'shizue:1:https://shizue.net';

/**
 * RisuAI's `requestHorde` body: the templated prompt, the cap, the context a
 * worker must hold (the chat's and a hundred more), untrusted and slow workers
 * welcome, and the model in the four spellings RisuAI asks with — or any model
 * for `auto`. RisuAI's `workerslow_workers` was `slow_workers` mistyped.
 */
export function hordeBody(req: ChatRequest, config: Pick<AdapterConfig, 'capabilities' | 'params'>): Record<string, unknown> {
  const { prompt } = templatePrompt(req, config, REFORMAT);
  const model = req.model;
  const stop = (req.stop ?? []).filter((value) => value.trim());
  return applyParameters(
    {
      prompt,
      params: {
        n: 1,
        max_context_length: (req.contextTokens ?? DEFAULT_CONTEXT) + 100,
        max_length: req.maxTokens,
        singleline: false,
        ...(stop.length ? { stop_sequence: stop } : {}),
      },
      trusted_workers: false,
      slow_workers: true,
      dry_run: false,
      ...(model === 'auto' ? {} : { models: [model, model.trim(), ` ${model}`, `${model} `] }),
    },
    req,
    PLACES,
  );
}

interface HordeStatus {
  done?: boolean;
  faulted?: boolean;
  is_possible?: boolean;
  generations?: { text?: string }[];
}

/** The key a request goes with: the credential's, or the anonymous one. */
const keyOf = (config: Pick<AdapterConfig, 'access'>): string =>
  config.access.kind === 'key' && config.access.apiKey ? config.access.apiKey : ANONYMOUS_KEY;

/** A wait the caller's abort ends at once. */
const pause = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * AI Horde (RisuAI's `Horde` format): the request queued at
 * `<base>/v2/generate/text/async` (202 and an id) with the `apikey` header,
 * then its status asked every two seconds until a worker has done it. A request
 * no worker can serve is withdrawn and `provider_unavailable`; a stop withdraws
 * it too and goes out as the caller's abort. The reply is cut where another
 * speaker's line starts, as RisuAI's `unstringlizeChat` cuts it.
 */
function createAdapter(config: AdapterConfig): LLMAdapter {
  const fetcher = config.fetch ?? fetch;
  return {
    stream(request) {
      const req = withPresetParams(request, config.params);
      return watched(req, async function* (watch) {
        const body = hordeBody(req, config);
        const headers: Record<string, string> = { ...config.headers };
        applyExtras(body, headers, config.params);
        Object.assign(headers, { 'Content-Type': 'application/json', 'Client-Agent': CLIENT_AGENT, apikey: keyOf(config) });
        watch.arm();
        const queued = await providerFetch(fetcher, joinUrl(config.baseUrl, '/v2/generate/text/async'), {
          method: 'POST', signal: watch.signal, headers, body: JSON.stringify(body),
        });
        watch.disarm();
        if (!queued.ok) throw await providerHttpError(queued);
        const { id } = await jsonOf<{ id?: unknown }>(queued, watch);
        if (typeof id !== 'string' || !id) throw providerFailure('provider_invalid_stream', 502);
        const status = joinUrl(config.baseUrl, `/v2/generate/text/status/${encodeURIComponent(id)}`);
        const withdraw = (): void => {
          void providerFetch(fetcher, status, { method: 'DELETE', headers: { 'Client-Agent': CLIENT_AGENT, apikey: keyOf(config) } }).catch(() => {});
        };
        try {
          while (true) {
            await pause(POLL_MS, req.abortSignal);
            watch.arm();
            const polled = await providerFetch(fetcher, status, { signal: watch.signal, headers: { 'Client-Agent': CLIENT_AGENT } });
            watch.disarm();
            if (!polled.ok) throw await providerHttpError(polled);
            const state = await jsonOf<HordeStatus>(polled, watch);
            if (state.is_possible === false) throw providerFailure('provider_unavailable', 503, 'No Horde worker can serve this request');
            if (state.faulted) throw providerFailure('provider_unavailable', 502, 'The Horde request faulted');
            if (!state.done) continue;
            const text = state.generations?.[0]?.text;
            if (typeof text !== 'string') throw providerFailure('provider_unavailable', 502, 'The Horde request finished with no generation');
            yield* whole(text, new StopFilter([...speakerChunks(req.names?.char || 'Assistant', req.names?.user || 'User'), ...(req.stop ?? [])]));
            return { usage: { promptTokens: 0, completionTokens: 0 } } satisfies StreamDone;
          }
        } catch (error) {
          withdraw();
          throw error;
        }
      });
    },
  };
}

/** `GET <base>/v2/status/models?type=text`: the text models workers serve, most served first, after `auto` (any). */
async function listModels(config: CatalogConfig): Promise<ModelListing[]> {
  const response = await providerFetch(config.fetch ?? fetch, joinUrl(config.baseUrl, '/v2/status/models?type=text'), {
    headers: { ...config.headers, 'Client-Agent': CLIENT_AGENT }, signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  });
  if (!response.ok) throw await providerHttpError(response);
  const body = (await response.json().catch(() => null)) as unknown;
  if (!Array.isArray(body)) throw providerFailure('provider_invalid_stream', 502);
  const models = body
    .filter((entry): entry is { name: string; count?: unknown } => typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string')
    .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
    .map((entry) => ({ id: entry.name, label: entry.name }));
  return [{ id: 'auto', label: 'auto' }, ...models];
}

/** `GET <base>/v2/find_user` with the key: Horde's model list answers anyone. */
async function checkKey(config: CatalogConfig): Promise<void> {
  const response = await providerFetch(config.fetch ?? fetch, joinUrl(config.baseUrl, '/v2/find_user'), {
    headers: { ...config.headers, 'Client-Agent': CLIENT_AGENT, apikey: keyOf(config) }, signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  });
  if (!response.ok) throw await providerHttpError(response);
}

export const horde: ModelFormat = {
  id: 'horde',
  places: PLACES,
  key: 'optional',
  defaultBaseUrl: 'https://aihorde.net/api',
  reformat: REFORMAT,
  instructTemplate: true,
  createAdapter,
  listModels,
  checkKey,
};
