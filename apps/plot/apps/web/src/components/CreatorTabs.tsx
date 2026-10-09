'use client';

import { useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import { cx } from './ui';

/** The management surfaces behind the 만들기 tab. */
const TABS = [
  { href: '/plots', label: 'plots' },
  { href: '/personas', label: 'personas' },
  { href: '/notes', label: 'notes' },
] as const;

/**
 * Tab row of the creator area. A plain container rather than a second <nav>:
 * the header already owns the page's navigation landmark. It wraps rather than
 * overflows, so a narrow screen never has to scroll it sideways.
 */
export function CreatorTabs() {
  const t = useTranslations('creatorTabs');
  const pathname = usePathname();

  return (
    <div className="flex w-fit flex-wrap gap-1 rounded-xl border border-line bg-surface p-1">
      {TABS.map((tab) => {
        const active = pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={cx(
              'rounded-md px-3 py-1.5 text-sm transition-colors',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
              active ? 'bg-mint-soft font-semibold text-fg' : 'text-muted hover:text-fg',
            )}
          >
            {t(tab.label)}
          </Link>
        );
      })}
    </div>
  );
}
