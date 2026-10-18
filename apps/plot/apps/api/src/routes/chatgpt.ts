import { credentials } from '@shizue/db';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { SIGN_IN_LOCALES, SignInFailure, type SignInLocale } from '../chatgptAccounts.js';
import type { AppDeps, AppEnv } from '../deps.js';
import { ApiError, badRequest } from '../errors.js';
import { ensureFirstPreset } from '../models.js';
import { cookie, readCookie, requireLocal } from '../session.js';
import { optionalString, readJsonBody } from '../util.js';

/** Binds one connection attempt to the browser that started it. */
const ATTEMPT_COOKIE = 'shizue_chatgpt_attempt';
/** The registration issued to the account this browser last connected, reused on its next connection. */
const CLIENT_COOKIE = 'shizue_chatgpt_client';
const COOKIE_PATH = '/api/chatgpt';
/** Codes after which the remembered registration is not worth offering again. */
const STALE_CLIENT = ['chatgpt_invalid_client', 'invalid_client', 'unauthorized_client'];

/** The same rule as the web app's links: a local path, never `//host`. */
const localPath = (value: string | undefined): string =>
  value && value.startsWith('/') && !/^\/[/\\]/.test(value) && value.length <= 512 ? value : '/';

/**
 * The owner's ChatGPT connection (ARCHITECTURE §4.1): Sign in with ChatGPT as the
 * way to the owner's own plan, not a way into the app. Tokens never leave the
 * server: the browser only carries the attempt cookie. Connecting and
 * disconnecting are this computer's alone — the callback comes back by way of
 * its Shizue extension, which a phone has none of — and a paired phone only
 * reads whether ChatGPT is connected.
 */
export function chatGPTRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const service = (): NonNullable<AppDeps['chatgpt']> => {
    if (!deps.chatgpt) throw new ApiError(503, 'chatgpt_unavailable', 'Sign in with ChatGPT is not configured');
    return deps.chatgpt;
  };
  const secure = new URL(deps.webOrigin ?? 'http://localhost').protocol === 'https:';
  app.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });

  app.get('/', async (c) => {
    const status = deps.chatgpt ? await deps.chatgpt.accounts.status(c.get('userId')) : { connected: false, email: null };
    return c.json({ ...status, local: c.get('local') });
  });

  app.post('/sign-in', requireLocal, async (c) => {
    const body = await readJsonBody(c);
    const locale = optionalString(body, 'locale') ?? 'ko';
    if (!SIGN_IN_LOCALES.includes(locale as SignInLocale)) throw badRequest('invalid_request', 'Unknown locale');
    const started = await service().accounts.startSignIn({
      clientHint: readCookie(c.req.raw.headers, CLIENT_COOKIE),
      target: { next: localPath(optionalString(body, 'next')), locale: locale as SignInLocale },
    });
    c.header('Set-Cookie', cookie(ATTEMPT_COOKIE, started.binding, { path: COOKIE_PATH, maxAge: 600, secure }));
    return c.json({ authorizationUrl: started.authorizationUrl });
  });

  // The browser lands here from OpenAI by way of the Shizue extension, so every
  // outcome is a redirect back into the app rather than a JSON body: where the
  // connection started, or the settings card with the failure's code.
  app.get('/callback', requireLocal, async (c) => {
    const { accounts } = service();
    c.header('Set-Cookie', cookie(ATTEMPT_COOKIE, '', { path: COOKIE_PATH, maxAge: 0, secure }), { append: true });
    try {
      const done = await accounts.finishSignIn(new URL(c.req.url).searchParams, readCookie(c.req.raw.headers, ATTEMPT_COOKIE), c.get('userId'));
      c.header('Set-Cookie', cookie(CLIENT_COOKIE, done.clientId, { path: COOKIE_PATH, maxAge: 365 * 24 * 60 * 60, secure }), { append: true });
      // An owner with no model preset yet gets one on the plan (`ensureFirstPreset`).
      const [connection] = await deps.db.select().from(credentials)
        .where(and(eq(credentials.userId, c.get('userId')), eq(credentials.kind, 'chatgpt'))).limit(1);
      if (connection) await ensureFirstPreset(deps, connection);
      return c.redirect(`/${done.target.locale}${done.target.next}`, 302);
    } catch (error) {
      if (!(error instanceof SignInFailure)) throw error;
      if (STALE_CLIENT.includes(error.code)) c.header('Set-Cookie', cookie(CLIENT_COOKIE, '', { path: COOKIE_PATH, maxAge: 0, secure }), { append: true });
      return c.redirect(`/${error.target.locale}/settings?${new URLSearchParams({ error: error.code })}`, 302);
    }
  });

  /** Revokes and forgets the tokens; paired phones stay paired, and use whatever is connected next. */
  app.post('/disconnect', requireLocal, async (c) => c.json(await service().accounts.disconnect(c.get('userId'))));

  return app;
}
