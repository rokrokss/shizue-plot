'use client';

import { useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import { navClusters } from '@/lib/nav';
import { Brand } from './Brand';
import { Icon } from './Icon';
import { LocaleSwitcher } from './LocaleSwitcher';
import { NotificationBell } from './NotificationBell';
import { ThemeSwitcher } from './ThemeSwitcher';
import { buttonClass, cx } from './ui';

function NavLink({ href, label, active, icon }: { href: string; label: string; active: boolean; icon: 'explore' | 'chats' | 'create' }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cx(
        'inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        active ? 'bg-mint-soft text-fg' : 'text-muted hover:bg-raised/60 hover:text-fg',
      )}
    >
      <Icon name={icon} className="size-4" />
      {label}
    </Link>
  );
}

export function Header() {
  const t = useTranslations('nav');
  const pathname = usePathname();
  const links = navClusters(pathname);

  return (
    <header className="sticky top-0 z-20 border-b border-line bg-surface/95 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-1 px-4 sm:px-5">
        <Link href="/" className="mr-1 rounded-md sm:mr-6">
          <Brand />
        </Link>

        {/* Wide enough for the clusters and they stand in the bar. Narrower than
            that they would push everything else off the screen, so the tab bar
            at the bottom edge carries them instead — the same breakpoint the
            chat's own header uses for its settings. */}
        <nav className="hidden items-center gap-0.5 lg:flex">
          {links.map((cluster) => (
            <NavLink
              key={cluster.key}
              href={cluster.href}
              label={t(cluster.key)}
              icon={cluster.key}
              active={cluster.active}
            />
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <Link href="/settings" className={buttonClass('secondary', 'sm')} aria-label={t('aiSettings')}>AI</Link>
          {/* The bell stays at every width: what it carries arrives while
              the reader is elsewhere, and a phone is where they are. Only a
              conversation on a phone hides the whole bar (the layout). */}
          <NotificationBell />
          <div className="hidden items-center gap-2 lg:flex">
            <LocaleSwitcher />
            <ThemeSwitcher />
          </div>
        </div>
      </div>
    </header>
  );
}
