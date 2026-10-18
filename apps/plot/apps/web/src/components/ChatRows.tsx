'use client';

import { useFormatter } from 'next-intl';
import { Avatar } from '@/components/Avatar';
import { Link } from '@/i18n/navigation';
import { messageSnippet } from '@/lib/chatSnippet';
import type { ChatListItem } from '@/lib/types';

/**
 * Conversations as a list says them: who each is with, how it currently reads,
 * and how long ago that was — the chats page and the library's recent ones.
 * `now` is fixed by the caller, so a relative time does not re-read differently
 * on every render.
 */
export function ChatRows({ chats, now }: { chats: readonly ChatListItem[]; now: Date }) {
  const format = useFormatter();

  return (
    <ul className="space-y-3">
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
                <time dateTime={chat.updatedAt} className="shrink-0 text-xs text-muted tabular-nums">
                  {format.relativeTime(new Date(chat.updatedAt), now)}
                </time>
              </div>
              <p className="truncate text-xs text-muted">{chat.lastMessage ? messageSnippet(chat.lastMessage) : ''}</p>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
