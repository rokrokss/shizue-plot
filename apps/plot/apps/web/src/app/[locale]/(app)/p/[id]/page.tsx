'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { use, useEffect, useState } from 'react';
import { Avatar } from '@/components/Avatar';
import { CommentsSection } from '@/components/CommentsSection';
import { FollowButton } from '@/components/FollowButton';
import { StartChatPanel } from '@/components/StartChatPanel';
import { PlotStyleBadges } from '@/components/PlotStyleBadges';
import { Button, CenteredMessage, cx, ErrorText, Section, Spinner } from '@/components/ui';
import { Link, useRouter } from '@/i18n/navigation';
import { apiGet, apiSend } from '@/lib/api';
import { useSession } from '@/lib/authClient';
import { fillPreview } from '@/lib/hub';
import { signInHref } from '@/lib/nav';
import type { LikeState, PublicPlotDetail } from '@/lib/types';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { useErrorMessage } from '@/lib/useErrorMessage';

/**
 * The public page of a plot, open to anyone: the API answers this read without
 * a session, and it is the same answer for every reader — the creator's own view
 * of it differs only in what they may do with it. What a reader with no account
 * cannot do is act: liking, commenting and starting a chat lead to the way in
 * instead.
 */
export default function PublicPlotPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations('public');
  const explore = useTranslations('explore');
  const common = useTranslations('common');
  const format = useFormatter();
  const toMessage = useErrorMessage();
  const router = useRouter();
  const { data: session } = useSession();

  const [plot, setPlot] = useState<PublicPlotDetail | null>(null);
  const [missing, setMissing] = useState(false);
  /** Which opening the reader is looking at, and the one a chat would start on. */
  const [introIndex, setIntroIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
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

  const owner = session?.user.id === plot.creatorId;
  const userMacro = explore('userMacro');
  const intro = plot.intros[introIndex] ?? '';

  async function toggleLike(): Promise<void> {
    // The button is never disabled up front for a reader with no account: the
    // press is the invitation, and it leads to the way in and back here.
    if (!session) {
      router.push(signInHref(`/p/${id}`));
      return;
    }
    if (busy || !plot) return;
    const liked = !plot.likedByMe;
    setBusy(true);
    setError('');
    // Optimistic: the counter moves now and is reconciled with (or reverted to)
    // whatever the server reports.
    setPlot({ ...plot, likedByMe: liked, likeCount: plot.likeCount + (liked ? 1 : -1) });
    try {
      const state = await apiSend<LikeState>(liked ? 'POST' : 'DELETE', `/api/plots/${id}/like`);
      setPlot((current) =>
        current ? { ...current, likedByMe: state.liked, likeCount: state.likeCount } : current,
      );
    } catch (caught) {
      setPlot(plot);
      setError(toMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-5 py-10">
      {plot.coverUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={plot.coverUrl}
          alt=""
          data-testid="plot-cover"
          className="mb-6 aspect-[16/9] w-full rounded-xl border border-line object-cover"
        />
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <div className="flex flex-wrap items-center gap-4">
            <div className="min-w-0 flex-1">
              <h1 className="truncate title2 sm:title1">{plot.name}</h1>
              <div className="mt-1 flex flex-wrap items-center gap-3">
                <Link
                  href={`/creators/${plot.creatorId}`}
                  className="text-sm text-muted transition-colors hover:text-fg"
                >
                  {explore('by', { name: plot.creatorName })}
                </Link>
                {/* Beside the name it belongs to: the work is how a reader finds
                    a creator, so this is where following one is worth offering. */}
                <FollowButton creatorId={plot.creatorId} initial={plot.creatorFollow} />
              </div>
            </div>
            {owner ? (
              <Link
                href={`/plots/${plot.id}`}
                className="inline-flex h-10 shrink-0 items-center rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink transition-colors hover:bg-accent/90"
              >
                {t('edit')}
              </Link>
            ) : (
              <Button
                data-testid="like-button"
                variant={plot.likedByMe ? 'primary' : 'secondary'}
                aria-pressed={plot.likedByMe}
                onClick={() => void toggleLike()}
              >
                {/* The count is part of the name rather than hidden behind an
                    aria-label that contradicts it (WCAG 2.5.3 label in name). */}
                <span aria-hidden>{plot.likedByMe ? '♥' : '♡'}</span>
                {plot.likeCount}
                <span className="sr-only">{plot.likedByMe ? t('unlike') : t('like')}</span>
              </Button>
            )}
          </div>

          <p className="text-sm text-muted">
            {explore('likeCount', { count: plot.likeCount })} ·{' '}
            {explore('chatCount', { count: plot.chatCount })}
            {plot.publishedAt
              ? ` · ${t('publishedAt', {
                  date: format.dateTime(new Date(plot.publishedAt), { dateStyle: 'medium' }),
                })}`
              : ''}
          </p>

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

          <ErrorText>{error}</ErrorText>

          {/* The creator's line to readers, above everything the work itself says. */}
          {plot.intro ? (
            <p
              data-testid="plot-intro"
              className="text-sm leading-relaxed whitespace-pre-wrap text-fg"
            >
              {fillPreview(plot.intro, plot.name, userMacro)}
            </p>
          ) : null}

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

          {plot.commentsEnabled ? (
            <CommentsSection plotId={plot.id} count={plot.commentCount} />
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
