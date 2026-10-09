// @vitest-environment jsdom
/**
 * The header, whose shape depends on who is reading. Signed in it carries the
 * three clusters, AI settings and the way out; signed out it carries the one
 * cluster that leads anywhere and the way in. Which of them is visible at a
 * given width is a media query and so not testable here — what is testable is
 * that the wide-screen bar holds them and the narrow one hands them over.
 *
 * `createElement` rather than JSX, matching bottomSheet.test.ts.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiGet = vi.fn<() => Promise<unknown>>();
let pathname = '/chats';
let session: { data: unknown; isPending: boolean } = { data: { user: {} }, isPending: false };

vi.mock('@/i18n/navigation', async () => {
  const { createElement: h } = await import('react');
  return {
    Link: ({
      href,
      children,
      onClick,
      ...rest
    }: {
      href: string;
      children?: ReactNode;
      onClick?: (event: MouseEvent) => void;
    }) =>
      h(
        'a',
        {
          ...rest,
          href,
          // jsdom has no navigation to give us; the click is the whole point.
          onClick: (event: MouseEvent) => {
            event.preventDefault();
            onClick?.(event);
          },
        },
        children,
      ),
    usePathname: () => pathname,
    useRouter: () => ({ replace: vi.fn() }),
  };
});

vi.mock('@/lib/authClient', () => ({
  signOut: vi.fn(async () => undefined),
  useSession: () => session,
}));

vi.mock('@/lib/api', () => ({ apiGet: () => apiGet() }));

const { Header } = await import('../src/components/Header');

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const MESSAGES = {
  chatgpt: { signIn: 'ChatGPT로 로그인' },
  auth: { signIn: '입장하기', signUp: '계정 만들기' },
  brand: { name: 'shizue' },
  common: { close: '닫기' },
  locales: { ko: '한국어', en: 'English', ja: '日本語' },
  nav: { aiSettings: 'AI 연결',
    explore: '탐색',
    chats: '대화',
    create: '만들기',
    signOut: '로그아웃',
    language: '언어',
    menu: '메뉴',
  },
};

const CLUSTERS = ['탐색', '대화', '만들기'];

let host: HTMLElement;
let root: Root;

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'ko',
        messages: MESSAGES,
        children: createElement(Header) as ReactElement,
      }),
    );
  });
}

const bar = (): HTMLElement => host.querySelector('header')!;
const barNav = (): HTMLElement => bar().querySelector('nav')!;
const labels = (scope: HTMLElement): string[] =>
  [...scope.querySelectorAll('a')].map((node) => node.textContent ?? '');
const linkTo = (href: string): HTMLAnchorElement | undefined =>
  [...bar().querySelectorAll('a')].find((node) => node.getAttribute('href') === href);

beforeEach(() => {
  pathname = '/chats';
  session = { data: { user: {} }, isPending: false };
  apiGet.mockReset().mockResolvedValue({ items: [], nextCursor: null });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('Header', () => {
  it('stands the three clusters in the bar for a wide screen', async () => {
    await render();

    expect(labels(barNav())).toEqual(CLUSTERS);
    // The bar's half of the collapse; the tab bar carries the other one.
    expect(barNav().className).toContain('hidden');
    expect(barNav().className).toContain('lg:flex');
    // The cluster we are standing in says so, not only the page we are on.
    const here = [...barNav().querySelectorAll('a')].find((node) => node.textContent === '대화')!;
    expect(here.getAttribute('aria-current')).toBe('page');
  });

  /** 페르소나 and 노트 live behind 만들기 now, and light it up from there. */
  it('marks 만들기 for the surfaces behind its sub-tabs', async () => {
    pathname = '/notes';
    await render();

    const here = [...barNav().querySelectorAll('a')].find((node) => node.textContent === '만들기')!;
    expect(here.getAttribute('aria-current')).toBe('page');
  });

  it('offers AI settings, locale and sign-out', async () => {
    await render();

    expect(linkTo('/settings')?.textContent).toBe('AI');
    expect(bar().querySelector('select[aria-label="언어"]')).not.toBeNull();
    expect([...bar().querySelectorAll('button')].some((node) => node.textContent === '로그아웃')).toBe(
      true,
    );
  });

  describe('signed out', () => {
    beforeEach(() => {
      session = { data: null, isPending: false };
      pathname = '/';
    });

    it('keeps the one cluster that leads anywhere, and offers the way in', async () => {
      await render();

      expect(labels(barNav())).toEqual(['탐색']);
      expect(linkTo('/login')!.textContent).toBe('ChatGPT로 로그인');
      expect(linkTo('/signup')).toBeUndefined();
      // Nothing here belongs to an account that does not exist yet.
      expect([...bar().querySelectorAll('button')].some((node) => node.textContent === '로그아웃')).toBe(
        false,
      );
      // The locale is the one control both readers get.
      expect(bar().querySelector('select[aria-label="언어"]')).not.toBeNull();
    });
  });

  /**
   * Which controls belong on the right is not known until the session read
   * lands, and a guess that changes a moment later moves the bar under the
   * reader's finger. So it stays empty rather than filling with a placeholder.
   */
  it('leaves the auth side empty while the session read is in flight', async () => {
    session = { data: null, isPending: true };
    await render();

    expect(linkTo('/login')).toBeUndefined();
    expect(bar().querySelector('select[aria-label="언어"]')).toBeNull();
  });
});
