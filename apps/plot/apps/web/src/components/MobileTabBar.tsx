'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Link, usePathname } from '@/i18n/navigation';
import { useSession } from '@/lib/authClient';
import { navClusters, signInHref, type NavCluster } from '@/lib/nav';
import { Icon } from './Icon';
import { BottomSheet } from './BottomSheet';
import { LocaleSwitcher } from './LocaleSwitcher';
import { SignOutButton } from './SignOutButton';
import { buttonClass, cx } from './ui';

const TAB =
  'flex flex-1 flex-col gap-1 items-center justify-center px-1 button10 transition-colors ' +
  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus';

/**
 * The phone's navigation, at the edge a thumb reaches: the three clusters worth
 * a tap of their own, and a menu for the rest. Icons always retain visible labels.
 *
 * A reader who is not signed in still gets every tab; the two that need a
 * session lead to the way in, carrying where they were headed, because the
 * attempt is the invitation.
 */
export function MobileTabBar() {
  const t = useTranslations('nav');
  const chatgpt = useTranslations('chatgpt');
  const pathname = usePathname();
  const { data, isPending } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);

  // Until the read lands, a tab points where it points for a member: the member
  // layout sends an anonymous reader to the same place with the same `next`.
  const anonymous = !isPending && !data;
  const href = (cluster: NavCluster): string =>
    anonymous && cluster.member ? signInHref(cluster.href) : cluster.href;

  const clusters = navClusters(pathname);

  return (
    <nav
      data-testid="tab-bar"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
    >
      <div className="mx-auto flex h-14 max-w-6xl items-stretch">
        {clusters.map((cluster) => (
          <Link
            key={cluster.key}
            href={href(cluster)}
            aria-current={cluster.active ? 'page' : undefined}
            className={cx(TAB, cluster.active ? 'bg-mint-soft/60 text-link' : 'text-muted hover:text-fg')}
          >
            <Icon name={cluster.key} className="size-[18px]" />
            {t(cluster.key)}
          </Link>
        ))}
        <button
          type="button"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(true)}
          className={cx(TAB, menuOpen ? 'bg-mint-soft/60 text-link' : 'text-muted hover:text-fg')}
        >
          <Icon name="menu" className="size-[18px]" />
          {t('menu')}
        </button>
      </div>

      {menuOpen ? (
        <BottomSheet title={t('menu')} onClose={() => setMenuOpen(false)}>
          {/* What the bar keeps on a wide screen, kept a tap away here rather than
              a level down. */}
          {data ? <Link href="/settings" onClick={() => setMenuOpen(false)} className={buttonClass('secondary', 'sm', 'mt-4 w-full')}>{t('aiSettings')}</Link> : null}
          <div className="mt-4 flex items-center justify-between gap-3 border-t border-line pt-4">
            <LocaleSwitcher />
            {isPending ? null : data ? (
              <SignOutButton />
            ) : (
              <div className="flex items-center gap-2">
                <Link
                  href="/login"
                  onClick={() => setMenuOpen(false)}
                  className={buttonClass('secondary', 'sm')}
                >
                  {chatgpt('signIn')}
                </Link>
              </div>
            )}
          </div>
        </BottomSheet>
      ) : null}
    </nav>
  );
}
