/**
 * Thin fetch wrapper for the Hono API. Requests go to the same origin, where the
 * app's one process hands `/api/*` to the API; the API owns the local ChatGPT session.
 */

/** Mirrors the API error body `{error, code, params?}`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Numbers the code's translation reads (`prompt_too_long`'s tokens and limit). */
    readonly params?: Record<string, number>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function toApiError(res: Response): Promise<ApiError> {
  let error = res.statusText || 'Request failed';
  let code = 'unknown';
  let params: Record<string, number> | undefined;
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object') {
      const fields = body as Record<string, unknown>;
      if (typeof fields['error'] === 'string') error = fields['error'];
      if (typeof fields['code'] === 'string') code = fields['code'];
      params = errorParams(fields['params']);
    }
  } catch {
    // Non-JSON body (proxy failure, HTML error page): keep the generic code.
  }
  return new ApiError(res.status, code, error, params);
}

/** An error payload's `params`, keeping only the numbers a translation can read. */
export function errorParams(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const numbers = Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === 'number');
  return numbers.length > 0 ? Object.fromEntries(numbers) : undefined;
}

async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function apiGet<T>(
  path: string,
  signal?: AbortSignal,
  headers: Record<string, string> = {},
): Promise<T> {
  return parse<T>(
    await fetch(path, {
      ...(signal ? { signal } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    }),
  );
}

/**
 * The reader's IANA time zone, for the clock macros the server expands a turn or
 * an opening with — empty where the runtime cannot say, and the server reads
 * UTC — and the language the page is read in (`<html lang>`), which decides a
 * chat's language mode where the reader has not picked one (§6 언어 모드).
 */
export function readerHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone) headers['x-shizue-tz'] = zone;
  } catch {
    // No zone: the server reads UTC.
  }
  const locale = typeof document === 'undefined' ? '' : document.documentElement.lang;
  if (locale) headers['x-shizue-locale'] = locale;
  return headers;
}

export async function apiSend<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  headers: Record<string, string> = {},
): Promise<T> {
  const sent = body === undefined ? headers : { ...headers, 'content-type': 'application/json' };
  return parse<T>(
    await fetch(path, {
      method,
      ...(signal ? { signal } : {}),
      ...(Object.keys(sent).length > 0 ? { headers: sent } : {}),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

export async function apiDelete(path: string): Promise<void> {
  return apiSend<void>('DELETE', path);
}

export async function apiUpload<T>(
  path: string,
  file: File,
  fields: Record<string, string> = {},
): Promise<T> {
  const form = new FormData();
  form.append('file', file);
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return parse<T>(await fetch(path, { method: 'POST', body: form }));
}
