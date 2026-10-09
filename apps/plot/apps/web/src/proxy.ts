import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';

/**
 * Accept-Language detection on first visit; the choice is then kept in a cookie.
 *
 * `proxy.ts` is what Next 16 calls this file — `middleware.ts` up to Next 15,
 * and deprecated since. next-intl kept its own export named `createMiddleware`
 * and documents exactly this file for Next 16, so the two names disagreeing here
 * is upstream's, not a leftover.
 */
export default createMiddleware(routing);

export const config = {
  // Locale detection for app pages, excluding API and static assets.
  matcher: '/((?!api|_next|_vercel|.*\\..*).*)',
};
