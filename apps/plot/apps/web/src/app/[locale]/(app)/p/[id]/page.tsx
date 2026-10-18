'use client';

import { useTranslations } from 'next-intl';
import { use, useEffect, useState } from 'react';
import { Avatar } from '@/components/Avatar';
import { PlotIntro } from '@/components/PlotIntro';
import { StartChatPanel } from '@/components/StartChatPanel';
import { PlotStyleBadges } from '@/components/PlotStyleBadges';
import { CenteredMessage, cx, Section, Spinner } from '@/components/ui';
import { Link } from '@/i18n/navigation';
import { apiGet } from '@/lib/api';
import { fillPreview } from '@/lib/greeting';
import type { PublicPlotDetail } from '@/lib/types';
import { useDocumentTitle } from '@/lib/useDocumentTitle';

/**
 * A work's own page, where a chat starts: its cover, its cast and its openings,
 * and beside the title the way into the editor.
 */
export default function WorkPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations('public');
  const common = useTranslations('common');

  const [plot, setPlot] = useState<PublicPlotDetail | null>(null);
  const [missing, setMissing] = useState(false);
  /** Which opening the reader is looking at, and the one a chat would start on. */
  const [introIndex, setIntroIndex] = useState(0);
  useDocumentTitle(plot?.name);

  useEffect(() => {
    apiGet<PublicPlotDetail>(`/api/plots/${id}/public`).then(setPlot, () => setMissing(true));
  }, [id]);

  if (missing) return <CenteredMessage>{t('notFound')}</CenteredMessage>;
  if (!plot) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner label={common('loading')} />
      </div>
    );
  }

  const userMacro = t('userMacro');
  const intro = plot.intros[introIndex] ?? '';

  return (
    <div className="mx-auto w-full max-w-6xl px-5 py-10">
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {/* A portrait poster beside the title, as covers are drawn: a wide
              banner would keep only the middle band of one. */}
          <div className="flex items-start gap-4 sm:gap-6">
            {plot.coverUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={plot.coverUrl}
                alt=""
                data-testid="plot-cover"
                className="aspect-[2/3] w-28 shrink-0 rounded-xl border border-line object-cover sm:w-44"
              />
            ) : null}
            <div className="min-w-0 flex-1 space-y-4">
              <div className="flex flex-wrap items-center gap-4">
                {/* The basis lets the button drop under a title the poster leaves narrow. */}
                <div className="min-w-0 flex-1 basis-48">
                  <h1 className="title2 sm:title1">{plot.name}</h1>
                </div>
                <Link
                  href={`/plots/${plot.id}`}
                  className="inline-flex h-10 shrink-0 items-center rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink transition-colors hover:bg-accent/90"
                >
                  {t('edit')}
                </Link>
              </div>

              {plot.tags.length > 0 ? (
                <ul className="flex flex-wrap gap-1.5">
                  {plot.tags.map((tag) => (
                    <li key={tag} className="rounded-full bg-raised px-3 py-1 text-xs text-muted">
                      {tag}
                    </li>
                  ))}
                </ul>
              ) : null}

              {/* Under the tags, and quieter than them: a tag is what the work is
                  about, these are how it is told. */}
              <PlotStyleBadges style={plot.style} pov={plot.narrator?.pov} />
            </div>
          </div>

          {/* The creator's line about the work, above everything the work itself says. */}
          {plot.intro ? <PlotIntro text={fillPreview(plot.intro, plot.name, userMacro)} /> : null}

          {plot.characters.length > 0 ? (
            <Section title={t('cast')}>
              <ul className="space-y-3">
                {plot.characters.map((member) => (
                  <li key={member.id} data-testid="plot-member" className="flex items-start gap-3">
                    <Avatar
                      src={member.avatarUrl}
                      name={member.name}
                      className="size-10 text-base"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-fg">{member.name}</p>
                      {member.intro ? (
                        <p className="mt-0.5 text-xs leading-relaxed whitespace-pre-wrap text-muted">
                          {fillPreview(member.intro, member.name, userMacro)}
                        </p>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {plot.intros.length > 0 ? (
            <Section title={t('intros')}>
              {/* The picker is the previews; the one that is chosen shows whole,
                  because a prologue is meant to be read — and it is the opening
                  the chat below starts on. */}
              {plot.intros.length > 1 ? (
                <ul className="flex flex-wrap gap-2">
                  {plot.introPreviews.map((preview, index) => (
                    <li key={index} className="min-w-0">
                      <button
                        type="button"
                        data-testid="intro-pick"
                        aria-pressed={index === introIndex}
                        onClick={() => setIntroIndex(index)}
                        className={cx(
                          'max-w-xs rounded-lg border px-3 py-2 text-left text-xs transition-colors',
                          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                          index === introIndex
                            ? 'border-accent/60 bg-raised text-fg'
                            : 'border-line text-muted hover:text-fg',
                        )}
                      >
                        <span className="block font-medium">
                          {t('introLabel', { index: index + 1 })}
                        </span>
                        <span className="mt-0.5 line-clamp-2 block">
                          {fillPreview(preview, plot.name, userMacro)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <p
                data-testid="intro-text"
                className="text-sm leading-relaxed whitespace-pre-wrap text-fg"
              >
                {fillPreview(intro, plot.name, userMacro)}
              </p>
            </Section>
          ) : null}
        </div>

        <div className="space-y-6">
          <StartChatPanel
            plotId={plot.id}
            introIndex={plot.intros.length > 0 ? introIndex : undefined}
            profiles={plot.profiles}
          />
        </div>
      </div>
    </div>
  );
}
