'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { usePathname, useRouter } from '@/i18n/navigation';
import { locales, type Locale } from '@/i18n/routing';

/** Switches the UI locale in place; next-intl stores the choice in a cookie. */
export function LocaleSwitcher() {
  const t = useTranslations('locales');
  const nav = useTranslations('nav');
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <select
      aria-label={nav('language')}
      value={locale}
      disabled={pending}
      onChange={(event) => {
        const next = event.target.value as Locale;
        startTransition(() => router.replace(pathname, { locale: next }));
      }}
      // 8px each side of the text, the ⌄ as far in (the global `select` rule).
      className="cursor-pointer rounded-lg border border-line bg-surface py-1.5 text-xs [--select-inset:0.5rem] text-muted transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
    >
      {locales.map((value) => (
        <option key={value} value={value}>
          {t(value)}
        </option>
      ))}
    </select>
  );
}
