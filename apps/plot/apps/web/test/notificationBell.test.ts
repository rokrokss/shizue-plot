// @vitest-environment jsdom
/**
 * The header's bell: the badge it wears, the panel behind it, and 모두 읽음 —
 * which is the only read there is, since the API has no per-row one.
 *
 * The list is read on mount and again whenever the window is focused; there is
 * no poll, so the focus listener is the whole of "while you were away".
 *
 * `createElement` rather than JSX, matching the other component tests.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/ko.json';
import type { NotificationPage } from '../src/lib/types';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

/** What the next list read answers with, and how many reads there have been. */
let page: NotificationPage;
let reads = 0;
/** Every write the bell has sent. */
let sent: string[] = [];

vi.mock('@/i18n/navigation', async () => {
  const { createElement: h } = await import('react');
  return {
    Link: ({ href, children, ...rest }: { href: string; children?: ReactNode }) =>
      h('a', { ...rest, href }, children),
  };
});

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/api')>()),
  apiGet: () => {
    reads += 1;
    return Promise.resolve(page);
  },
  apiSend: (method: string, path: string) => {
    sent.push(`${method} ${path}`);
    return Promise.resolve({ unreadCount: 0 });
  },
}));

const { NotificationBell } = await import('../src/components/NotificationBell');

const filled = (): NotificationPage => ({
  items: [
    {
      id: 'ntf_1',
      kind: 'plot_published',
      actorId: 'usr_1',
      actorName: '록',
      plotId: 'sty_1',
      plotName: '비 오는 밤의 서점',
      read: false,
      createdAt: '2026-08-16T00:00:00.000Z',
    },
  ],
  nextCursor: null,
  unreadCount: 1,
});

let host: HTMLElement;
let root: Root;

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'ko',
        timeZone: 'Asia/Seoul',
        messages,
        children: createElement(NotificationBell) as ReactNode,
      }),
    );
  });
}

const bell = (): HTMLButtonElement => host.querySelector('[data-testid="notification-bell"]')!;
const badge = (): HTMLElement | null => host.querySelector('[data-testid="notification-badge"]');
const panel = (): HTMLElement | null => host.querySelector('[data-testid="notification-panel"]');
const rows = (): HTMLElement[] => [
  ...host.querySelectorAll<HTMLElement>('[data-testid="notification-item"]'),
];

async function click(node: Element): Promise<void> {
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  page = filled();
  reads = 0;
  sent = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the notification bell', () => {
  it('wears the unread count, and says it in its own name', async () => {
    await render();
    expect(badge()?.textContent).toBe('1');
    expect(bell().getAttribute('aria-label')).toBe('알림 — 읽지 않은 알림 1개');
  });

  it('re-reads when the window is focused again, and never polls', async () => {
    await render();
    expect(reads).toBe(1);

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(reads).toBe(2);
  });

  it('lists what happened, each row leading to the plot it is about', async () => {
    await render();
    expect(panel()).toBeNull();

    await click(bell());
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.getAttribute('href')).toBe('/p/sty_1');
    expect(rows()[0]!.textContent).toContain('비 오는 밤의 서점');
    expect(rows()[0]!.textContent).toContain('록님이 새 플롯을 공개했습니다.');
  });

  it('marks everything read at once, and drops the badge with it', async () => {
    await render();
    await click(bell());
    await click(host.querySelector('[data-testid="notification-read-all"]')!);

    expect(sent).toEqual(['POST /api/notifications/read']);
    expect(badge()).toBeNull();
    // Nothing is left claiming to be unread, without a second read of the list.
    expect(reads).toBe(1);
  });

  it('wears no badge and says so when there is nothing new', async () => {
    page = { items: [], nextCursor: null, unreadCount: 0 };
    await render();

    expect(badge()).toBeNull();
    expect(bell().getAttribute('aria-label')).toBe('알림');
    await click(bell());
    expect(panel()!.textContent).toContain('새 알림이 없습니다.');
  });
});
