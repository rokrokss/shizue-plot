'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Link, usePathname } from '@/i18n/navigation';
import { navClusters } from '@/lib/nav';
import { Icon } from './Icon';
import { BottomSheet } from './BottomSheet';
import { LocaleSwitcher } from './LocaleSwitcher';
import { ThemeSwitcher } from './ThemeSwitcher';
import { buttonClass, cx } from './ui';

const TAB =
  'flex flex-1 flex-col gap-1 items-center justify-center px-1 button10 transition-colors ' +
  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus';

/**
 * The phone's navigation, at the edge a thumb reaches: the three clusters worth
 * a tap of their own, and a menu for the rest. Icons always retain visible labels.
 */
export function MobileTabBar() {
  const t = useTranslations('nav');
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  const clusters = navClusters(pathname);

  return (
    <nav
      data-testid="tab-bar"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] backdrop-blur lg:hidden"
    >
      <div className="mx-auto flex h-14 max-w-6xl items-stretch">
        {clusters.map((cluster) => (
          <Link
            key={cluster.key}
            href={cluster.href}
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
          <Link href="/settings" onClick={() => setMenuOpen(false)} className={buttonClass('secondary', 'sm', 'mt-4 w-full')}>{t('aiSettings')}</Link>
          <div className="mt-4 flex items-center gap-2 border-t border-line pt-4">
            <LocaleSwitcher />
            <ThemeSwitcher />
          </div>
        </BottomSheet>
      ) : null}
    </nav>
  );
}
