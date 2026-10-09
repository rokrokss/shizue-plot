'use client';

import { useTranslations } from 'next-intl';
import { useEffect } from 'react';

/**
 * What the tab is called. Every screen is behind the login gate, so no crawler
 * ever reads any of this — the root layout's `<title>` is the brand alone and
 * the screen's own name is put in front of it from here.
 *
 * A screen whose name arrives with its data passes undefined until it does, and
 * until then the tab reads as the brand. Nothing is restored on unmount: the
 * next screen writes its own title, and the one leaving has no say in it.
 */
export function useDocumentTitle(title?: string): void {
  const brand = useTranslations('brand');
  const full = brand('full');

  useEffect(() => {
    document.title = title ? `${title} — ${full}` : full;
  }, [title, full]);
}
