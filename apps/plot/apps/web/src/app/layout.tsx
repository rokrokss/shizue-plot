import type { Viewport } from 'next';
import type { ReactNode } from 'react';

/**
 * The page reaches under the home indicator and, on a phone on its side, the
 * notch, so that `env(safe-area-inset-*)` reads the real insets and whatever
 * stands at an edge keeps its content out of them. Without it iOS reports 0, and
 * a site added to the Home Screen, which iOS opens as a web app, has its tab bar
 * and composer on the indicator.
 */
export const viewport: Viewport = { viewportFit: 'cover' };

/**
 * Every page is rendered per request, the not-found page among them: its scripts
 * carry the nonce of that request's policy (`proxy.ts`), and a page prerendered
 * at build time would carry none and run nothing.
 */
export const dynamic = 'force-dynamic';

/**
 * A pass-through, and only because `not-found.tsx` sits beside it. That page is
 * outside `[locale]`, so it needs a root layout of its own; without this file
 * Next synthesizes one — `<html><body>` — and the document ends up with the
 * not-found page's own `<html>` nested inside it. The tags belong to whatever
 * renders under here: `[locale]/layout.tsx` for every real page, `not-found.tsx`
 * for the one path that never reaches it.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return children;
}
