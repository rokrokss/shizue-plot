// @vitest-environment jsdom
/**
 * 설정's sections: the sidebar a wide screen keeps beside the open one, and the
 * list a narrow screen opens `/settings` on. Which of the two shows at a width
 * is a media query; what is testable is where each leads and what it marks.
 *
 * `createElement` rather than JSX, matching header.test.ts.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let pathname = '/settings';

vi.mock('@/i18n/navigation', async () => {
  const { createElement: h } = await import('react');
  return {
    Link: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => h('a', { ...rest, href }, children),
    usePathname: () => pathname,
  };
});

const { SettingsNav } = await import('../src/components/SettingsNav');

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const MESSAGES = {
  settings: {
    title: '설정',
    groups: { ai: 'AI', app: '앱' },
    items: { models: '모델과 연결', display: '화면', backup: '백업과 복원', phoneAndBackup: '휴대폰 연결과 백업' },
    hints: { models: 'm', display: 'd', backup: 'b', phoneAndBackup: 'p' },
  },
};

let host: HTMLElement;
let root: Root;

async function render(variant: 'sidebar' | 'hub'): Promise<void> {
  await act(async () => {
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'ko',
        messages: MESSAGES,
        children: createElement(SettingsNav, { variant }) as ReactElement,
      }),
    );
  });
}

const links = (): HTMLAnchorElement[] => [...host.querySelectorAll('a')];
const open = (): string[] => links().filter((link) => link.getAttribute('aria-current') === 'page').map((link) => link.getAttribute('href')!);

beforeEach(() => {
  pathname = '/settings';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('SettingsNav', () => {
  it('leads to every section, in its groups', async () => {
    await render('sidebar');

    expect([...host.querySelectorAll('h2')].map((heading) => heading.textContent)).toEqual(['AI', '앱']);
    expect(links().map((link) => link.getAttribute('href'))).toEqual([
      '/settings/models',
      '/settings/display',
      '/settings/backup',
    ]);
  });

  it('marks the open section in the sidebar, the first one at /settings', async () => {
    await render('sidebar');
    expect(open()).toEqual(['/settings/models']);

    pathname = '/settings/display';
    await render('sidebar');
    expect(open()).toEqual(['/settings/display']);
  });

  it('marks nothing in the list a narrow screen opens on, and says what each holds', async () => {
    await render('hub');

    expect(open()).toEqual([]);
    expect(links()[0]!.textContent).toBe('모델과 연결m');
  });
});
