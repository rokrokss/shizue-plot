'use client';

import { useTranslations } from 'next-intl';
import type { FollowState } from '@/lib/types';

/**
 * A creator's follower count, wherever their name is, from the state the page
 * already read. Every work here is the owner's, and nobody follows themselves —
 * the API refuses it — so there is no button to press.
 */
export function FollowButton({ initial }: { initial: FollowState }) {
  const t = useTranslations('creators');
  return (
    <span data-testid="follower-count" className="text-sm text-muted">
      {t('followerCount', { count: initial.followerCount })}
    </span>
  );
}
