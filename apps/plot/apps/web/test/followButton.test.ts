// @vitest-environment jsdom
/**
 * Following a creator: the state the button shows, the count in its own name,
 * and the two readers it is not a button for — the creator themselves, whose
 * follow the API refuses, and one with no account, for whom the press is the
 * invitation and leads to the way in and back.
 *
 * `createElement` rather than JSX, matching the other component tests.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/ko.json';
import type { Creator, FollowState } from '../src/lib/types';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

/** Who is reading; null is a reader with no account. */
let session: { user: { id: string; name: string } } | null = {
  user: { id: 'usr_2', name: '독자' },
};
const push = vi.fn<(href: string) => void>();
/** Every follow write the button has sent, as `METHOD path`. */
let sent: string[] = [];
/** What the next write answers with; a rejection is how a failure is tested. */
let answer: () => Promise<FollowState> = () =>
  Promise.resolve({ followerCount: 3, followedByMe: true });

vi.mock('@/i18n/navigation', async () => {
  const { createElement: h } = await import('react');
  return {
    Link: ({ href, children }: { href: string; children?: ReactNode }) => h('a', { href }, children),
    usePathname: () => '/p/sty_1',
    useRouter: () => ({ push }),
  };
});

vi.mock('@/lib/authClient', () => ({
  useSession: () => ({ data: session, isPending: false }),
}));

const creator: Creator = {
  id: 'usr_1',
  name: '록',
  followerCount: 2,
  followedByMe: false,
  publicPlots: [],
};

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/api')>()),
  apiGet: () => Promise.resolve(creator),
  apiSend: (method: string, path: string) => {
    sent.push(`${method} ${path}`);
    return answer();
  },
}));

const { FollowButton } = await import('../src/components/FollowButton');

let host: HTMLElement;
let root: Root;

async function render(initial?: FollowState): Promise<void> {
  await act(async () => {
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'ko',
        messages,
        children: createElement(FollowButton, {
          creatorId: 'usr_1',
          ...(initial ? { initial } : {}),
        }) as ReactNode,
      }),
    );
  });
}

const button = (): HTMLButtonElement | null => host.querySelector('[data-testid="follow-button"]');

async function click(node: Element): Promise<void> {
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  session = { user: { id: 'usr_2', name: '독자' } };
  sent = [];
  answer = () => Promise.resolve({ followerCount: 3, followedByMe: true });
  push.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the follow button', () => {
  it('carries the state and the count the page already read', async () => {
    await render({ followerCount: 2, followedByMe: false });
    expect(button()!.getAttribute('aria-pressed')).toBe('false');
    expect(button()!.textContent).toBe('팔로우2');
  });

  it('asks for its own state where the page has none', async () => {
    await render();
    expect(button()!.textContent).toBe('팔로우2');
  });

  it('moves the count on the press and settles on what the server says', async () => {
    await render({ followerCount: 2, followedByMe: false });
    await click(button()!);

    expect(sent).toEqual(['POST /api/creators/usr_1/follow']);
    expect(button()!.getAttribute('aria-pressed')).toBe('true');
    expect(button()!.textContent).toBe('팔로잉3');

    answer = () => Promise.resolve({ followerCount: 2, followedByMe: false });
    await click(button()!);
    expect(sent).toEqual(['POST /api/creators/usr_1/follow', 'DELETE /api/creators/usr_1/follow']);
    expect(button()!.textContent).toBe('팔로우2');
  });

  it('puts the button back where it was when the write fails', async () => {
    await render({ followerCount: 2, followedByMe: false });
    answer = () => Promise.reject(new Error('nope'));
    await click(button()!);

    expect(button()!.getAttribute('aria-pressed')).toBe('false');
    expect(button()!.textContent).toBe('팔로우2');
  });

  it('leads a reader with no account to the way in, and back to this page', async () => {
    session = null;
    await render({ followerCount: 2, followedByMe: false });
    await click(button()!);

    expect(sent).toEqual([]);
    expect(push).toHaveBeenCalledWith('/login?next=%2Fp%2Fsty_1');
  });

  it('gives the creator their own count and no button at all', async () => {
    session = { user: { id: 'usr_1', name: '록' } };
    await render({ followerCount: 2, followedByMe: false });

    expect(button()).toBeNull();
    expect(host.querySelector('[data-testid="follower-count"]')?.textContent).toBe('팔로워 2명');
  });
});
