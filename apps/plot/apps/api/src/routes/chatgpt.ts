import { Hono } from 'hono';
import { SIGN_IN_LOCALES, SignInFailure, type SignInLocale } from '../chatgptAccounts.js';
import type { AppDeps, AppEnv } from '../deps.js';
import { ApiError, badRequest } from '../errors.js';
import { cookie, readCookie } from '../hostedAuth.js';
import { requireUser } from '../session.js';
import { optionalString, readJsonBody } from '../util.js';

/** Binds one sign-in attempt to the browser that started it. */
const ATTEMPT_COOKIE = 'shizue_chatgpt_attempt';
/** The registration issued to this browser's last account, reused on its next sign-in. */
const CLIENT_COOKIE = 'shizue_chatgpt_client';
const COOKIE_PATH = '/api/chatgpt';
/** Codes after which the remembered registration is not worth offering again. */
const STALE_CLIENT = ['chatgpt_invalid_client', 'invalid_client', 'unauthorized_client'];

/** The same rule as the web app's `returnTo`: a local path, never `//host`. */
const localPath = (value: string | undefined): string =>
  value && value.startsWith('/') && !/^\/[/\\]/.test(value) && value.length <= 512 ? value : '/';

/**
 * Sign in with ChatGPT for the hosted app. Tokens never leave the server: the
 * browser only carries the attempt and session cookies.
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
    const viewer = c.get('viewerId');
    return c.json(viewer && deps.chatgpt ? await deps.chatgpt.accounts.status(viewer) : { connected: false, email: null });
  });

  app.post('/sign-in', async (c) => {
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

  // The browser lands here from OpenAI by way of the companion extension, so every
  // outcome is a redirect back into the app rather than a JSON body.
  app.get('/callback', async (c) => {
    const { accounts, sessions } = service();
    c.header('Set-Cookie', cookie(ATTEMPT_COOKIE, '', { path: COOKIE_PATH, maxAge: 0, secure }), { append: true });
    try {
      const done = await accounts.finishSignIn(new URL(c.req.url).searchParams, readCookie(c.req.raw.headers, ATTEMPT_COOKIE));
      c.header('Set-Cookie', await sessions.create(done.userId, c.req.raw), { append: true });
      c.header('Set-Cookie', cookie(CLIENT_COOKIE, done.clientId, { path: COOKIE_PATH, maxAge: 365 * 24 * 60 * 60, secure }), { append: true });
      return c.redirect(`/${done.target.locale}${done.target.next}`, 302);
    } catch (error) {
      if (!(error instanceof SignInFailure)) throw error;
      if (STALE_CLIENT.includes(error.code)) c.header('Set-Cookie', cookie(CLIENT_COOKIE, '', { path: COOKIE_PATH, maxAge: 0, secure }), { append: true });
      const query = new URLSearchParams({ error: error.code, next: error.target.next });
      return c.redirect(`/${error.target.locale}/login?${query}`, 302);
    }
  });

  app.post('/sign-out', requireUser, async (c) => {
    const { accounts, sessions } = service();
    const result = await accounts.signOut(c.get('userId'));
    c.header('Set-Cookie', sessions.clearCookie());
    return c.json(result);
  });

  return app;
}
