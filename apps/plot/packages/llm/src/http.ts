import { LLMError } from './types.js';

/** Messages for the provider codes, in English for the log and the API's `error`; the page translates the code. */
const MESSAGES: Record<string, string> = {
  provider_unauthorized: 'The model provider refused the key.',
  provider_quota: 'The model provider says the account has no credit left.',
  provider_rate_limited: 'The model provider is limiting requests. Try again shortly.',
  provider_bad_request: 'The model provider refused the request.',
  provider_not_found: 'The model provider does not know this model or address.',
  provider_unavailable: 'The model provider is not answering. Try again later.',
  provider_unreachable: 'The model server could not be reached.',
  provider_timeout: 'The model stopped responding.',
  provider_stream_interrupted: 'The connection to the model ended before the reply did.',
  provider_invalid_stream: "The model's reply could not be read.",
  provider_refused: 'The model provider declined to answer.',
  provider_request_failed: 'The model provider could not answer this request.',
  credential_required: 'This model preset needs a key.',
  endpoint_required: 'This model preset needs an address.',
  credential_format_mismatch: "This key does not speak the model preset's format.",
  format_unavailable: 'This model format is not available.',
};

export const providerFailure = (code: string, status: number, detail?: string): LLMError =>
  new LLMError(code, MESSAGES[code] ?? MESSAGES['provider_request_failed']!, status, detail);

/** The code a provider's HTTP status is told as. */
export function codeForStatus(status: number): string {
  if (status === 401 || status === 403) return 'provider_unauthorized';
  if (status === 402) return 'provider_quota';
  if (status === 429) return 'provider_rate_limited';
  if (status === 404) return 'provider_not_found';
  if (status === 400 || status === 409 || status === 413 || status === 422) return 'provider_bad_request';
  if (status >= 500) return 'provider_unavailable';
  return 'provider_request_failed';
}

/**
 * A provider's own words, for the server's log: what looks like a key — a long
 * run of key characters, an `sk-…` or `AIza…` — goes, and so does all but the
 * first 300 characters. Providers echo a key back (OpenAI's "Incorrect API key
 * provided: sk-…"), and the log is not where it should land whole.
 */
export function redact(text: string): string {
  return text
    .replace(/\b(?:sk|rk|pk|gsk|xai|AIza|AQ)[-_.A-Za-z0-9]{8,}/g, '[redacted]')
    .replace(/[A-Za-z0-9_\-+/=]{32,}/g, '[redacted]')
    .slice(0, 300);
}

/** The message of a provider's error body, in the shapes OpenAI, Anthropic and Google use. */
export function errorMessageOf(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const fields = body as { error?: unknown; message?: unknown; detail?: unknown };
  if (typeof fields.error === 'string') return fields.error;
  if (fields.error && typeof fields.error === 'object') {
    const message = (fields.error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  if (typeof fields.message === 'string') return fields.message;
  if (typeof fields.detail === 'string') return fields.detail;
  return '';
}

/** A provider's refusal as a typed error: its status decides the code; its words go to `detail`, redacted. */
export async function providerHttpError(response: Response): Promise<LLMError> {
  const text = await response.text().catch(() => '');
  let message = '';
  try {
    message = errorMessageOf(JSON.parse(text));
  } catch {
    message = text;
  }
  return providerFailure(codeForStatus(response.status), response.status, redact(message));
}

/**
 * `fetch` that tells a server nobody answers at (a local model not running, a
 * name that does not resolve) as `provider_unreachable`. The caller's own abort
 * goes out as it came, which is how a stop is told from a failure.
 */
export async function providerFetch(fetcher: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetcher(url, init);
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw providerFailure('provider_unreachable', 502, redact(error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? '')}` : ''));
  }
}

/** A URL under `base`: `base` without its trailing slashes, then `path`. */
export const joinUrl = (base: string, path: string): string => `${base.replace(/\/+$/, '')}${path}`;
