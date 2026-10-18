import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from './deps.js';

/**
 * The API answers only its own web app. Writes must carry the app's Origin (CSRF),
 * any request that does carry an Origin must carry that one, and a request a
 * proxy in front forwarded (Tailscale Serve says so in `x-forwarded-host`) must
 * have reached the app under one of its own hosts (DNS rebinding) — a request's
 * own `Host` is the owner gate's to hold (`isLocalRequest`). Top-level GET
 * navigations carry no Origin, which is how the ChatGPT connection's callback
 * arrives.
 *
 * The app may be reached at more than one origin — `remoteOrigins`, a tunnel to
 * this machine for a phone — and each counts as the app's own. They are read on
 * every request, since the settings page opens and closes the tunnel while the
 * API runs (`tunnel.ts`).
 */
export function originGuard(
  webOrigin: string,
  remoteOrigins: readonly string[] | (() => readonly string[]) = [],
): MiddlewareHandler<AppEnv> {
  const others = typeof remoteOrigins === 'function' ? remoteOrigins : () => remoteOrigins;
  return async (c, next) => {
    const origins = new Set([webOrigin, ...others()].map((value) => new URL(value).origin));
    const hosts = new Set([...origins].map((value) => new URL(value).host));
    const requestOrigin = c.req.header('origin');
    // A proxy in front writes the browser-facing Host here. Check it before
    // trusting anything about the request.
    const forwardedHost = c.req.header('x-forwarded-host');
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method);
    if ((forwardedHost !== undefined && !hosts.has(forwardedHost)) ||
      (requestOrigin !== undefined && !origins.has(requestOrigin)) || (unsafe && requestOrigin === undefined)) {
      return c.json({ error: 'This API accepts requests only from its own web app.', code: 'foreign_origin' }, 403);
    }
    await next();
  };
}
