// @vitest-environment jsdom
/**
 * The header: the four clusters, 설정 last — the same for everyone, since there
 * is no sign-in. Which of them is visible at a given width is a media query and
 * so not testable here — what is testable is that the wide-screen bar holds
 * them and the narrow one hands them over.
 *
 * `createElement` rather than JSX, matching bottomSheet.test.ts.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubMatchMedia } from './matchMedia';

let pathname = '/chats';

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

const { Header } = await import('../src/components/Header');

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const MESSAGES = {
  brand: { name: 'shizue' },
  common: { close: '닫기' },
  locales: { ko: '한국어', en: 'English', ja: '日本語' },
  nav: {
    library: '라이브러리',
    chats: '대화',
    create: '만들기',
    language: '언어',
    settings: '설정',
  },
};

const CLUSTERS = ['라이브러리', '대화', '만들기', '설정'];

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
const cluster = (label: string): HTMLAnchorElement =>
  [...barNav().querySelectorAll('a')].find((node) => node.textContent === label)!;

beforeEach(() => {
  pathname = '/chats';
  stubMatchMedia();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('Header', () => {
  it('stands the four clusters in the bar for a wide screen', async () => {
    await render();

    expect(labels(barNav())).toEqual(CLUSTERS);
    // The bar's half of the collapse; the tab bar carries the other one.
    expect(barNav().className).toContain('hidden');
    expect(barNav().className).toContain('lg:flex');
    // The cluster we are standing in says so, not only the page we are on.
    expect(cluster('대화').getAttribute('aria-current')).toBe('page');
  });

  /** 페르소나 and 노트 live behind 만들기, and light it up from there. */
  it('marks 만들기 for the surfaces behind its sub-tabs', async () => {
    pathname = '/notes';
    await render();

    expect(cluster('만들기').getAttribute('aria-current')).toBe('page');
  });

  it('marks 설정 for its sections', async () => {
    pathname = '/settings';
    await render();

    expect(cluster('설정').getAttribute('aria-current')).toBe('page');
    expect(cluster('만들기').getAttribute('aria-current')).toBeNull();
  });

  it('leaves the AI connection and the pickers to 설정, and offers no way in or out', async () => {
    await render();

    expect(linkTo('/settings')?.textContent).toBe('설정');
    expect(bar().querySelector('select')).toBeNull();
    expect(linkTo('/login')).toBeUndefined();
  });
});
