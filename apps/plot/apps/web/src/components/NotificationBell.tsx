'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { apiGet, apiSend } from '@/lib/api';
import type { AppNotification, NotificationPage } from '@/lib/types';
import { Icon } from './Icon';
import { Button, cx } from './ui';

/** One page is the whole panel: the bell is a glance, not an inbox. */
const LIMIT = 20;

/**
 * What happened while the reader was away, and how many of it they have not
 * seen. Read on mount and whenever the window is focused again — a notification
 * is not worth a poll, and coming back to the tab is exactly when one is worth
 * knowing about.
 *
 * There is no per-row read: the API marks them all at once, so the panel does
 * too, and the badge is the one thing that has to be right.
 */
export function NotificationBell() {
  const t = useTranslations('notifications');
  const format = useFormatter();

  const [items, setItems] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  const load = useCallback((): void => {
    apiGet<NotificationPage>(`/api/notifications?limit=${LIMIT}`).then((page) => {
      setItems(page.items);
      setUnread(page.unreadCount ?? 0);
    }, () => undefined);
  }, []);

  useEffect(() => {
    load();
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, [load]);

  // The same two exits the row menu has: a click outside stands where it was
  // put, and Escape puts the reader back on the bell they opened.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent): void {
      const target = event.target;
      if (target instanceof Node && !wrapper.current?.contains(target)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  async function readAll(): Promise<void> {
    try {
      const answer = await apiSend<{ unreadCount: number }>('POST', '/api/notifications/read');
      setUnread(answer.unreadCount);
      setItems((current) => current.map((item) => ({ ...item, read: true })));
    } catch {
      // Nothing to say: the badge is still up, and the next read settles it.
    }
  }

  return (
    <div ref={wrapper} className="relative">
      <Button
        ref={trigger}
        size="sm"
        variant="ghost"
        data-testid="notification-bell"
        // The count is part of the name, so a reader who cannot see the dot is
        // still told there is something behind the button.
        aria-label={unread > 0 ? `${t('title')} — ${t('unread', { count: unread })}` : t('title')}
        title={t('title')}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name="bell" className="size-[18px]" />
        {unread > 0 ? (
          <span
            aria-hidden="true"
            data-testid="notification-badge"
            className="absolute top-0.5 right-0.5 min-w-4 rounded-full bg-accent px-1 caption2 leading-4 text-accent-ink tabular-nums"
          >
            {unread > 99 ? '99+' : unread}
          </span>
        ) : null}
      </Button>

      {open ? (
        <div
          data-testid="notification-panel"
          className="absolute right-0 z-30 mt-1 max-h-96 w-72 overflow-y-auto rounded-lg border border-line bg-raised p-1 shadow-lg"
        >
          <div className="flex items-center justify-between gap-2 px-2 py-1.5">
            <span className="text-xs font-medium text-muted">
              {t('title')}
            </span>
            <button
              type="button"
              data-testid="notification-read-all"
              disabled={unread === 0}
              onClick={() => void readAll()}
              className="text-xs text-muted transition-colors hover:text-fg disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              {t('readAll')}
            </button>
          </div>
          {items.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted">{t('empty')}</p>
          ) : (
            <ul>
              {items.map((item) => (
                <li key={item.id}>
                  <NotificationRow
                    item={item}
                    onFollow={() => setOpen(false)}
                    when={format.dateTime(new Date(item.createdAt), { dateStyle: 'short' })}
                    // Null once the account that did it is gone, and the name
                    // with it — what it was about is still worth the link.
                    what={
                      item.actorName
                        ? t('plotPublished', {
                            name: item.actorName,
                          })
                        : null
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** The published plot this notification opens, or plain text if no subject remains. */
function subjectOf(item: AppNotification): { name: string | null; href: string | null } {
  return { name: item.plotName, href: item.plotId ? `/p/${item.plotId}` : null };
}

/** One row: the thing it is about on top, who did it and when underneath. */
function NotificationRow({
  item,
  when,
  what,
  onFollow,
}: {
  item: AppNotification;
  when: string;
  /** What happened, in words; null once the account it names is gone. */
  what: string | null;
  onFollow: () => void;
}) {
  const { name, href } = subjectOf(item);
  const body = (
    <>
      <span className="block truncate text-sm text-fg">{name ?? what}</span>
      <span className="mt-0.5 block truncate text-xs text-muted">
        {name && what ? `${what} · ` : ''}
        {when}
      </span>
    </>
  );
  const className = cx(
    'block rounded-md px-2 py-2 transition-colors',
    item.read ? '' : 'bg-surface/60',
  );

  if (!href) return <span className={className}>{body}</span>;
  return (
    <Link
      href={href}
      data-testid="notification-item"
      onClick={onFollow}
      className={cx(className, 'hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus')}
    >
      {body}
    </Link>
  );
}
