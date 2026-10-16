/**
 * The probes (ARCHITECTURE §10, §12 운영), mounted in front of the session
 * middleware so a probe never reads or writes a session row. `/api/health` is
 * the process answering at all, and touches nothing. `/api/ready` is whether
 * readers should be sent here: not once a shutdown has begun (`deps.draining`),
 * and not while the database leaves a `select 1` unanswered past `READY_DB_MS`.
 */
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppDeps, AppEnv } from './deps.js';

const READY_DB_MS = 2_000;

export function healthRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.get('/ready', async (c) => {
    if (deps.draining) return c.json({ status: 'draining' }, 503);
    return (await databaseAnswers(deps)) ? c.json({ status: 'ready' }) : c.json({ status: 'db_unavailable' }, 503);
  });
  return app;
}

/** A `select 1` answered in time; a refused or slow one (a full pool, a database going away) is not. */
async function databaseAnswers(deps: AppDeps): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      deps.db.execute(sql`select 1`).then(() => true),
      new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), READY_DB_MS))),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
