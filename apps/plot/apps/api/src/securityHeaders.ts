import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from './deps.js';

/**
 * What every answer of the API carries, refusals and errors included. The web
 * app reaches it through the `/api` rewrite, which passes these through, and
 * sets the page's own (apps/web/securityHeaders.ts).
 *
 * Nothing here is a page: the answers are JSON, a stream, or a stored file — a
 * card's picture, music or text attachment. So the policy grants nothing, and
 * `sandbox` keeps a file opened on its own from running anything on our origin
 * should one ever be served as a type that could.
 */
export function securityHeaders(): MiddlewareHandler<AppEnv> {
  const headers: [string, string][] = [
    ['X-Content-Type-Options', 'nosniff'],
    ['X-Frame-Options', 'DENY'],
    ['Referrer-Policy', 'strict-origin-when-cross-origin'],
    ['Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; sandbox"],
  ];
  return async (c, next) => {
    await next();
    for (const [name, value] of headers) c.res.headers.set(name, value);
  };
}
