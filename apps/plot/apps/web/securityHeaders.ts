/**
 * The headers the web app answers with (`next.config.ts`). Next computes them
 * when the app is built, so the environment that matters is the build's:
 * `BETTER_AUTH_URL` and the storage settings the API reads too.
 *
 * `/api/*` is left to the API, which sets its own (apps/api/src/securityHeaders.ts)
 * and the rewrite passes them through.
 */

type Env = Record<string, string | undefined>;

/** Where the studio downloads a RisuRealm card from, in the browser (`lib/realm.ts`). */
const REALM_ORIGIN = 'https://realm.risuai.net';

/**
 * Where the browser uploads a card or module file's parts (`lib/fileImport.ts`):
 * the S3 store itself, at the address the API presigns — the public endpoint if
 * there is one, path-style or with the bucket in the host as `S3_FORCE_PATH_STYLE`
 * says, and AWS's own regional host without an endpoint. The local driver takes
 * them at the API, on our origin.
 */
export function storeOrigin(env: Env): string | null {
  if (env['STORAGE_DRIVER'] !== 's3') return null;
  const bucket = env['S3_BUCKET'];
  const endpoint = env['S3_PUBLIC_ENDPOINT'] || env['S3_ENDPOINT'];
  if (!endpoint) return bucket ? `https://${bucket}.s3.${env['S3_REGION'] ?? 'us-east-1'}.amazonaws.com` : null;
  const url = new URL(endpoint);
  const pathStyle = env['S3_FORCE_PATH_STYLE'] === 'true' || env['S3_FORCE_PATH_STYLE'] === '1';
  return pathStyle || !bucket ? url.origin : `${url.protocol}//${bucket}.${url.host}`;
}

/**
 * The page's policy. A card's HTML and CSS are drawn into the page itself, and
 * the sanitizer holds every address in them to our own origin (`lib/sanitizeHtml.ts`);
 * this is the browser holding them there too, should a rule of the sanitizer's
 * let one through: pictures, music, fonts and connections load from us, with
 * Realm and the upload store the only others, and no `<object>`, `<base>` or form
 * that leaves.
 *
 * Nothing on the page evaluates strings: a component's compiled JSX and a card's
 * Lua run in sandbox frames that are documents of their own, each with its own
 * policy (`app/sandbox/*.html`), so `'unsafe-eval'` is only here under
 * `next dev`, where React rebuilds the server's error stacks with it. Inline
 * scripts stay open: Next writes its own per page and would need a nonce.
 */
export function contentSecurityPolicy(env: Env): string {
  const connect = ["'self'", REALM_ORIGIN, storeOrigin(env)].filter(Boolean);
  const evaluate = env['NODE_ENV'] === 'development' ? " 'unsafe-eval'" : '';
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${evaluate}`,
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

export function securityHeaders(env: Env): HeaderRule[] {
  const https = (env['BETTER_AUTH_URL'] ?? '').startsWith('https://');
  return [
    {
      // Everything but `/api`, whose answers are the API's.
      source: '/:path((?!api/).*)',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ...(https ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }] : []),
      ],
    },
    {
      // Not the sandbox documents, which our own pages frame: their policy says so.
      source: '/:path((?!api/|sandbox/).*)',
      headers: [{ key: 'X-Frame-Options', value: 'DENY' }],
    },
    {
      // Pages, not `/_next`: a worker script takes the policy its own response
      // carries, and the embedding worker fetches its model from Hugging Face.
      // Nor the sandbox documents, which carry only their own.
      source: '/:path((?!api/|_next/|sandbox/).*)',
      headers: [{ key: 'Content-Security-Policy', value: contentSecurityPolicy(env) }],
    },
  ];
}
