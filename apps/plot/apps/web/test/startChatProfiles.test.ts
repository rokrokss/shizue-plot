// @vitest-environment jsdom
/**
 * The start panel's two ways of saying who the reader is: the profiles the work
 * recommends, and the personas the reader keeps. The chat carries one of them,
 * and the API refuses a request that names both — so the panel is where that
 * exclusivity is made visible, rather than a 400 the reader has to read.
 *
 * `createElement` rather than JSX, matching the other component tests.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/ko.json';
import type { Persona, PlotProfile } from '../src/lib/types';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

/** The body of every chat start the panel has sent. */
let started: Record<string, unknown>[] = [];

vi.mock('@/i18n/navigation', async () => {
  const { createElement: h } = await import('react');
  return {
    Link: ({ href, children }: { href: string; children?: ReactNode }) => h('a', { href }, children),
    useRouter: () => ({ push: vi.fn() }),
  };
});

vi.mock('@/lib/authClient', () => ({
  useSession: () => ({ data: { user: { id: 'usr_2', name: '독자' } }, isPending: false }),
}));

const personas: Persona[] = [
  { id: 'per_1', name: '내 페르소나', description: '', createdAt: '2026-08-16T00:00:00.000Z' },
];

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/api')>()),
  apiGet: (url: string) =>
    Promise.resolve(url === '/api/personas' ? personas : [{ id: 'm1', label: '모델 하나' }]),
  apiSend: (_method: string, _path: string, body: Record<string, unknown>) => {
    started.push(body);
    return Promise.resolve({ chat: { id: 'cht_1' } });
  },
}));

const { StartChatPanel } = await import('../src/components/StartChatPanel');

const profiles: PlotProfile[] = [
  { id: 'prf_1', name: '신입 기자', description: '무엇이든 묻는다.' },
  { id: 'prf_2', name: '오랜 단골', description: '' },
];

let host: HTMLElement;
let root: Root;

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'ko',
        messages,
        children: createElement(StartChatPanel, { plotId: 'sty_1', profiles }) as ReactNode,
      }),
    );
  });
}

const chips = (): HTMLButtonElement[] => [
  ...host.querySelectorAll<HTMLButtonElement>('[data-testid="profile-pick"]'),
];
/** The model select, then the persona one — the panel's two, in its own order. */
const selects = (): HTMLSelectElement[] => [...host.querySelectorAll('select')];
const start = (): HTMLButtonElement =>
  [...host.querySelectorAll('button')].find((node) => node.textContent === '대화 시작')!;

async function click(node: Element): Promise<void> {
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  started = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the start panel’s profile picker', () => {
  it('offers every profile the work recommends', async () => {
    await render();
    expect(chips().map((chip) => chip.textContent)).toEqual([
      '신입 기자무엇이든 묻는다.',
      '오랜 단골',
    ]);
    expect(chips().every((chip) => chip.getAttribute('aria-pressed') === 'false')).toBe(true);
  });

  it('sends the picked profile, and gives up the persona select while it stands', async () => {
    await render();
    // The second select is the persona; the first is the model.
    const persona = selects()[1]!;
    expect(persona.disabled).toBe(false);

    await click(chips()[0]!);
    expect(chips()[0]!.getAttribute('aria-pressed')).toBe('true');
    expect(selects()[1]!.disabled).toBe(true);

    await click(start());
    expect(started).toEqual([{ plotId: 'sty_1', model: 'm1', profileId: 'prf_1' }]);
  });

  it('gives up the profile the moment a persona is chosen', async () => {
    await render();
    await click(chips()[1]!);
    expect(chips()[1]!.getAttribute('aria-pressed')).toBe('true');

    const persona = selects()[1]!;
    await act(async () => {
      persona.value = 'per_1';
      persona.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(chips()[1]!.getAttribute('aria-pressed')).toBe('false');

    await click(start());
    expect(started).toEqual([{ plotId: 'sty_1', model: 'm1', personaId: 'per_1' }]);
  });

  it('picks nothing again when the same profile is pressed twice', async () => {
    await render();
    await click(chips()[0]!);
    await click(chips()[0]!);
    expect(chips()[0]!.getAttribute('aria-pressed')).toBe('false');

    await click(start());
    expect(started).toEqual([{ plotId: 'sty_1', model: 'm1' }]);
  });
});
