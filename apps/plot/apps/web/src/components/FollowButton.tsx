'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { usePathname, useRouter } from '@/i18n/navigation';
import { apiGet, apiSend } from '@/lib/api';
import { useSession } from '@/lib/authClient';
import { signInHref } from '@/lib/nav';
import type { Creator, FollowState } from '@/lib/types';
import { Button } from './ui';

/**
 * Following a creator, wherever their name is: their own page, which already
 * knows the edge, and a plot page, which does not and asks for it.
 *
 * Nobody follows themselves — the API refuses it — so the creator gets no button
 * on their own work at all. A reader with no account keeps one: the press is the
 * invitation, and it leads to the way in and back to the page they were on, the
 * same trip the like button takes.
 */
export function FollowButton({
  creatorId,
  initial,
}: {
  creatorId: string;
  /** The state the page already read; without it this asks for its own. */
  initial?: FollowState;
}) {
  const t = useTranslations('creators');
  const router = useRouter();
  const pathname = usePathname();
  const { data: session } = useSession();

  const [state, setState] = useState<FollowState | null>(initial ?? null);
  const [busy, setBusy] = useState(false);

  const self = session?.user.id === creatorId;
  // Only where the page could not hand it over. A failed read leaves the button
  // out rather than announcing itself: following is not why the reader came.
  useEffect(() => {
    if (initial || self) return;
    apiGet<Creator>(`/api/creators/${creatorId}`).then(
      (creator) => setState({ followerCount: creator.followerCount, followedByMe: creator.followedByMe }),
      () => undefined,
    );
  }, [creatorId, initial, self]);

  if (!state) return null;
  // Their own page, where the count is still worth knowing and the button would
  // be a 400 waiting to happen.
  if (self) {
    return (
      <span data-testid="follower-count" className="text-sm text-muted">
        {t('followerCount', { count: state.followerCount })}
      </span>
    );
  }

  async function toggle(): Promise<void> {
    if (!session) {
      router.push(signInHref(pathname));
      return;
    }
    if (busy || !state) return;
    const following = !state.followedByMe;
    const before = state;
    setBusy(true);
    // Optimistic, like the like: the count moves now and is reconciled with —
    // or reverted to — whatever the server answers with.
    setState({
      followedByMe: following,
      followerCount: state.followerCount + (following ? 1 : -1),
    });
    try {
      setState(
        await apiSend<FollowState>(following ? 'POST' : 'DELETE', `/api/creators/${creatorId}/follow`),
      );
    } catch {
      // Nothing to say: the button is back where it was, which is the answer.
      setState(before);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      data-testid="follow-button"
      variant={state.followedByMe ? 'secondary' : 'primary'}
      aria-pressed={state.followedByMe}
      disabled={busy}
      onClick={() => void toggle()}
    >
      {/* The count is part of the name rather than hidden behind a label that
          contradicts it (WCAG 2.5.3 label in name). */}
      {state.followedByMe ? t('following') : t('follow')}
      <span className="tabular-nums">{state.followerCount}</span>
    </Button>
  );
}
