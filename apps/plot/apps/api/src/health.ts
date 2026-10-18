/**
 * The probe (ARCHITECTURE §10, §12 운영), mounted in front of the session
 * middleware so it never reads or writes a session row: `/api/health` is the
 * process answering at all, and touches nothing.
 */
import { Hono } from 'hono';
import type { AppEnv } from './deps.js';

export function healthRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get('/health', (c) => c.json({ status: 'ok' }));
  return app;
}
