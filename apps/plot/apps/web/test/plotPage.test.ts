// @vitest-environment jsdom
/**
 * The work page: the openings whole, the cast, the chat form, and the way into
 * the editor beside the title.
 *
 * `createElement` rather than JSX, matching the other component tests.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, Suspense, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/ko.json';
import type { PublicPlotDetail } from '../src/lib/types';

/** The picker's cut of an opening, as the API makes it. */
const INTRO_PREVIEW_LENGTH = 200;

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

/** Every path the page has asked the API for, and every push the router took. */
let asked: string[] = [];
const push = vi.fn<(href: string) => void>();

vi.mock('@/i18n/navigation', async () => {
  const { createElement: h } = await import('react');
  return {
    Link: ({ href, children, ...rest }: { href: string; children?: ReactNode }) =>
      h('a', { ...rest, href }, children),
    usePathname: () => '/p/sty_1',
    useRouter: () => ({ push }),
  };
});

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/api')>()),
  apiGet: (url: string) => {
    asked.push(url);
    if (url === '/api/plots/sty_1/public') return Promise.resolve(plotResponse);
    if (url === '/api/model-presets') return Promise.resolve([{ id: 'm1', name: '모델 하나' }]);
    if (url === '/api/model-binding') return Promise.resolve({ main: null, sub: null });
    if (url === '/api/personas') return Promise.resolve([]);
    return Promise.reject(new Error(`unexpected read: ${url}`));
  },
  apiSend: () => Promise.reject(new Error('reading the page writes nothing')),
}));

const { default: WorkPage } = await import('../src/app/[locale]/(app)/p/[id]/page');

/** Longer than the listings' cut, so a preview would be visibly short of it. */
const intro = `문을 열자 ${'긴 도입부입니다. '.repeat(30)}끝.`;

const plotResponse: PublicPlotDetail = {
  id: 'sty_1',
  name: '비 오는 밤의 서점',
  coverUrl: null,
  language: 'ko',
  tags: [],
  intro: '',
  characters: [{ id: 'chr_1', name: '세라', avatarUrl: null, intro: '서점의 야간 점원.' }],
  intros: [intro, '두 번째 도입부입니다.'],
  introPreviews: [intro.slice(0, INTRO_PREVIEW_LENGTH), '두 번째 도입부입니다.'],
  style: null,
  profiles: [],
  displayScripts: [],
  css: '',
  defaultVariables: {},
  componentCode: '',
  componentCapabilities: [],
};

let host: HTMLElement;
let root: Root;

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'ko',
        messages,
        children: createElement(
          Suspense,
          { fallback: null },
          createElement(WorkPage, { params: Promise.resolve({ id: 'sty_1' }) }),
        ),
      }),
    );
  });
}

const find = (selector: string): HTMLElement | null => host.querySelector<HTMLElement>(selector);
const all = (selector: string): HTMLElement[] => [...host.querySelectorAll<HTMLElement>(selector)];

async function click(node: Element): Promise<void> {
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  asked = [];
  push.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the plot page', () => {
  it('shows the chosen opening whole, not the picker’s cut', async () => {
    await render();
    expect(find('[data-testid="intro-text"]')?.textContent).toBe(intro);
    expect(intro.length).toBeGreaterThan(INTRO_PREVIEW_LENGTH);
  });

  it('names the cast, each with the line written about them', async () => {
    await render();
    const member = find('[data-testid="plot-member"]');
    expect(member?.textContent).toContain('세라');
    expect(member?.textContent).toContain('서점의 야간 점원.');
  });

  it('switches the opening the picker points at', async () => {
    await render();
    const picks = all('[data-testid="intro-pick"]');
    expect(picks).toHaveLength(2);
    expect(picks[0]!.getAttribute('aria-pressed')).toBe('true');

    await click(picks[1]!);
    expect(find('[data-testid="intro-text"]')?.textContent).toBe('두 번째 도입부입니다.');
    expect(picks[1]!.getAttribute('aria-pressed')).toBe('true');
  });

  it('offers the chat form and the editor', async () => {
    await render();

    expect(find('select')).not.toBeNull();
    expect(asked).toContain('/api/model-presets');
    expect(asked).toContain('/api/personas');
    expect(find('a[href="/plots/sty_1"]')?.textContent).toBe('편집');
  });
});
