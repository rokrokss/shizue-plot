import { session, user, type Db } from '@shizue/db';
import { and, eq, gt } from 'drizzle-orm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ChatGPTAccounts } from './chatgptAccounts.js';

export interface SessionUser { id: string; name: string; email: string; image?: string | null }
export interface AppSession { user: SessionUser }
/** What the app needs from authentication; better-auth's test fixture has the same shape. */
export interface AppAuth {
  handler(request: Request): Response | Promise<Response>;
  api: { getSession(options: { headers: Headers }): Promise<AppSession | null> };
}

export const SESSION_COOKIE = 'shizue_session';
const SESSION_TTL_S = 30 * 24 * 60 * 60;
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
  create(userId: string, request: Request): Promise<string>;
  resolve(headers: Headers): Promise<AppSession | null>;
  clearCookie(): string;
}

export function createSessionStore(db: Db, options: { secure: boolean }): SessionStore {
  return {
    async create(userId, request) {
      const token = randomBytes(32).toString('base64url');
      await db.insert(session).values({
        id: randomUUID(), token: digest(token), userId,
        expiresAt: new Date(Date.now() + SESSION_TTL_S * 1000),
        userAgent: request.headers.get('user-agent')?.slice(0, 512) ?? null,
      });
      return cookie(SESSION_COOKIE, token, { maxAge: SESSION_TTL_S, secure: options.secure });
    },
    async resolve(headers) {
      const token = readCookie(headers, SESSION_COOKIE);
      if (!token) return null;
      const [row] = await db.select({ id: user.id, name: user.name, email: user.email, image: user.image })
        .from(session).innerJoin(user, eq(session.userId, user.id))
        .where(and(eq(session.token, digest(token)), gt(session.expiresAt, new Date()))).limit(1);
      return row ? { user: row } : null;
    },
    clearCookie: () => cookie(SESSION_COOKIE, '', { maxAge: 0, secure: options.secure }),
  };
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
          const result = await accounts.signOut(current.user.id);
          return json(result, { headers: { 'Set-Cookie': sessions.clearCookie() } });
        }
      }
      if (fixture) return fixture.handler(request);
      return json({ error: 'Use Sign in with ChatGPT.', code: 'chatgpt_login_required' }, { status: 404 });
    },
  };
}
