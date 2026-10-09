import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';

/**
 * The 404 for a path that did have a locale, so it can be written in the
 * reader's language. The root `not-found.tsx` stays where it is, for the paths
 * that never reach a locale at all.
 *
 * Next hands `not-found.tsx` no params, so there is no locale to pass on here;
 * the locale comes off the request the way it does for every other server
 * render — the proxy put it there, and `i18n/request.ts` reads it.
 *
 * `(app)` is a sibling of this file, not an ancestor, so nothing above draws the
 * header — the way out has to be on the page itself.
 */
export default async function LocaleNotFound() {
  const t = await getTranslations('notFound');

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 p-10 text-center">
      <p className="text-[11px] leading-none font-medium tracking-[0.32em] text-muted tabular-nums">
        404
      </p>
      <h1 className="text-lg font-semibold tracking-tight text-fg">{t('title')}</h1>
      <p className="max-w-sm text-sm text-muted">{t('body')}</p>
      <Link
        href="/"
        className="mt-2 inline-flex h-10 items-center rounded-full border border-line bg-raised px-4 text-sm font-medium text-fg transition-colors hover:border-muted/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        {t('home')}
      </Link>
    </main>
  );
}
