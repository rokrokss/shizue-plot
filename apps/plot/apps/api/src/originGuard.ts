import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from './deps.js';

/**
 * The API answers only its own web app. Writes must carry the app's Origin (CSRF),
 * any request that does carry an Origin must carry that one, and a request the
 * Next rewrite forwarded must have reached the app under its own Host (DNS
 * rebinding). Top-level GET navigations carry no Origin, which is how the
 * ChatGPT sign-in callback arrives.
 */
export function originGuard(webOrigin: string): MiddlewareHandler<AppEnv> {
  const origin = new URL(webOrigin).origin;
  const webHost = new URL(webOrigin).host;
  return async (c, next) => {
    const requestOrigin = c.req.header('origin');
    // Next rewrites the upstream Host and overwrites this header with the original
    // browser-facing Host. Check it before trusting anything about the request.
    const forwardedHost = c.req.header('x-forwarded-host');
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method);
    if ((forwardedHost !== undefined && forwardedHost !== webHost) ||
      (requestOrigin !== undefined && requestOrigin !== origin) || (unsafe && requestOrigin !== origin)) {
      return c.json({ error: 'This API accepts requests only from its own web app.', code: 'foreign_origin' }, 403);
    }
    await next();
  };
}
