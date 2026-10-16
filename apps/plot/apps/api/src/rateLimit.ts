/**
 * Request rate limits (ARCHITECTURE §10 요청 한도): fixed windows counted in
 * Postgres (`rate_limits`, §5), so every API instance counts against the same
 * window — the owner keeps no Redis (2026-10-16).
 *
 * Only the expensive or abusable routes carry a bucket (`RATE_LIMITS`), never
 * every GET, and each is sized well past what its fastest legitimate client
 * sends: the SillyTavern import wizard and the paste migration are sequential,
 * one request after the other, and a chat import's batches and attachments are
 * not counted at all — its start is, and each chat holds a bounded number of
 * them. A refusal is 429 `rate_limited` with `Retry-After`.
 *
 * A hit is one upsert that returns the new count and the window's start, and a
 * window starts again on the first hit after it has run out. Every hit is
 * counted, the refused ones too; that only keeps a caller refused until the
 * window ends, which it would be anyway. The clock is the caller's (`at`) rather
 * than the database's: Lua `request` keeps RisuAI's clock-driven window
 * (`scriptFetch.ts`) and its tests drive that clock. Rows long past any window
 * are collected by the hits that open a new one, a capped batch each, as
 * `feedCursor.ts` collects walks — there is no background loop.
 */
import { rateLimits, type Db } from '@shizue/db';
import { and, inArray, lt, sql } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import type { AppDeps, AppEnv } from './deps.js';
import type { ErrorBody } from './errors.js';
import { v6Words } from './scriptFetch.js';

const MINUTE = 60_000;

/** How many hits a window lets through; the next one in it is refused. */
export interface RateWindow {
  limit: number;
  windowMs: number;
}

export interface RateBucket extends RateWindow {
  /** The key's first part: which limit this is. */
  name: string;
  /** Whom a window counts: the signed-in user (behind `requireUser`), or the client's address. */
  by: 'user' | 'ip';
}

/**
 * The buckets, ten minutes each. What sized them (§10 요청 한도): sign-in starts
 * are a click or two per sign-in, from addresses a household or an office may
 * share; a generation takes seconds to stream and a group round asks for at
 * most ten; the wizard imports one card at a time and a chat import's start is
 * followed by at least a batch and a completion, so neither goes faster than
 * one a second; the paste migration uploads at most 110 pictures in a row.
 */
export const RATE_LIMITS = {
  /** `POST /api/chatgpt/sign-in`: unauthenticated, and it writes a verification row. */
  signIn: { name: 'sign_in', by: 'ip', limit: 30, windowMs: 10 * MINUTE },
  /** The six SSE generation starts (`messages`, `regenerate`, `continue`, `auto`, `narrate`, `reply`). */
  generation: { name: 'generation', by: 'user', limit: 300, windowMs: 10 * MINUTE },
  /** Starting a card or module file import (`POST /api/file-imports`). */
  import: { name: 'import', by: 'user', limit: 600, windowMs: 10 * MINUTE },
  /** A chat brought over from another app: `POST /api/chats/import`, not its batches or attachments. */
  chatImport: { name: 'chat_import', by: 'user', limit: 600, windowMs: 10 * MINUTE },
  /** Avatars, covers, plot assets, persona pictures and the composer's attachments. */
  upload: { name: 'upload', by: 'user', limit: 300, windowMs: 10 * MINUTE },
  comment: { name: 'comment', by: 'user', limit: 60, windowMs: 10 * MINUTE },
  /** Likes and follows, given and taken back. */
  social: { name: 'social', by: 'user', limit: 300, windowMs: 10 * MINUTE },
  /** A plot created, pasted over (`migrate`) or published and taken back. */
  plots: { name: 'plots', by: 'user', limit: 120, windowMs: 10 * MINUTE },
} as const satisfies Record<string, RateBucket>;

/** A row whose window started this long ago is past every bucket's window. */
const DEAD_AFTER_MS = 24 * 60 * MINUTE;
/** Dead rows collected per window opened: a backlog only ever shrinks, and no hit pays for all of it. */
const COLLECT_BATCH = 50;

export interface RateHit {
  allowed: boolean;
  /** Hits in this window, this one included. */
  hits: number;
  windowStart: Date;
  /** Whole seconds until the window runs out, at least one. */
  retryAfterSeconds: number;
}

/**
 * Counts one hit on `key`: one statement takes it, starting the window again
 * when the stored one ran out before `at` — strictly before, so at exactly the
 * window's length it still holds, as RisuAI's does.
 */
