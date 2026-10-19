'use client';

import { useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import { navClusters } from '@/lib/nav';
import { Icon } from './Icon';
import { cx } from './ui';

const TAB =
  'flex flex-1 flex-col gap-1 items-center justify-center px-1 button10 transition-colors ' +
  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus';

/**
 * The phone's navigation, at the edge a thumb reaches: the four clusters, 설정
 * last, where everything a reader sets up is gathered. Icons always retain
 * visible labels.
 */
export function MobileTabBar() {
  const t = useTranslations('nav');
  const pathname = usePathname();

  return (
    <nav
      data-testid="tab-bar"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] backdrop-blur lg:hidden"
    >
      <div className="mx-auto flex h-14 max-w-6xl items-stretch">
        {navClusters(pathname).map((cluster) => (
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
      </div>
    </nav>
  );
}
