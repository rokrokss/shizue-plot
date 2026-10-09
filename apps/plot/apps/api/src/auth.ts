import { account, session, user, verification, type Db } from '@shizue/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';

export type Auth = ReturnType<typeof createAuth>;

interface AuthConfig {
  secret: string;
  baseUrl: string;
  /** Origins trusted beyond the base URL itself (env.ts says when that is). */
  extraTrustedOrigins?: string[];
}

/** Email/password test fixture (NODE_ENV=test only); real users sign in with ChatGPT (hostedAuth.ts). */
export function createAuth(db: Db, { secret, baseUrl, extraTrustedOrigins = [] }: AuthConfig) {
  return betterAuth({
    appName: 'shizue',
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: { user, session, account, verification },
    }),
    secret,
    baseURL: baseUrl,
    basePath: '/api/auth',
    emailAndPassword: {
      enabled: process.env['NODE_ENV'] === 'test',
      requireEmailVerification: false,
    },
    trustedOrigins: [...new Set([baseUrl, ...extraTrustedOrigins])],
  });
}

/**
 * better-auth answers failures with `{message, code}`; rewrite those onto the API
 * error shape `{error, code}` (snake_case code) while keeping status and headers.
 * Success and redirect responses pass through untouched.
 */
export async function normalizeAuthResponse(res: Response): Promise<Response> {
  if (res.status < 400) return res;

  let body: unknown = null;
  try {
    body = await res.clone().json();
  } catch {
    // Non-JSON error body: fall back to the generic code below.
  }
  const fields = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const message = typeof fields['message'] === 'string' ? fields['message'] : '';
  const code = typeof fields['code'] === 'string' ? fields['code'] : '';

  const headers = new Headers(res.headers);
  headers.set('content-type', 'application/json');
  headers.delete('content-length');
  return new Response(
    JSON.stringify({
      error: message || res.statusText || 'Authentication error',
      code: code ? code.toLowerCase() : 'auth_error',
    }),
    { status: res.status, headers },
  );
}
