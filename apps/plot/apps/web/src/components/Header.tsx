'use client';

import { useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import { useSession } from '@/lib/authClient';
import { navClusters } from '@/lib/nav';
import { Brand } from './Brand';
import { Icon } from './Icon';
import { LocaleSwitcher } from './LocaleSwitcher';
import { NotificationBell } from './NotificationBell';
import { SignOutButton } from './SignOutButton';
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
  const chatgpt = useTranslations('chatgpt');
  const pathname = usePathname();
  const { data, isPending } = useSession();

  // Three clusters for a reader who is signed in. For one who is not, the only
  // tab that leads anywhere is 탐색 — everything else is behind the way in, and
  // the way in is what the right of the bar offers instead.
  const clusters = navClusters(pathname);
  const links = data ? clusters : clusters.slice(0, 1);

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

        {/* Which controls belong here is not known until the session read lands,
            and a guess that changes a moment later moves the bar under the
            reader's finger. So it stays empty until then rather than filling
            with a placeholder that has to be taken back. */}
        <div className="ml-auto flex items-center gap-2">
          {isPending ? null : data ? (
            <>
              <Link href="/settings" className={buttonClass('secondary', 'sm')} aria-label={t('aiSettings')}>AI</Link>
              {/* The bell stays at every width: what it carries arrives while
                  the reader is elsewhere, and a phone is where they are. */}
              <NotificationBell />
              <div className="hidden items-center gap-2 lg:flex">
                <LocaleSwitcher />
                <SignOutButton />
              </div>
            </>
          ) : (
            <>
              <div className="hidden lg:flex">
                <LocaleSwitcher />
              </div>
              <Link href="/login" aria-label={chatgpt('signIn')} className={buttonClass('secondary', 'sm')}>
                <span className="text-xs sm:text-sm">{chatgpt('signIn')}</span>
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
