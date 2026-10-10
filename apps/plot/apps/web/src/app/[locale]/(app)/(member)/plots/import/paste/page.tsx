'use client';

import { MIGRATION_PLATFORMS_ENABLED, type MigrationPlatform } from '@shizue/core/migrate';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { CreatorTabs } from '@/components/CreatorTabs';
import { Badge, Button, buttonClass, cx } from '@/components/ui';
import { Link } from '@/i18n/navigation';
import { browserStorage, clearSaved, hasSaved, MIGRATION_PLATFORMS } from '@/lib/migrate/wizard';
import { useDocumentTitle } from '@/lib/useDocumentTitle';

/**
 * Where a paste migration starts (`/plots/import/paste`): the five Korean
 * platforms a creator may be moving from. Only the ones the core has a schema
 * and a mapper for open; the rest are named and wait. A site with a form saved
 * in this browser says so, and the saved copy can be dropped from here.
 */
export default function PasteMigrationPickerPage() {
  const t = useTranslations('migrate');
  useDocumentTitle(t('title'));
  /** Sites with a saved form; read after mount, since only the browser has them. */
  const [saved, setSaved] = useState<ReadonlySet<MigrationPlatform>>(new Set());
  const [cleared, setCleared] = useState(false);

  useEffect(() => {
    const storage = browserStorage();
    setSaved(new Set(MIGRATION_PLATFORMS.filter((platform) => hasSaved(storage, platform))));
  }, []);

  function clear(platform: MigrationPlatform): void {
    clearSaved(browserStorage(), platform);
    setSaved((current) => new Set([...current].filter((each) => each !== platform)));
    setCleared(true);
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-5 py-10">
      <CreatorTabs />

      <div className="mt-6">
        <Link href="/plots" className="text-xs text-link underline underline-offset-2">
          {t('back')}
        </Link>
        <h1 className="mt-2 title2 sm:title1">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted">{t('subtitle')}</p>
      </div>

      <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2" data-testid="migrate-sites">
        {MIGRATION_PLATFORMS.map((platform) => {
          const enabled = MIGRATION_PLATFORMS_ENABLED.includes(platform);
          const hasDraft = enabled && saved.has(platform);
          return (
            <li
              key={platform}
              data-testid="migrate-site"
              data-platform={platform}
              aria-disabled={!enabled || undefined}
              className={cx(
                'flex flex-col gap-3 rounded-2xl border bg-surface p-5',
                enabled ? 'border-line' : 'border-line/70 opacity-60',
              )}
            >
              <div className="flex items-center gap-2">
                <h2 className="heading2 text-fg">{t(`platforms.${platform}`)}</h2>
                {!enabled ? <Badge>{t('comingSoon')}</Badge> : null}
                {hasDraft ? <Badge tone="public">{t('savedDraft')}</Badge> : null}
              </div>
              <p className="text-sm text-muted">{t(`platformHints.${platform}`)}</p>
              {enabled ? (
                <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
                  <Link
                    href={`/plots/import/paste/${platform}`}
                    data-testid={`migrate-open-${platform}`}
                    className={buttonClass('primary', 'sm')}
                  >
                    {hasDraft ? t('continue') : t('start')}
                  </Link>
                  {hasDraft ? (
                    <Button size="sm" variant="ghost" onClick={() => clear(platform)}>
                      {t('clearSaved')}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      <p aria-live="polite" className="mt-3 text-xs text-muted">
        {cleared ? t('savedCleared') : ''}
      </p>

      <p className="mt-3 rounded-xl border border-line bg-raised/50 px-4 py-3 text-xs leading-relaxed text-muted">
        {t('privacy')}
      </p>
    </div>
  );
}
