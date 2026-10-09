'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { Avatar } from '@/components/Avatar';
import { buttonClass, ErrorText, Spinner } from '@/components/ui';
import { Link } from '@/i18n/navigation';
import { apiGet } from '@/lib/api';
import { messageSnippet } from '@/lib/chatSnippet';
import type { ChatListItem } from '@/lib/types';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { useErrorMessage } from '@/lib/useErrorMessage';

/**
 * Every conversation the reader has open, most recently touched first. The API
 * orders them, so this page only has to say what each one is: who it is with,
 * how it currently reads, and how long ago that was.
 */
export default function ChatsPage() {
  const t = useTranslations('chat');
  const rebrand = useTranslations('rebrand');
  const common = useTranslations('common');
  const format = useFormatter();
  const toMessage = useErrorMessage();
  useDocumentTitle(t('listTitle'));

  const [chats, setChats] = useState<ChatListItem[] | null>(null);
  const [error, setError] = useState('');
  // Fixed at mount: a relative time that re-computed every render would make the
  // list re-read differently for no reason the reader did anything about.
  const [now] = useState(() => new Date());

  useEffect(() => {
    apiGet<ChatListItem[]>('/api/chats').then(setChats, (caught: unknown) =>
      setError(toMessage(caught)),
    );
  }, [toMessage]);

  return (
    <div className="mx-auto w-full max-w-3xl px-5 py-10">
      <h1 className="title2 sm:title1">{t('listTitle')}</h1>
      <p className="mt-2 text-sm text-muted">{rebrand('chatSubtitle')}</p>

      <div className="mt-4">
        <ErrorText>{error}</ErrorText>
      </div>

      {chats === null ? (
        error ? null : (
          <div className="flex justify-center py-16">
            <Spinner label={common('loading')} />
          </div>
        )
      ) : chats.length === 0 ? (
        <div className="mt-6 flex flex-col items-center rounded-2xl border border-line bg-surface px-5 py-14 text-center">
          <span className="mb-5 flex size-14 items-center justify-center rounded-2xl bg-mint-soft"><Icon name="chats" className="size-6" /></span>
          <p className="text-sm text-muted">{t('listEmpty')}</p>
          <Link href="/" className={buttonClass('primary', 'md', 'mt-5')}>{rebrand('emptyAction')}</Link>
        </div>
      ) : (
        <ul className="mt-6 space-y-3">
          {chats.map((chat) => (
            <li key={chat.id}>
              <Link
                href={`/chats/${chat.id}`}
                className="flex items-center gap-4 rounded-2xl border border-line bg-surface p-4 transition-colors hover:border-fg hover:bg-mint-soft/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                <Avatar src={chat.coverUrl} name={chat.title} className="size-11 text-base" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{chat.title}</span>
                    <time
                      dateTime={chat.updatedAt}
                      className="shrink-0 text-xs text-muted tabular-nums"
                    >
                      {format.relativeTime(new Date(chat.updatedAt), now)}
                    </time>
                  </div>
                  <p className="truncate text-xs text-muted">
                    {chat.lastMessage ? messageSnippet(chat.lastMessage) : ''}
                  </p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