export async function hitRateLimit(db: Db, key: string, window: RateWindow, at: Date = new Date()): Promise<RateHit> {
  const expired = sql`${rateLimits.windowStart} + ${window.windowMs}::int * interval '1 millisecond' < excluded.window_start`;
  const [row] = await db
    .insert(rateLimits)
    .values({ key, windowStart: at, hits: 1 })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        windowStart: sql`case when ${expired} then excluded.window_start else ${rateLimits.windowStart} end`,
        hits: sql`case when ${expired} then 1 else ${rateLimits.hits} + 1 end`,
      },
    })
    .returning({ hits: rateLimits.hits, windowStart: rateLimits.windowStart });
  if (row!.hits === 1) await collectDead(db, at);
  const remaining = row!.windowStart.getTime() + window.windowMs - at.getTime();
  return {
    allowed: row!.hits <= window.limit,
    hits: row!.hits,
    windowStart: row!.windowStart,
    retryAfterSeconds: Math.max(1, Math.ceil(remaining / 1000)),
  };
}

/** Deletes a capped batch of windows that ended long ago; a row a hit just reset is not among them. */
async function collectDead(db: Db, at: Date): Promise<void> {
  const cutoff = new Date(at.getTime() - DEAD_AFTER_MS);
  await db.delete(rateLimits).where(
    and(
      lt(rateLimits.windowStart, cutoff),
      inArray(
        rateLimits.key,
        db.select({ key: rateLimits.key }).from(rateLimits).where(lt(rateLimits.windowStart, cutoff)).limit(COLLECT_BATCH),
      ),
    ),
  );
}

/** The 429 every bucket answers with. */
export function rateLimited(c: Context, retryAfterSeconds: number): Response {
  c.header('Retry-After', String(retryAfterSeconds));
  return c.json<ErrorBody>({ error: 'Too many requests', code: 'rate_limited' }, 429);
}

/** The last non-empty entry of a comma-separated header. */
const lastEntry = (value: string | null | undefined): string | undefined =>
  value
    ?.split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .at(-1);

/**
 * The address a window counts: an IPv4-mapped IPv6 address as its IPv4, any
 * other IPv6 address as its /64 — what one subscriber is usually handed, and
 * whose every address one client could otherwise rotate through. Anything that
 * is not an address (a header a client wrote) is kept as written, cut short.
 */
function addressKey(address: string): string {
  if (isIP(address) !== 6) return address.slice(0, 64);
  const words = v6Words(address);
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return [words[6]! >> 8, words[6]! & 0xff, words[7]! >> 8, words[7]! & 0xff].join('.');
  }
  return `${words.slice(0, 4).map((word) => word.toString(16)).join(':')}::/64`;
}

/**
 * Who sent the request, for the buckets counted by address. In order:
 *
 * 1. `CLIENT_IP_HEADER` when it is set — the header the proxy in front of the
 *    app writes the client's address into (`cf-connecting-ip` behind
 *    Cloudflare); absent from a request, the next rule answers.
 * 2. The rightmost `x-forwarded-for` entry: what the proxy nearest the app
 *    appended. Next's rewrite does not append (httpxy without `xfwd`), and Next
 *    only fills the header in when it is missing (`??=` with the socket's
 *    address, base-server.js) — so with no proxy in front of Next a client can
 *    write its own and be counted as whoever it names. Production always has
 *    one, since the web's `start` listens on 127.0.0.1 only.
 * 3. The socket's address, which in production is the web process's own.
 */
export function clientAddress(headers: Headers, env: NodeJS.ProcessEnv, socketAddress?: string): string {
  const named = env['CLIENT_IP_HEADER']?.trim();
  const address =
    (named ? lastEntry(headers.get(named)) : undefined) ?? lastEntry(headers.get('x-forwarded-for')) ?? socketAddress;
  return address ? addressKey(address) : 'unknown';
}

/** `@hono/node-server` hands the Node request in as `c.env.incoming`; `app.request()` in the tests has none. */
const socketAddressOf = (c: Context): string | undefined =>
  (c.env as { incoming?: IncomingMessage } | undefined)?.incoming?.socket?.remoteAddress;

/** The caller's hit on `bucket`, or null to go on. */
export async function limitCaller(c: Context<AppEnv>, deps: AppDeps, bucket: RateBucket): Promise<Response | null> {
  const who =
    bucket.by === 'user'
      ? `user:${c.get('userId')}`
      : `ip:${clientAddress(c.req.raw.headers, deps.env, socketAddressOf(c))}`;
  const hit = await hitRateLimit(deps.db, `${bucket.name}:${who}`, bucket);
  return hit.allowed ? null : rateLimited(c, hit.retryAfterSeconds);
}

/** `bucket` in front of a route; a user bucket goes after `requireUser`. */
export function rateLimit(deps: AppDeps, bucket: RateBucket): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const refused = await limitCaller(c, deps, bucket);
    if (refused) return refused;
    await next();
  };
}
