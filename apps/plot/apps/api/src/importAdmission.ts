/**
 * Who may start a card or module import now (ARCHITECTURE §10 임포트 받아들이기,
 * §12). A card file is up to 1GB (`MAX_CARD_IMPORT_BYTES`), and that cap stays:
 * a cap that drops a card's content is a bug. What this bounds instead is how
 * many of them a process reads at once. Everything is decided before a byte of
 * the body is read — the route reads it only when it asks for the form:
 *
 * 1. The body must say its length (`Content-Length`) — 411 `length_required`.
 *    A browser's `FormData` upload always does, and the web's `/api` rewrite
 *    passes the header on. Node's parser holds the body to it, so the length is
 *    what will be read.
 * 2. The import bucket (`RATE_LIMITS.import`) — 429 `rate_limited`.
 * 3. One import at a time per reader, across instances: a lease
 *    (`import:<user id>`, `leases.ts`) renewed while the import runs and given
 *    back when it ends — 429 `import_busy`.
 * 4. This process's in-flight budget, `IMPORT_MEMORY_BUDGET_MB`: the import
 *    reserves its length times what an import was measured to hold per byte of
 *    it (`IMPORT_MEMORY_PER_BYTE`), and is refused — 503 `import_busy` with
 *    `Retry-After` — when that would pass the budget *and* another import is
 *    being read. One alone is always let in, whatever its size, so a 1GB card
 *    still imports on a quiet server.
 *
 * The budget is this process's on purpose: memory is per process, and so is
 * what it protects. It does not protect the web process in front of the API,
 * whose `/api` rewrite holds its own copy of the body (§10 바디 상한).
 */
import type { MiddlewareHandler } from 'hono';
import type { AppDeps, AppEnv } from './deps.js';
import type { ErrorBody } from './errors.js';
import { acquireLease, newLeaseHolder, releaseLease, renewLease } from './leases.js';
import { limitCaller, RATE_LIMITS } from './rateLimit.js';

/**
 * Peak memory an import adds per byte of its body, rounded up from the
 * measurement in §12 (5–6 over four runs): a 300MB charx of 30 pictures, read
 * whole by the multipart parse, copied out of it, unzipped into its pictures
 * and stored.
 */
export const IMPORT_MEMORY_PER_BYTE = 6;
/** The default of `IMPORT_MEMORY_BUDGET_MB`: a 250MB card's measured peak, or several small cards' at once. */
const DEFAULT_BUDGET_MB = 1536;
/** How long a reader's import lease stands without a renewal: what a crashed instance leaves them waiting. */
const LEASE_MS = 120_000;
/** A renewal every quarter of a lease, so a slow upload of a large file keeps it past a renewal that did not land. */
const RENEW_MS = 30_000;
/** What a refused import is told to wait: about what a small import takes. */
const BUSY_RETRY_AFTER_SECONDS = 10;

/** What the imports this process is reading have reserved, and how many there are. */
const reading = { bytes: 0, imports: 0 };

const budgetBytes = (env: NodeJS.ProcessEnv): number => {
  const megabytes = Number(env['IMPORT_MEMORY_BUDGET_MB']);
  return (Number.isFinite(megabytes) && megabytes > 0 ? megabytes : DEFAULT_BUDGET_MB) * 1024 * 1024;
};

/** Admission in front of an import route, behind `requireUser`. */
export function admitImport(deps: AppDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const length = c.req.header('content-length')?.trim();
    if (!length || !/^\d+$/.test(length)) {
      return c.json<ErrorBody>({ error: 'An import must state its Content-Length', code: 'length_required' }, 411);
    }
    const limited = await limitCaller(c, deps, RATE_LIMITS.import);
    if (limited) return limited;

    const key = `import:${c.get('userId')}`;
    const holder = newLeaseHolder();
    if (!(await acquireLease(deps.db, key, holder, LEASE_MS))) {
      return c.json<ErrorBody>({ error: 'Another import of yours is still running', code: 'import_busy' }, 429);
    }
    try {
      const reserve = Number(length) * IMPORT_MEMORY_PER_BYTE;
      if (reading.imports > 0 && reading.bytes + reserve > budgetBytes(deps.env)) {
        c.header('Retry-After', String(BUSY_RETRY_AFTER_SECONDS));
        return c.json<ErrorBody>({ error: 'The server is busy with other imports', code: 'import_busy' }, 503);
      }
      reading.bytes += reserve;
      reading.imports += 1;
      // A renewal that fails leaves the lease to expire, which is all a lost one costs.
      const renewal = setInterval(() => void renewLease(deps.db, key, holder, LEASE_MS).catch(() => undefined), RENEW_MS);
      renewal.unref();
      try {
        await next();
      } finally {
        clearInterval(renewal);
        reading.bytes -= reserve;
        reading.imports -= 1;
      }
    } finally {
      // One that cannot be given back expires on its own.
      await releaseLease(deps.db, key, holder).catch(() => undefined);
    }
  };
}
