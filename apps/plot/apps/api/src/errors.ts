import { ChatGPTError } from '@shizue/llm';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { routePath } from 'hono/route';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { requestContext } from './log.js';

export interface ErrorBody {
  /** Developer-facing message (English). */
  error: string;
  /** Machine-readable code; clients translate on this. */
  code: string;
  /** Numbers the translated message reads, where it has any (`prompt_too_long`'s tokens and limit). */
  params?: Record<string, number>;
}

/** Application error carrying the HTTP status and the client-facing code. */
export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly params?: Record<string, number>,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string, params?: Record<string, number>): ApiError =>
  new ApiError(400, code, message, params);
export const unauthorized = (): ApiError => new ApiError(401, 'unauthorized', 'Authentication required');
export const forbidden = (code: string, message: string): ApiError => new ApiError(403, code, message);
export const notFound = (message = 'Not found'): ApiError => new ApiError(404, 'not_found', message);

export function errorResponse(c: Context, error: unknown): Response {
  if (error instanceof ChatGPTError) {
    const status = error.status >= 400 && error.status <= 599 ? error.status as ContentfulStatusCode : 502;
    return c.json<ErrorBody>({ error: error.message, code: error.code }, status);
  }
  if (error instanceof ApiError) {
    return c.json<ErrorBody>(
      { error: error.message, code: error.code, ...(error.params ? { params: error.params } : {}) },
      error.status,
    );
  }
  if (error instanceof HTTPException) {
    const code = error.status === 413 ? 'payload_too_large' : 'http_error';
    return c.json<ErrorBody>({ error: error.message, code }, error.status as ContentfulStatusCode);
  }
  const requestId = requestContext.getStore()?.requestId ?? 'unknown';
  console.error(`[api] unhandled error in ${c.req.method} ${routePath(c)} (request ${requestId})`, error);
  return c.json<ErrorBody>({ error: 'Internal server error', code: 'internal_error' }, 500);
}
