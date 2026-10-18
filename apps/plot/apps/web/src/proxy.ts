import { randomBytes } from 'node:crypto';
import createMiddleware from 'next-intl/middleware';
import type { NextRequest } from 'next/server';
import { contentSecurityPolicy } from '../securityHeaders';
import { routing } from './i18n/routing';

/**
 * Accept-Language detection on first visit; the choice is then kept in a cookie.
 *
 * `proxy.ts` is what Next 16 calls this file — `middleware.ts` up to Next 15,
 * and deprecated since. next-intl kept its own export named `createMiddleware`
 * and documents exactly this file for Next 16, so the two names disagreeing here
 * is upstream's, not a leftover.
 */
const intl = createMiddleware(routing);

/**
 * Every page's policy, with a nonce of its own. Set on the request too, which
 * next-intl forwards: Next reads the nonce off the request's policy and writes it
 * on every script it puts in the page — which is why every page is rendered per
 * request (`app/layout.tsx`).
 */
export default function proxy(request: NextRequest) {
  // How Next compiled this file — `next dev` or a build — rather than the
  // process's environment, which is the API's too since the two run as one
  // process, and `test` under the browser suite.
  const policy = contentSecurityPolicy({ NODE_ENV: process.env.NODE_ENV }, randomBytes(16).toString('base64'));
  request.headers.set('content-security-policy', policy);
  const response = intl(request);
  response.headers.set('content-security-policy', policy);
  return response;
}

export const config = {
  // Locale detection and the policy for app pages, excluding API and static
  // assets: a worker script under `/_next` takes the policy its own response
  // carries, and the embedding worker fetches its model from Hugging Face. The
  // sandbox documents (`/sandbox/*.html`) carry only their own.
  matcher: '/((?!api|_next|_vercel|.*\\..*).*)',
};
