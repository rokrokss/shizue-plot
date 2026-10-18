import { providerFailure, providerFetch, providerHttpError } from '../http.js';
import { applyExtras } from '../params.js';
import { IdleWatch } from '../stream.js';
import type { ChatRequest, StreamDelta } from '../types.js';
import type { AdapterConfig } from './format.js';

/**
 * What the formats' adapters share in sending a request: one JSON POST under the
 * idle watch, and the watch itself around a whole reply.
 */

/**
 * One POST of a format's body as JSON, under the idle watch: the headers the
 * format built, the preset's additional parameters over the body and beside the
 * headers, and the credential's own headers written last so a preset cannot
 * replace them. A refusal is the provider's typed error.
 */
export async function postJson(
  config: Pick<AdapterConfig, 'fetch' | 'params'>,
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  auth: Record<string, string>,
  watch: IdleWatch,
): Promise<Response> {
  const sent = { ...headers };
  applyExtras(body, sent, config.params);
  Object.assign(sent, { 'Content-Type': 'application/json' }, auth);
  watch.arm();
  const response = await providerFetch(config.fetch ?? fetch, url, { method: 'POST', signal: watch.signal, headers: sent, body: JSON.stringify(body) });
  watch.disarm();
  if (!response.ok) throw await providerHttpError(response);
  return response;
}

/**
 * A reply under the request's idle watch: a stream gone quiet is
 * `provider_timeout`, and the caller's own abort goes out as it came — which is
 * how a stop is told from a failure.
 */
export async function* watched<T>(
  req: Pick<ChatRequest, 'abortSignal'>,
  run: (watch: IdleWatch) => AsyncGenerator<StreamDelta, T>,
): AsyncGenerator<StreamDelta, T> {
  const watch = new IdleWatch(req.abortSignal);
  try {
    return yield* run(watch);
  } catch (error) {
    if (watch.timedOut) throw providerFailure('provider_timeout', 504);
    throw error;
  } finally {
    watch.disarm();
  }
}

/** A JSON reply body, or `provider_invalid_stream`: a provider that answers with something else is not speaking this format. */
export async function jsonOf<T>(response: Response, watch: IdleWatch): Promise<T> {
  watch.arm();
  try {
    return (await response.json()) as T;
  } catch (error) {
    if (watch.signal.aborted) throw error;
    throw providerFailure('provider_invalid_stream', 502);
  } finally {
    watch.disarm();
  }
}
