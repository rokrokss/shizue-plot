import { LLMError, type LLMAdapter, type StreamDelta, type StreamDone } from './types.js';

/** PocketRisu's `requestRetrys` default: a failed request is sent again twice. */
export const REQUEST_RETRIES = 2;

/**
 * Failures another try cannot change: a preset that cannot be sent (no key, a
 * key of another format, no address, a template that does not apply), and a
 * provider that went quiet for the whole idle window — five more minutes of
 * silence would only keep the reader waiting.
 */
const FINAL = new Set([
  'credential_required',
  'credential_format_mismatch',
  'endpoint_required',
  'format_unavailable',
  'template_invalid',
  'template_failed',
  'provider_timeout',
]);
/** RisuAI's `failByServerError`: a busy or failing server gets a second's rest before the next try. */
const SERVER = new Set(['provider_rate_limited', 'provider_unavailable', 'provider_unreachable']);

const rest = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

/**
 * PocketRisu's request loop (`requestChatData`, `src/ts/process/request/request.ts`)
 * for a profile preset: a request that fails is sent again, up to `retries`
 * more times — PocketRisu's preset requests go whole, so a try fails or
 * answers, and here a try is one that failed before the stream gave anything.
 * Once the reply has begun, a failure ends it as it would have (what arrived is
 * the caller's to keep or drop). The caller's stop is never tried again.
 */
export function retryingAdapter(adapter: LLMAdapter, retries = REQUEST_RETRIES, wait = rest): LLMAdapter {
  return {
    async *stream(request): AsyncGenerator<StreamDelta, StreamDone> {
      for (let attempt = 0; ; attempt += 1) {
        const stream = adapter.stream(request);
        let first: IteratorResult<StreamDelta, StreamDone>;
        try {
          first = await stream.next();
        } catch (error) {
          const final = request.abortSignal?.aborted || !(error instanceof LLMError) || FINAL.has(error.code);
          if (final || attempt >= retries) throw error;
          console.warn(`[models] ${error.code} (${error.status}); sending again (${attempt + 1} of ${retries})${error.detail ? `: ${error.detail}` : ''}`);
          if (SERVER.has(error.code)) await wait(1000, request.abortSignal);
          if (request.abortSignal?.aborted) throw error;
          continue;
        }
        if (first.done) return first.value;
        yield first.value;
        return yield* stream;
      }
    },
  };
}
