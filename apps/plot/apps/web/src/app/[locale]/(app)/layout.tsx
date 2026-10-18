'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, type ReactNode } from 'react';
import { Header } from '@/components/Header';
import { MobileTabBar } from '@/components/MobileTabBar';
import { cx } from '@/components/ui';
import { usePathname } from '@/i18n/navigation';
import { noteMove } from '@/lib/nav';

/**
 * The shell every page stands in. There is no sign-in: this computer's browser is
 * the owner, and so is a paired phone (the API's `ownerGate`); a phone that is
 * not paired is answered 401 by the API, which the pages say in words.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const t = useTranslations('rebrand');
  // The tab bar is the phone's navigation, except in a conversation, where the
  // composer already owns the bottom edge.
  const conversation = pathname.startsWith('/chats/');
  const tabBar = !conversation;
  // The page the tab opened on is not a move; every path after it is.
  const opened = useRef(pathname);
  useEffect(() => {
    if (pathname !== opened.current) noteMove();
  }, [pathname]);

  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#main-content" className="skip-link">{t('skip')}</a>
      {/* A conversation is a screen of its own, as in Zeta, at every width: its
          row names the character and leads back, so the shell's bar steps aside.
          `contents` keeps the header sticky to the page where it stands; the
          wrapper is always there so moving into a chat does not remount it. */}
      <div className={conversation ? 'hidden' : 'contents'}>
        <Header />
      </div>
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
