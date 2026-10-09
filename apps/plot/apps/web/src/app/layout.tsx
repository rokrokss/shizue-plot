import type { ReactNode } from 'react';

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
