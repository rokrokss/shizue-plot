import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from './deps.js';
import { unauthorized } from './errors.js';

/**
 * The guard in front of everything a reader without an account may not have.
 *
 * `/api/*` resolves its session optionally (app.ts), so a route is public unless
 * this says otherwise — which is why it is mounted explicitly rather than by
 * default. Whole routers take it at their mount; the mixed ones (plots,
 * comments) take it route by route, since their reads are the public
 * catalogue and only their writes are not.
 *
 * It is also the reason `c.get('userId')` is a plain string: behind this guard a
 * session exists, and nothing else may read that variable.
 */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('viewerId') === null) throw unauthorized();
  await next();
};
