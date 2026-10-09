'use client';

import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { fillPreview } from '@/lib/hub';
import type { PublicPlot } from '@/lib/types';
import { Icon } from './Icon';
import { Avatar } from './Avatar';

/** How many faces of the roster a card shows before it starts counting instead. */
const FACES = 4;

/** One entry of the public catalogue — shared by the feed and /creators/:id. */
export function PlotCard({ plot }: { plot: PublicPlot }) {
  const t = useTranslations('explore');
  const rest = plot.characters.length - FACES;

  return (
    <Link
      href={`/p/${plot.id}`}
      data-testid="plot-card"
      className="group flex h-full flex-col overflow-hidden rounded-2xl border border-line bg-surface transition-shadow hover:border-fg hover:shadow-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
    >
      {plot.coverUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={plot.coverUrl}
          alt=""
          loading="lazy"
          data-testid="plot-cover"
          className="aspect-[16/10] w-full bg-raised/60 object-cover"
        />
      ) : (
        // Without a cover the work still needs a face, so the roster stands in
        // for one — and reads as the same block of the card either way.
        <div className="brand-dots flex aspect-[16/10] w-full flex-col items-center justify-center gap-4 border-b border-line bg-mint-soft/60">
          <Icon name="book" className="size-9 text-link" />
          <span className="line-clamp-2 px-6 text-center heading1 text-fg">{plot.name}</span>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-2.5 p-5">
        <p className="truncate body1 font-semibold text-fg">{plot.name}</p>
        <p className="truncate text-xs text-muted">{t('by', { name: plot.creatorName })}</p>
        {/* The creator's own line to readers when there is one; the opening is
            what the card falls back to, cut by the API. */}
        <p className="line-clamp-2 text-sm leading-relaxed text-muted/90">
          {fillPreview(plot.intro || plot.introPreview, plot.name, t('userMacro'))}
        </p>
        {plot.tags.length > 0 ? (
          <ul className="flex flex-wrap gap-1">
            {plot.tags.slice(0, 4).map((tag) => (
              <li key={tag} className="rounded-full bg-raised px-2 py-0.5 text-xs text-muted">
                {tag}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mt-auto flex items-center gap-2 border-t border-line pt-3">
          {plot.characters.length > 0 ? (
            <div className="flex -space-x-2" data-testid="plot-faces">
              {plot.characters.slice(0, FACES).map((member) => (
                <Avatar
                  key={member.id}
                  src={member.avatarUrl}
                  name={member.name}
                  className="size-6 border border-line text-xs"
                />
              ))}
              {rest > 0 ? (
                <span className="flex size-6 items-center justify-center rounded-full border border-line bg-raised caption2 text-muted">
                  +{rest}
                </span>
              ) : null}
            </div>
          ) : null}
          <p className="ml-auto text-xs text-muted">
            {t('chatCount', { count: plot.chatCount })} · {t('likeCount', { count: plot.likeCount })}
          </p>
        </div>
      </div>
    </Link>
  );
}

/** The responsive grid every catalogue surface uses. */
export function PlotGrid({ plots }: { plots: PublicPlot[] }) {
  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {plots.map((plot) => (
        <li key={plot.id}>
          <PlotCard plot={plot} />
        </li>
      ))}
    </ul>
  );
}
