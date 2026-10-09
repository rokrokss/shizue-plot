'use client';

import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { Header } from '@/components/Header';
import { MobileTabBar } from '@/components/MobileTabBar';
import { cx } from '@/components/ui';
import { usePathname } from '@/i18n/navigation';

/**
 * The shell every page stands in, session or not: a reader who has not signed in
 * still gets the catalogue, a character page and a creator's shelf. What needs a
 * session sits one level down, under `(member)`, and that layout is what sends
 * an anonymous reader to the login page.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const t = useTranslations('rebrand');
  // The tab bar is the phone's navigation, except in a conversation, where the
  // composer already owns the bottom edge.
  const tabBar = !pathname.startsWith('/chats/');

  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#main-content" className="skip-link">{t('skip')}</a>
      <Header />
      {/* The bar lies over the page, so the page ends above it — inside `main`,
          so the column stays exactly as tall as the viewport. */}
      <main
        id="main-content"
        tabIndex={-1}
        className={cx(
          'flex min-h-0 flex-1 flex-col',
          tabBar && 'pb-[calc(3.5rem+env(safe-area-inset-bottom))] lg:pb-0',
        )}
      >
        {children}
      </main>
      {tabBar ? <MobileTabBar /> : null}
    </div>
  );
}
