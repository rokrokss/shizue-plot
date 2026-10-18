import { session, user, type Db } from '@shizue/db';
import { and, asc, eq, gt, like } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { AppEnv } from './deps.js';
import { forbidden, unauthorized } from './errors.js';

/**
 * Who is asking (ARCHITECTURE §4.1). shizue is one person's app on their own
 * computer, with no accounts and no sign-in: a request from this computer is its
 * owner's, and one from anywhere else — a phone through a tunnel — is the
 * owner's only with the session a pairing handed that phone (`routes/devices.ts`).
 */

export const SESSION_COOKIE = 'shizue_session';
const SESSION_TTL_S = 30 * 24 * 60 * 60;
/**
 * A paired phone's `session.id` starts with this, and only such a session opens
 * anything. Rows without it are the browser sign-ins of before 2026-10-18.
 */
const PAIRED_PREFIX = 'paired:';
const digest = (token: string): string => createHash('sha256').update(token).digest('hex');

export function readCookie(headers: Headers, name: string): string | undefined {
  for (const part of (headers.get('cookie') ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return decodeURIComponent(part.slice(at + 1).trim());
  }
  return undefined;
}

export function cookie(name: string, value: string, options: { path?: string; maxAge: number; secure: boolean }): string {
  return `${name}=${encodeURIComponent(value)}; Path=${options.path ?? '/'}; Max-Age=${options.maxAge}; HttpOnly; SameSite=Lax${options.secure ? '; Secure' : ''}`;
}

/**
 * Paired phones' sessions behind an HttpOnly cookie. The table keeps only a
 * digest of the cookie value, so a read of the database is not a way in.
 */
export interface SessionStore {
  /** A session for a phone that claimed a pairing code; returns its Set-Cookie value. */
  create(userId: string, request: Request): Promise<string>;
  /** Whether these headers carry a paired phone's session that has not run out. */
  resolve(headers: Headers): Promise<boolean>;
  /** Ends the session these headers carry, and only that one. */
  end(headers: Headers): Promise<void>;
  clearCookie(): string;
}

export function createSessionStore(db: Db, options: { secure: boolean }): SessionStore {
  return {
    async create(userId, request) {
      const token = randomBytes(32).toString('base64url');
      await db.insert(session).values({
        id: `${PAIRED_PREFIX}${randomUUID()}`, token: digest(token), userId,
        expiresAt: new Date(Date.now() + SESSION_TTL_S * 1000),
        userAgent: request.headers.get('user-agent')?.slice(0, 512) ?? null,
      });
      return cookie(SESSION_COOKIE, token, { maxAge: SESSION_TTL_S, secure: options.secure });
    },
    async resolve(headers) {
      const token = readCookie(headers, SESSION_COOKIE);
      if (!token) return false;
      const [row] = await db.select({ id: session.id }).from(session)
        .where(and(eq(session.token, digest(token)), gt(session.expiresAt, new Date()), like(session.id, `${PAIRED_PREFIX}%`)))
        .limit(1);
      return row !== undefined;
    },
    async end(headers) {
      const token = readCookie(headers, SESSION_COOKIE);
      if (token) await db.delete(session).where(eq(session.token, digest(token)));
    },
    clearCookie: () => cookie(SESSION_COOKIE, '', { maxAge: 0, secure: options.secure }),
  };
}

/**
 * The address of an owner made here. `user.email` is required and unique, and
 * `.invalid` says it is no address at all (`chatgptAccounts.ts`); being fixed,
 * it also keeps two first requests at once from making two owners.
 */
const OWNER_EMAIL = 'owner@local.shizue.invalid';

/**
 * The app's one owner, whose id every `user_id` column holds: the oldest `user`
 * row — an install from before 2026-10-18 keeps the account it signed in with —
 * or, in a new install, one made now.
 */
export async function ensureOwner(db: Db): Promise<string> {
  const oldest = async (): Promise<string | undefined> =>
    (await db.select({ id: user.id }).from(user).orderBy(asc(user.createdAt), asc(user.id)).limit(1))[0]?.id;
  const found = await oldest();
  if (found) return found;
  await db.insert(user).values({ id: randomUUID(), name: 'shizue', email: OWNER_EMAIL }).onConflictDoNothing();
  return (await oldest())!;
}

/** The addresses a connection from this computer comes from. */
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
/** This computer's own names, on any port. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/**
 * What a tunnel or proxy in front of the app adds: Cloudflare's client address,
 * Tailscale Serve's identity of the tailnet user, and RFC 7239's record.
 */
const PROXY_HEADERS = ['cf-connecting-ip', 'tailscale-user-login', 'tailscale-user-name', 'forwarded'];

/** A Host-style value naming this computer: a host and a port, nothing else. */
function isLoopbackHost(value: string): boolean {
  if (/[\s,/?#@\\]/.test(value) || value === '') return false;
  try {
    return LOOPBACK_HOSTS.has(new URL(`http://${value}`).hostname);
  } catch {
    return false;
  }
}

/**
 * Whether a request comes from this computer and nothing stands between: the
 * connection is a loopback one (none at all is `app.request` in the tests),
 * every host it names is this computer's — the `x-forwarded-host` the Next
 * rewrite writes, the `Host`, and the address itself — and no tunnel or proxy
 * left its mark, `x-forwarded-for` naming loopback addresses only. Anything else
 * is somewhere else, a phone through a tunnel among them, and a page on another
 * site that resolves to this machine (DNS rebinding) names its own host.
 *
 * Whatever serves this app must hand it the Node request (`c.env.incoming`, as
 * `@hono/node-server` does): called without one, every request looks local.
 */
export function isLocalRequest(c: Context): boolean {
  const incoming = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming;
  if (incoming && !LOOPBACK_ADDRESSES.has(incoming.socket?.remoteAddress ?? '')) return false;
  const hosts = [c.req.header('x-forwarded-host'), c.req.header('host'), new URL(c.req.url).host];
  if (!hosts.every((host) => host === undefined || isLoopbackHost(host))) return false;
  if (PROXY_HEADERS.some((name) => c.req.header(name) !== undefined)) return false;
  const forwardedFor = c.req.header('x-forwarded-for');
  return forwardedFor === undefined || forwardedFor.split(',').every((entry) => LOOPBACK_ADDRESSES.has(entry.trim()));
}

/**
 * In front of every `/api/*` route but the probes and a phone's claim of its
 * pairing code (app.ts): a request from this computer, or one carrying a paired
 * phone's session, runs as the owner; anything else is 401. Past it `userId` and
 * `viewerId` are the owner's, and `local` says which of the two it was.
 */
export function ownerGate(db: Db, sessions: SessionStore): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const local = isLocalRequest(c);
    if (!local && !(await sessions.resolve(c.req.raw.headers))) throw unauthorized();
    const owner = await ensureOwner(db);
    c.set('local', local);
    c.set('viewerId', owner);
    c.set('userId', owner);
    await next();
  };
}

/**
 * In front of what only this computer may do: connecting ChatGPT, whose
 * callback only this computer's Shizue extension brings back, and letting a
 * phone in. A paired phone is refused with 403 `local_only`.
 */
export const requireLocal: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get('local')) throw forbidden('local_only', 'Only the computer shizue runs on can do this');
  await next();
};

/**
 * The guard the routes carried while shizue had accounts. Every request past
 * `ownerGate` has its owner, so it never refuses one now; it stays in front of
 * the routes until those that served other readers go.
 */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('viewerId') === null) throw unauthorized();
  await next();
};
