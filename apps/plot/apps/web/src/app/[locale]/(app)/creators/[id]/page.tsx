'use client';

import { useTranslations } from 'next-intl';
import { use, useEffect, useState } from 'react';
import { FollowButton } from '@/components/FollowButton';
import { PlotGrid } from '@/components/PlotCard';
import { CenteredMessage, Spinner } from '@/components/ui';
import { apiGet } from '@/lib/api';
import type { Creator } from '@/lib/types';
import { useDocumentTitle } from '@/lib/useDocumentTitle';

/** A creator and every plot they have published, in every content language. */
export default function CreatorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations('creators');
  const common = useTranslations('common');

  const [creator, setCreator] = useState<Creator | null>(null);
  const [missing, setMissing] = useState(false);
  useDocumentTitle(creator?.name);

  useEffect(() => {
    apiGet<Creator>(`/api/creators/${id}`).then(setCreator, () => setMissing(true));
  }, [id]);

  if (missing) return <CenteredMessage>{t('notFound')}</CenteredMessage>;
  if (!creator) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner label={common('loading')} />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-5 py-10">
      <div className="flex flex-wrap items-center gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="truncate title2 sm:title1">{creator.name}</h1>
          <p className="mt-1 text-sm text-muted">
            {t('plotCount', { count: creator.publicPlots.length })}
          </p>
        </div>
        <FollowButton
          creatorId={creator.id}
          initial={{ followerCount: creator.followerCount, followedByMe: creator.followedByMe }}
        />
      </div>

      <div className="mt-6">
        {creator.publicPlots.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line py-20 text-center">
            <p className="text-sm text-muted">{t('empty')}</p>
          </div>
        ) : (
          <PlotGrid plots={creator.publicPlots} />
        )}
      </div>
    </div>
  );
}
