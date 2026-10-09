import { ChatGPTError } from '@shizue/llm';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export interface ErrorBody {
  /** Developer-facing message (English). */
  error: string;
  /** Machine-readable code; clients translate on this. */
  code: string;
}

/** Application error carrying the HTTP status and the client-facing code. */
export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string): ApiError => new ApiError(400, code, message);
export const unauthorized = (): ApiError => new ApiError(401, 'unauthorized', 'Authentication required');
export const forbidden = (code: string, message: string): ApiError => new ApiError(403, code, message);
export const notFound = (message = 'Not found'): ApiError => new ApiError(404, 'not_found', message);

export function errorResponse(c: Context, error: unknown): Response {
  if (error instanceof ChatGPTError) {
    const status = error.status >= 400 && error.status <= 599 ? error.status as ContentfulStatusCode : 502;
    return c.json<ErrorBody>({ error: error.message, code: error.code }, status);
  }
  if (error instanceof ApiError) {
    return c.json<ErrorBody>({ error: error.message, code: error.code }, error.status);
  }
  if (error instanceof HTTPException) {
    const code = error.status === 413 ? 'payload_too_large' : 'http_error';
    return c.json<ErrorBody>({ error: error.message, code }, error.status as ContentfulStatusCode);
  }
  console.error('[api] unhandled error', error);
  return c.json<ErrorBody>({ error: 'Internal server error', code: 'internal_error' }, 500);
}
