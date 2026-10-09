/**
 * Thin fetch wrapper for the Hono API. Requests go to the same origin and are
 * proxied by the Next `rewrites()` rule; the API owns the local ChatGPT session.
 */

/** Mirrors the API error body `{error, code}`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function toApiError(res: Response): Promise<ApiError> {
  let error = res.statusText || 'Request failed';
  let code = 'unknown';
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object') {
      const fields = body as Record<string, unknown>;
      if (typeof fields['error'] === 'string') error = fields['error'];
      if (typeof fields['code'] === 'string') code = fields['code'];
    }
  } catch {
    // Non-JSON body (proxy failure, HTML error page): keep the generic code.
  }
  return new ApiError(res.status, code, error);
}

async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  return parse<T>(await fetch(path, signal ? { signal } : {}));
}

export async function apiSend<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  return parse<T>(
    await fetch(path, {
      method,
      ...(signal ? { signal } : {}),
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
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
