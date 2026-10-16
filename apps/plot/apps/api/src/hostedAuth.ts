import { session, user, type Db } from '@shizue/db';
import { and, eq, gt } from 'drizzle-orm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ChatGPTAccounts } from './chatgptAccounts.js';

export interface SessionUser { id: string; name: string; email: string; image?: string | null }
/** `paired`: a session another of the reader's devices handed to this browser (`routes/devices.ts`). */
export interface AppSession { user: SessionUser; paired?: boolean }
/** What the app needs from authentication; better-auth's test fixture has the same shape. */
export interface AppAuth {
  handler(request: Request): Response | Promise<Response>;
  api: { getSession(options: { headers: Headers }): Promise<AppSession | null> };
}

export const SESSION_COOKIE = 'shizue_session';
const SESSION_TTL_S = 30 * 24 * 60 * 60;
/**
 * The `session.id` of a paired device's session starts with this. Signing out
 * there ends that session alone: the ChatGPT sign-in, and every other session,
 * belong to the browser that signed in.
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
 * Server-side sessions behind an HttpOnly cookie. The table keeps only a digest
 * of the cookie value, so a read of the database is not a way into an account.
 */
export interface SessionStore {
  /** Returns the Set-Cookie value for the new session. */
  create(userId: string, request: Request, options?: { paired?: boolean }): Promise<string>;
  resolve(headers: Headers): Promise<AppSession | null>;
  /** Ends the session these headers carry, and only that one. */
  end(headers: Headers): Promise<void>;
  clearCookie(): string;
}

export function createSessionStore(db: Db, options: { secure: boolean }): SessionStore {
  return {
    async create(userId, request, { paired = false } = {}) {
      const token = randomBytes(32).toString('base64url');
      await db.insert(session).values({
        id: `${paired ? PAIRED_PREFIX : ''}${randomUUID()}`, token: digest(token), userId,
        expiresAt: new Date(Date.now() + SESSION_TTL_S * 1000),
        userAgent: request.headers.get('user-agent')?.slice(0, 512) ?? null,
      });
      return cookie(SESSION_COOKIE, token, { maxAge: SESSION_TTL_S, secure: options.secure });
    },
    async resolve(headers) {
      const token = readCookie(headers, SESSION_COOKIE);
      if (!token) return null;
      const [row] = await db.select({ id: user.id, name: user.name, email: user.email, image: user.image, sessionId: session.id })
        .from(session).innerJoin(user, eq(session.userId, user.id))
        .where(and(eq(session.token, digest(token)), gt(session.expiresAt, new Date()))).limit(1);
      if (!row) return null;
      const { sessionId, ...owner } = row;
      return sessionId.startsWith(PAIRED_PREFIX) ? { user: owner, paired: true } : { user: owner };
    },
    async end(headers) {
      const token = readCookie(headers, SESSION_COOKIE);
      if (token) await db.delete(session).where(eq(session.token, digest(token)));
    },
    clearCookie: () => cookie(SESSION_COOKIE, '', { maxAge: 0, secure: options.secure }),
  };
}

/**
 * Signing out: a paired device leaves alone, and the browser that signed in
 * ends the ChatGPT sign-in and every session with it, paired ones included.
 */
export async function signOut(
  sessions: SessionStore, accounts: ChatGPTAccounts, current: AppSession, headers: Headers,
): Promise<{ revocationPending: boolean }> {
  if (!current.paired) return accounts.signOut(current.user.id);
  await sessions.end(headers);
  return { revocationPending: false };
}

const json = (body: unknown, init: ResponseInit = {}): Response =>
  Response.json(body, { ...init, headers: { 'Cache-Control': 'no-store', ...init.headers } });

/**
 * Sign in with ChatGPT is the only way in. The `fixture` is better-auth's
 * email/password stand-in that the NODE_ENV=test suites use to make many users;
 * it is never passed in a normal launch.
 */
export function createHostedAuth(sessions: SessionStore, accounts: ChatGPTAccounts, fixture?: AppAuth): AppAuth {
  const getSession = async ({ headers }: { headers: Headers }): Promise<AppSession | null> =>
    await sessions.resolve(headers) ?? await fixture?.api.getSession({ headers }) ?? null;
  return {
    api: { getSession },
    async handler(request) {
      const path = new URL(request.url).pathname;
      if (request.method === 'GET' && path === '/api/auth/get-session') return json(await getSession({ headers: request.headers }));
      if (request.method === 'POST' && path === '/api/auth/sign-out') {
        const current = await sessions.resolve(request.headers);
        if (current) {
          const result = await signOut(sessions, accounts, current, request.headers);
          return json(result, { headers: { 'Set-Cookie': sessions.clearCookie() } });
        }
      }
      if (fixture) return fixture.handler(request);
      return json({ error: 'Use Sign in with ChatGPT.', code: 'chatgpt_login_required' }, { status: 404 });
    },
  };
}
