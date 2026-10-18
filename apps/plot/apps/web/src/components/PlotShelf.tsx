'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import type { Plot } from '@/lib/types';

/**
 * The owner's works as a grid of covers — the studio's list, where a tile opens
 * the editor, and the library, where it opens the work page a chat starts on.
 */
export function PlotShelf({ plots, href }: { plots: readonly Plot[]; href: (plot: Plot) => string }) {
  const t = useTranslations('plots');
  const format = useFormatter();

  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 md:grid-cols-4 lg:grid-cols-5">
      {plots.map((plot) => (
        <li key={plot.id}>
          <Link
            href={href(plot)}
            data-testid="plot-row"
            className="flex h-full flex-col overflow-hidden rounded-2xl border border-line bg-surface transition-shadow hover:border-fg hover:shadow-card"
          >
            {plot.coverUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={plot.coverUrl} alt="" loading="lazy" className="aspect-[2/3] w-full bg-raised/60 object-cover" />
            ) : (
              <div className="brand-dots flex aspect-[2/3] w-full items-center justify-center bg-mint-soft/60">
                <span className="line-clamp-3 px-4 text-center heading1">{plot.name}</span>
              </div>
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-2 p-3 sm:p-4">
              <p className="min-w-0 truncate text-sm font-medium text-fg">{plot.name}</p>
              <p className="line-clamp-2 text-xs leading-relaxed text-muted">
                {plot.intro || plot.description || t('noDescription')}
              </p>
              <p className="mt-auto pt-1 text-xs text-muted">
                {t('updatedAt', { date: format.dateTime(new Date(plot.updatedAt), { dateStyle: 'medium' }) })}
              </p>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
