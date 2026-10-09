// @vitest-environment jsdom
/**
 * The plot page's like button and the one
 * thing they have to get right: the name a screen reader reads has to contain
 * the count the button shows (WCAG 2.5.3). An `aria-label` of "좋아요" over a
 * face reading "♥ 12" is a button nobody can ask for by its name.
 *
 * `createElement` rather than JSX, matching the other component tests.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, Suspense, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/ko.json';
import type { LikeState, PublicPlotDetail } from '../src/lib/types';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

/** What the next like/unlike round trip answers with. */
let likeState: LikeState = { liked: true, likeCount: 13 };

vi.mock('@/i18n/navigation', async () => {
  const { createElement: h } = await import('react');
  return {
    Link: ({ href, children }: { href: string; children: ReactNode }) => h('a', { href }, children),
    usePathname: () => '/p/sty_1',
    useRouter: () => ({ push: vi.fn() }),
  };
});

// Both buttons act, so both need a reader who may: signed out they lead to the
// login page instead, which is what plotGate.test.ts is about. The reader is
// not the creator here, or the page would offer an edit link in place of the like.
vi.mock('@/lib/authClient', () => ({
  useSession: () => ({ data: { user: { id: 'usr_2', name: '독자' } }, isPending: false }),
}));
vi.mock('@/components/StartChatPanel', () => ({ StartChatPanel: () => null }));
vi.mock('@/components/CommentsSection', () => ({ CommentsSection: () => null }));

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/api')>()),
  apiGet: (url: string) =>
    Promise.resolve(
      url.startsWith('/api/creators/')
        ? { id: 'usr_1', name: '록', followerCount: 0, followedByMe: false, publicPlots: [] }
        : plotResponse,
    ),
  apiSend: () => Promise.resolve(likeState),
}));

const { default: PublicPlotPage } = await import('../src/app/[locale]/(app)/p/[id]/page');

const plotResponse: PublicPlotDetail = {
  public: true,
  creatorFollow: { followerCount: 0, followedByMe: false },
  id: 'sty_1',
  name: '비 오는 밤의 서점',
  coverUrl: null,
  creatorId: 'usr_1',
  creatorName: '록',
  language: 'ko',
  tags: [],
  likeCount: 12,
  chatCount: 3,
  intro: '',
  introPreview: '안녕.',
  publishedAt: null,
  likedByMe: true,
  characters: [],
  intros: ['안녕.'],
  introPreviews: ['안녕.'],
  commentsEnabled: false,
  commentCount: 0,
  style: null,
  profiles: [],
  displayScripts: [],
  defaultVariables: {},
  componentCode: '',
  componentCapabilities: [],
};

/**
 * The name a screen reader would read: `aria-label` when the element has one —
 * the case these tests exist to rule out — and otherwise the text it shows,
 * minus whatever is hidden from the accessibility tree.
 */
function accessibleName(node: HTMLElement): string {
  const label = node.getAttribute('aria-label');
  if (label !== null) return label;
  const clone = node.cloneNode(true) as HTMLElement;
  for (const hidden of clone.querySelectorAll('[aria-hidden]')) hidden.remove();
  return (clone.textContent ?? '').trim();
}

let host: HTMLElement;
let root: Root;

async function render(children: ReactNode): Promise<void> {
  await act(async () => {
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'ko',
        messages,
        children: createElement(Suspense, { fallback: null }, children),
      }),
    );
  });
}

async function click(node: Element): Promise<void> {
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  likeState = { liked: true, likeCount: 13 };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the like button on a plot page', () => {
  const like = (): HTMLElement => host.querySelector<HTMLElement>('[data-testid="like-button"]')!;

  it('reads out the count it shows, and the action beside it', async () => {
    await render(createElement(PublicPlotPage, { params: Promise.resolve({ id: 'sty_1' }) }));

    expect(like().getAttribute('aria-label')).toBeNull();
    expect(like().textContent).toBe('♥12좋아요 취소');
    expect(accessibleName(like())).toBe('12좋아요 취소');
    expect(like().getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps the count in the name after the toggle', async () => {
    likeState = { liked: false, likeCount: 11 };
    await render(createElement(PublicPlotPage, { params: Promise.resolve({ id: 'sty_1' }) }));

    await click(like());
    expect(accessibleName(like())).toBe('11좋아요');
    expect(like().getAttribute('aria-pressed')).toBe('false');
  });
});
