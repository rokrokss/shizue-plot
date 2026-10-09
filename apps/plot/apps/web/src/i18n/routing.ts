import { defineRouting } from 'next-intl/routing';

export const locales = ['ko', 'en', 'ja'] as const;

export type Locale = (typeof locales)[number];

/** Single domain, locale path prefix: /ko, /en, /ja. */
export const routing = defineRouting({
  locales,
  defaultLocale: 'ko',
  localePrefix: 'always',
});
