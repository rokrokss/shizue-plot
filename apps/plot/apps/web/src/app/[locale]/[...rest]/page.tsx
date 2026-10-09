import { notFound } from 'next/navigation';

/**
 * Every `/{locale}/…` path no other route claims.
 *
 * Without it Next never enters the `[locale]` segment for an unmatched URL — it
 * cannot match the segment against a path it has no route for — and falls back
 * to the root `not-found.tsx`, which has no locale and so no language. Calling
 * `notFound()` from inside the segment puts the reader on
 * `[locale]/not-found.tsx` instead, under the layout that knows which language
 * to write in.
 */
export default function CatchAllPage() {
  notFound();
}
