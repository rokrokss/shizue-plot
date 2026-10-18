/**
 * The headers the web app answers with. The page's policy carries a nonce, so
 * `proxy.ts` writes it for each request from the environment the app runs in;
 * the rest Next computes when the app is built (`next.config.ts`).
 *
 * `/api/*` is left to the API, which sets its own (apps/api/src/securityHeaders.ts)
 * and the rewrite passes them through.
 */
import { createHash } from 'node:crypto';
import { THEME_SCRIPT } from './src/lib/theme';

type Env = Record<string, string | undefined>;

/** The one inline script that is ours, written into the server HTML only (`ThemedHtml`): allowed by what it says. */
const THEME_SCRIPT_HASH = `'sha256-${createHash('sha256').update(THEME_SCRIPT).digest('base64')}'`;

/** Where the studio downloads a RisuRealm card from, in the browser (`lib/realm.ts`). */
const REALM_ORIGIN = 'https://realm.risuai.net';

/**
 * The page's policy. A card's HTML and CSS are drawn into the page itself, and
 * the sanitizer holds every address in them to our own origin (`lib/sanitizeHtml.ts`);
 * this is the browser holding them there too, should a rule of the sanitizer's
 * let one through: pictures, music, fonts and connections load from us, with
 * Realm the only other — a file's parts upload to the API, on our origin — and no `<object>`, `<base>` or form
 * that leaves.
 *
 * Scripts run only from us: our files, the inline scripts Next writes into the
 * page, which carry this request's `nonce` (Next reads it off the request's
 * policy), and the theme script by its hash. So markup that gets past the
 * sanitizer can run nothing — no `on*` handler, no `javascript:`, no `<script>`
 * in a frame of its own making. Nothing on the page evaluates strings either: a
 * component's compiled JSX and a card's Lua run in sandbox frames that are
 * documents of their own, each with its own policy (`app/sandbox/*.html`), so
 * `'unsafe-eval'` is only here under `next dev`, where React rebuilds the
 * server's error stacks with it.
 */
export function contentSecurityPolicy(env: Env, nonce: string): string {
  const connect = ["'self'", REALM_ORIGIN];
  const evaluate = env['NODE_ENV'] === 'development' ? " 'unsafe-eval'" : '';
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' ${THEME_SCRIPT_HASH}${evaluate}`,
    "style-src 'self' 'unsafe-inline'",
    // `blob:` is a picture the reader picked, shown before it is uploaded.
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connect.join(' ')}`,
    // The sandboxes' workers are blobs; the page's own come from `/_next`.
    "worker-src 'self' blob:",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

interface HeaderRule {
  source: string;
  headers: { key: string; value: string }[];
}

export function securityHeaders(): HeaderRule[] {
  return [
    {
      // Everything but `/api`, whose answers are the API's.
      source: '/:path((?!api/).*)',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      ],
    },
    {
      // Not the sandbox documents, which our own pages frame: their policy says so.
      source: '/:path((?!api/|sandbox/).*)',
      headers: [{ key: 'X-Frame-Options', value: 'DENY' }],
    },
  ];
}
