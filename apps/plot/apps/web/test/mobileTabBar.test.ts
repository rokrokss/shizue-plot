// @vitest-environment jsdom
/**
 * The phone's tab bar. The width it appears at is a media query and so not
 * testable here; what is testable is what it carries — three clusters and a
 * menu, the rest of the shell inside the sheet that menu opens, and, for a
 * reader who is not signed in, tabs that lead to the way in with where they
 * were headed in hand.
 *
 * `createElement` rather than JSX, matching header.test.ts.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let pathname = '/';
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

const { MobileTabBar } = await import('../src/components/MobileTabBar');

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const MESSAGES = {
  chatgpt: { signIn: 'ChatGPT로 로그인' },
  auth: { signIn: '입장하기', signUp: '계정 만들기' },
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

let host: HTMLElement;
let root: Root;

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'ko',
        messages: MESSAGES,
        children: createElement(MobileTabBar) as ReactElement,
      }),
    );
  });
}

const bar = (): HTMLElement => host.querySelector('[data-testid="tab-bar"]')!;
const sheet = (): HTMLElement | null => document.body.querySelector('[data-testid="bottom-sheet"]');
const menuButton = (): HTMLElement => bar().querySelector('button')!;
const tabs = (): HTMLAnchorElement[] => [...bar().querySelectorAll('a')];
const named = (scope: HTMLElement, label: string): HTMLAnchorElement =>
  [...scope.querySelectorAll('a')].find((node) => node.textContent === label)!;

function click(node: Element): void {
  act(() => {
    // Cancelable, or the link mock's `preventDefault` is a no-op and jsdom goes
    // looking for a document to navigate to.
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  pathname = '/';
  session = { data: { user: {} }, isPending: false };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('MobileTabBar', () => {
  it('carries the three clusters and a menu, and says which one we are in', async () => {
    pathname = '/p/abc';
    await render();

    expect(tabs().map((node) => node.textContent)).toEqual(['탐색', '대화', '만들기']);
    expect(tabs().map((node) => node.getAttribute('href'))).toEqual([
      '/',
      '/chats',
      '/plots',
    ]);
    // A plot page is somewhere inside 탐색, and the tab says so.
    expect(named(bar(), '탐색').getAttribute('aria-current')).toBe('page');
    expect(menuButton().textContent).toBe('메뉴');
    expect(menuButton().getAttribute('aria-expanded')).toBe('false');
    expect(sheet()).toBeNull();
  });

  it('opens the rest of the shell in a sheet, with the locale and the way out', async () => {
    await render();
    click(menuButton());

    expect(menuButton().getAttribute('aria-expanded')).toBe('true');
    expect(sheet()!.getAttribute('aria-label')).toBe('메뉴');
    expect(sheet()!.querySelector('select[aria-label="언어"]')).not.toBeNull();
    expect(
      [...sheet()!.querySelectorAll('button')].some((node) => node.textContent === '로그아웃'),
    ).toBe(true);
  });

  it('closes on Escape and on choosing something', async () => {
    await render();

    click(menuButton());
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(sheet()).toBeNull();
    expect(menuButton().getAttribute('aria-expanded')).toBe('false');

    click(menuButton());
    click(sheet()!.querySelector('button[aria-label="닫기"]')!);
    expect(sheet()).toBeNull();
  });

  describe('signed out', () => {
    beforeEach(() => {
      session = { data: null, isPending: false };
    });

    /** The attempt is the invitation: the tab still goes, by way of the door. */
    it('sends the tabs that need an account to the way in, holding the destination', async () => {
      await render();

      expect(tabs().map((node) => node.getAttribute('href'))).toEqual([
        '/',
        '/login?next=%2Fchats',
        '/login?next=%2Fplots',
      ]);
    });

    it('offers only ChatGPT sign-in in the sheet', async () => {
      await render();
      click(menuButton());

      expect(named(sheet()!, 'ChatGPT로 로그인').getAttribute('href')).toBe('/login');
      expect(sheet()!.querySelector('a[href="/signup"]')).toBeNull();
      expect(
        [...sheet()!.querySelectorAll('button')].some((node) => node.textContent === '로그아웃'),
      ).toBe(false);
    });
  });
});
