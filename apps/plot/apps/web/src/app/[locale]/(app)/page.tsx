'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { BrandGarden } from '@/components/Brand';
import { ChatRows } from '@/components/ChatRows';
import { Icon } from '@/components/Icon';
import { PlotShelf } from '@/components/PlotShelf';
import { buttonClass, ErrorText, Spinner } from '@/components/ui';
import { Link } from '@/i18n/navigation';
import { apiGet } from '@/lib/api';
import type { ChatListItem, Plot } from '@/lib/types';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { useErrorMessage } from '@/lib/useErrorMessage';

/**
 * How many of the latest conversations the library shows before 모든 대화 on a
 * wide screen; a narrow one, where the tab bar stands, shows the first three.
 */
const RECENT_CHATS = 4;

/**
 * The app's landing page: the owner's library — the conversations they were
 * last in, and their works, each opening the work page a chat starts on. The
 * same lists the chats page and the studio's list read (`GET /api/chats`,
 * `GET /api/plots`).
 */
export default function LibraryPage() {
  const t = useTranslations('library');
  const rebrand = useTranslations('rebrand');
  const common = useTranslations('common');
  const toMessage = useErrorMessage();
  useDocumentTitle(t('title'));

  const [chats, setChats] = useState<ChatListItem[] | null>(null);
  const [plots, setPlots] = useState<Plot[] | null>(null);
  const [error, setError] = useState('');
  // Fixed at mount, as the chats page fixes it.
  const [now] = useState(() => new Date());

  useEffect(() => {
    apiGet<ChatListItem[]>('/api/chats').then(setChats, (caught: unknown) => setError(toMessage(caught)));
    apiGet<Plot[]>('/api/plots').then(setPlots, (caught: unknown) => setError(toMessage(caught)));
  }, [toMessage]);

  return (
    <div className="mx-auto w-full max-w-6xl px-5 py-10">
      <section className="brand-dots relative grid overflow-hidden rounded-3xl border border-line bg-mint-soft md:grid-cols-[1fr_280px]">
        <div className="p-6 sm:p-8 lg:p-10">
          <span className="inline-flex items-center gap-2 rounded-full border border-fg bg-surface px-3 py-1.5 text-xs font-semibold">
            <span aria-hidden="true" className="size-2 bg-accent" />{rebrand('eyebrow')}
          </span>
          <h1 className="mt-5 max-w-xl title24 sm:title32">{rebrand('journeyTitle')}</h1>
          <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted sm:text-base">{rebrand('journeySubtitle')}</p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link href="/plots" className={buttonClass('primary')}>
              {rebrand('create')}<Icon name="arrow" className="size-4" />
            </Link>
          </div>
        </div>
        <div className="hidden items-center justify-center pr-8 md:flex"><BrandGarden compact /></div>
      </section>

      <div className="mt-4">
        <ErrorText>{error}</ErrorText>
      </div>

      {chats && chats.length > 0 ? (
        <section className="mt-10" data-testid="library-chats">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="heading1">{t('recentChats')}</h2>
            <Link href="/chats" className="text-sm text-muted transition-colors hover:text-fg">{t('allChats')}</Link>
          </div>
          <div className="mt-4 max-lg:[&>ul>li:nth-child(3)]:mb-0 max-lg:[&>ul>li:nth-child(n+4)]:hidden">
            <ChatRows chats={chats.slice(0, RECENT_CHATS)} now={now} />
          </div>
        </section>
      ) : null}

      <section className="mt-10" data-testid="library-works">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="heading1">{t('works')}</h2>
          <Link href="/plots" className="text-sm text-muted transition-colors hover:text-fg">{t('manageWorks')}</Link>
        </div>
        {plots === null ? (
          error ? null : (
            <div className="flex justify-center py-20">
              <Spinner label={common('loading')} />
            </div>
          )
        ) : plots.length === 0 ? (
          <div className="mt-4 flex flex-col items-center rounded-2xl border border-line bg-surface px-5 py-14 text-center">
            <span className="mb-5 flex size-14 items-center justify-center rounded-2xl bg-mint-soft"><Icon name="library" className="size-6" /></span>
            <p className="text-sm text-muted">{t('empty')}</p>
            <Link href="/plots" className={buttonClass('primary', 'md', 'mt-5')}>{rebrand('create')}</Link>
          </div>
        ) : (
          <div className="mt-4">
            <PlotShelf plots={plots} href={(plot) => `/p/${plot.id}`} />
          </div>
        )}
      </section>
    </div>
  );
}
