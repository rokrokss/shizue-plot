/**
 * Short exclusivity across API instances, on the `leases` table (§5): one
 * holder per key until the lease expires. Postgres and nothing else, as the
 * owner decided (2026-10-16), so it holds however many instances there are.
 *
 * The holder is the fence. A lease is taken from nobody or from a holder whose
 * time ran out, never from a live one, and it is renewed and released only by
 * the holder that took it — so an instance that lost its lease to a takeover
 * while it was still working cannot extend, or free, the new holder's. One that
 * dies leaves its lease to expire, the convention `jobs.locked_at` and
 * `chats.generating_at` already keep. The clock is the database's, `now()`, so
 * instances whose own clocks drift still agree on when a lease ran out.
 */
import { leases, type Db } from '@shizue/db';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

const expiry = (ttlMs: number) => sql`now() + ${Math.ceil(ttlMs)}::int * interval '1 millisecond'`;

/** A holder nobody else can be: this process (diagnostic) and one acquisition of it. */
export const newLeaseHolder = (): string => `${hostname()}:${process.pid}:${randomUUID()}`;

/**
 * Takes `key` for `ttlMs` when nobody holds it or its lease has expired, in one
 * statement: two instances asking at the same moment cannot both get it. Whether
 * `holder` got it; a live lease — `holder`'s own included — is not taken.
 */
export async function acquireLease(db: Db, key: string, holder: string, ttlMs: number): Promise<boolean> {
  const taken = await db
    .insert(leases)
    .values({ key, holder, expiresAt: expiry(ttlMs) })
    .onConflictDoUpdate({
      target: leases.key,
      set: { holder: sql`excluded.holder`, expiresAt: sql`excluded.expires_at` },
      setWhere: sql`${leases.expiresAt} <= now()`,
    })
    .returning({ key: leases.key });
  return taken.length > 0;
}

/** Pushes `holder`'s lease on `key` out to `ttlMs` from now. False when it is no longer theirs. */
export async function renewLease(db: Db, key: string, holder: string, ttlMs: number): Promise<boolean> {
  const renewed = await db
    .update(leases)
    .set({ expiresAt: expiry(ttlMs) })
    .where(and(eq(leases.key, key), eq(leases.holder, holder)))
    .returning({ key: leases.key });
  return renewed.length > 0;
}

/** Gives `key` back — only if `holder` still holds it, so a late release frees nobody else's. */
export async function releaseLease(db: Db, key: string, holder: string): Promise<void> {
  await db.delete(leases).where(and(eq(leases.key, key), eq(leases.holder, holder)));
}
