// @vitest-environment jsdom
/**
 * The studio's "장면 제목" action: a `# ` line at the caret's line of an opening,
 * the caret left where the title goes, saved with the opening as its own text —
 * the chat draws it as a Zeta scene heading and the model reads it as written.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, Suspense, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/ko.json';
import { insertSceneHeading } from '../src/lib/sceneHeading';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

describe('a scene heading written at the caret', () => {
  it('makes a blank line the heading, and the caret waits after its mark', () => {
    expect(insertSceneHeading('', 0)).toEqual({ text: '# ', caret: 2 });
    expect(insertSceneHeading('비가 왔다.\n\n세라: 늦었네.', 7)).toEqual({ text: '비가 왔다.\n# \n세라: 늦었네.', caret: 9 });
  });

  it('puts a line with words in it under a new heading', () => {
    // The caret anywhere in the line: the heading goes above all of it.
    expect(insertSceneHeading('입학식 날이었다.\n세라: 늦었네.', 3)).toEqual({ text: '# \n입학식 날이었다.\n세라: 늦었네.', caret: 2 });
    expect(insertSceneHeading('입학식 날이었다.\n세라: 늦었네.', 14)).toEqual({ text: '입학식 날이었다.\n# \n세라: 늦었네.', caret: 12 });
  });

  it('leaves a heading as it is, the caret at its end', () => {
    expect(insertSceneHeading('## 사역마와의 계약\n본문', 1)).toEqual({ text: '## 사역마와의 계약\n본문', caret: 11 });
  });
});

const send = vi.fn<(...args: unknown[]) => Promise<unknown>>();
let plot: Record<string, unknown>;
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('../src/lib/api')>()),
  apiGet: (path: string) => Promise.resolve(path === '/api/plots/plot-1' ? plot : []),
  apiSend: (...args: unknown[]) => send(...args),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => createElement('a', { href }, children),
  useRouter: () => ({ push: vi.fn() }),
}));

const { default: Studio } = await import('../src/app/[locale]/(app)/(member)/plots/[id]/page');

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  plot = {
    id: 'plot-1', name: '아카데미', intro: '', description: '', language: 'ko', tags: [],
    commentsEnabled: true, intros: ['입학식 날 아침이었다.\n세라: 늦었네.'], narrator: null, style: null, profiles: [],
    lorebook: [], customUi: null, coverUrl: null, visibility: 'private', safetyLevel: 'all',
    plotLoreConstantTokens: 0, groupSettings: null, characters: [],
  };
  send.mockReset();
  send.mockImplementation((_method, path) => Promise.resolve(path === '/api/plots/plot-1' ? plot : {}));
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const button = (label: string) => [...host.querySelectorAll('button')].find((node) => node.textContent === label)!;

describe('the studio’s 장면 제목', () => {
  it('writes the heading at the caret’s line of its own opening, and saves it with the opening', async () => {
    await act(async () => root.render(createElement(NextIntlClientProvider, {
      locale: 'ko', timeZone: 'Asia/Seoul', messages,
      children: createElement(Suspense, { fallback: null }, createElement(Studio, { params: Promise.resolve({ id: 'plot-1' }) })),
    })));
    expect(host.textContent).toContain(messages.plot.sceneTitleHint);
    const field = host.querySelector<HTMLTextAreaElement>('[data-testid="plot-intro"]')!;
    // The caret in the line that opens the scene.
    field.setSelectionRange(4, 4);
    await act(async () => button(messages.plot.sceneTitle).click());

    expect(field.value).toBe('# \n입학식 날 아침이었다.\n세라: 늦었네.');
    // Back in the field, where the title is typed.
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(2);

    await act(async () => button(messages.common.save).click());
    const saved = send.mock.calls.find(([, at]) => at === '/api/plots/plot-1')?.[2] as { intros: string[] };
    expect(saved.intros).toEqual(['# \n입학식 날 아침이었다.\n세라: 늦었네.']);
  });
});
