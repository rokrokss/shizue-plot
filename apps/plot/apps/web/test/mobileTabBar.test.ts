// @vitest-environment jsdom
/**
 * The phone's tab bar. The width it appears at is a media query and so not
 * testable here; what is testable is what it carries — the four clusters, 설정
 * last, where everything the header's bar once held on a wide screen is now.
 *
 * `createElement` rather than JSX, matching header.test.ts.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubMatchMedia } from './matchMedia';

let pathname = '/';

vi.mock('@/i18n/navigation', async () => {
  const { createElement: h } = await import('react');
  return {
    Link: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => h('a', { ...rest, href }, children),
    usePathname: () => pathname,
    useRouter: () => ({ replace: vi.fn() }),
  };
});

const { MobileTabBar } = await import('../src/components/MobileTabBar');

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const MESSAGES = {
  nav: {
    library: '라이브러리',
    chats: '대화',
    create: '만들기',
    settings: '설정',
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
const tabs = (): HTMLAnchorElement[] => [...bar().querySelectorAll('a')];
const named = (label: string): HTMLAnchorElement => tabs().find((node) => node.textContent === label)!;

beforeEach(() => {
  pathname = '/';
  stubMatchMedia();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('MobileTabBar', () => {
  it('carries the four clusters, 설정 last, and says which one we are in', async () => {
    pathname = '/p/abc';
    await render();

    expect(tabs().map((node) => node.textContent)).toEqual(['라이브러리', '대화', '만들기', '설정']);
    expect(tabs().map((node) => node.getAttribute('href'))).toEqual(['/', '/chats', '/plots', '/settings']);
    // A work's page is somewhere inside the library, and the tab says so.
    expect(named('라이브러리').getAttribute('aria-current')).toBe('page');
    // No sheet, and no way in or out.
    expect(bar().querySelector('button')).toBeNull();
    expect(bar().querySelector('a[href="/login"]')).toBeNull();
  });

  it('lights 설정 up on any of its sections', async () => {
    pathname = '/settings';
    await render();

    expect(named('설정').getAttribute('aria-current')).toBe('page');
    expect(named('만들기').getAttribute('aria-current')).toBeNull();
  });
});
