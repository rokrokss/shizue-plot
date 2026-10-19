'use client';

import { useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import { DEVICE_PAIRING } from '@/lib/devicePairing';
import { Icon } from './Icon';
import { cx } from './ui';

type SettingsItem = 'models' | 'display' | 'backup';

/** 설정's sections in their groups. The first is what `/settings` opens on beside the sidebar. */
const GROUPS: readonly { key: 'ai' | 'app'; items: readonly SettingsItem[] }[] = [
  { key: 'ai', items: ['models'] },
  { key: 'app', items: ['display', 'backup'] },
];

/**
 * 설정's sections, grouped. A wide screen keeps them in a sidebar beside the
 * section that is open (`sidebar`, the open one marked); a narrow one opens
 * `/settings` on them as a list of grouped rows, each with a line on what it
 * holds, that lead to a screen apiece (`hub`). Where this app can pair a phone,
 * the backup's section holds that too and says so. 페르소나 and 노트 are not
 * here: they stand behind 만들기, beside the works.
 */
export function SettingsNav({ variant }: { variant: 'sidebar' | 'hub' }) {
  const t = useTranslations('settings');
  const pathname = usePathname();
  // `/settings` shows the first section beside the sidebar.
  const open = pathname === '/settings' ? '/settings/models' : pathname;
  const label = (item: SettingsItem): string =>
    item === 'backup' && DEVICE_PAIRING ? t('items.phoneAndBackup') : t(`items.${item}`);
  const hint = (item: SettingsItem): string =>
    item === 'backup' && DEVICE_PAIRING ? t('hints.phoneAndBackup') : t(`hints.${item}`);
  const hub = variant === 'hub';

  return (
    <nav aria-label={t('title')} className={hub ? 'space-y-6' : 'space-y-5'}>
      {GROUPS.map((group) => (
        <div key={group.key}>
          <h2 className={cx('pb-2 text-xs font-medium text-muted', hub ? 'px-1' : 'px-3')}>
            {t(`groups.${group.key}`)}
          </h2>
          <ul className={hub ? 'overflow-hidden rounded-2xl border border-line bg-surface' : 'space-y-0.5'}>
            {group.items.map((item) => {
              const href = `/settings/${item}`;
              const current = !hub && open === href;
              return (
                <li key={item} className={cx(hub && 'border-t border-line first:border-t-0')}>
                  <Link
                    href={href}
                    aria-current={current ? 'page' : undefined}
                    className={cx(
                      'flex items-center gap-3 transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
                      hub
                        ? 'px-4 py-3.5 text-fg hover:bg-raised/60'
                        : cx('rounded-lg px-3 py-2 text-sm font-medium', current ? 'bg-mint-soft text-fg' : 'text-muted hover:bg-raised/60 hover:text-fg'),
                    )}
                  >
                    {hub ? (
                      <>
                        <span className="min-w-0 flex-1">
                          <span className="block body14 font-medium">{label(item)}</span>
                          <span className="mt-0.5 block truncate text-xs text-muted">{hint(item)}</span>
                        </span>
                        <Icon name="back" className="size-4 shrink-0 rotate-180 text-muted" />
                      </>
                    ) : (
                      label(item)
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** `/settings` on a narrow screen: 설정 and its sections, a screen apiece. */
export function SettingsHub() {
  const t = useTranslations('settings');
  return (
    <div className="space-y-6">
      <h1 className="title2 sm:title1">{t('title')}</h1>
      <SettingsNav variant="hub" />
    </div>
  );
}
