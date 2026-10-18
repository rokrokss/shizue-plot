// @vitest-environment jsdom
/**
 * The studio's controls for a conversation of several members: offered only
 * once the roster has two, they set the round's order and cap on the plot and
 * each member's 대화량, all carried by the one Save — the settings on the plot's
 * PATCH, the 대화량 on its member's.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, Suspense, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/ko.json';
import { talkativenessStop } from '../src/components/GroupTurnsEditor';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const card = (name: string) => ({
  spec: 'v3', name, description: '', personality: '', scenario: '', firstMes: '',
  alternateGreetings: [], mesExample: '', systemPrompt: '', postHistoryInstructions: '',
  creatorNotes: '', tags: [], creator: '', characterVersion: '', lorebook: [],
  loreSettings: { scanDepth: 4, recursiveScanning: false }, extensions: {}, raw: null,
});
const member = (id: string, name: string, talkativeness: number) => ({
  id, name, card: card(name), avatarUrl: null, orderIndex: 0, importedFrom: null,
  license: null, loreConstantTokens: 0, talkativeness, createdAt: '', updatedAt: '',
});
let plot: Record<string, unknown>;

const send = vi.fn<(...args: unknown[]) => Promise<unknown>>();
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
    id: 'plot-1', name: '여관', intro: '', description: '', language: 'ko', tags: [],
    intros: [], narrator: null, style: null, profiles: [], lorebook: [],
    customUi: null, coverUrl: null,
    plotLoreConstantTokens: 0, groupSettings: { order: 'natural', maxSpeakers: 3 },
    characters: [member('m1', '세이야', 50), member('m2', '카이', 83)],
  };
  send.mockReset();
  send.mockImplementation((_method, path) => Promise.resolve(path === '/api/plots/plot-1' ? plot : {}));
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function render() {
  await act(async () => root.render(createElement(NextIntlClientProvider, {
    locale: 'ko', timeZone: 'Asia/Seoul', messages,
    children: createElement(Suspense, { fallback: null }, createElement(Studio, { params: Promise.resolve({ id: 'plot-1' }) })),
  })));
}
const button = (scope: ParentNode, label: string) => [...scope.querySelectorAll('button')].find((node) => node.textContent === label)!;
const click = (node: HTMLElement) => act(async () => node.click());
const call = (path: string) => send.mock.calls.find(([, at]) => at === path)?.[2] as Record<string, unknown> | undefined;

describe('the studio’s round controls', () => {
  it('are offered only with two members or more', async () => {
    plot = { ...plot, characters: [member('m1', '세이야', 50)] };
    await render();
    expect(host.textContent).not.toContain(messages.plot.groupFlow);
    expect(host.querySelector('[data-testid="group-order-natural"]')).toBeNull();
  });

  it('read the plot’s order, cap and each member’s 대화량, and save them with the one Save', async () => {
    await render();
    expect(host.textContent).toContain(messages.plot.groupFlow);
    expect(host.textContent).toContain(messages.plot.groupCost);
    expect(host.querySelector('[data-testid="group-order-natural"]')?.getAttribute('aria-pressed')).toBe('true');
    const rows = [...host.querySelectorAll<HTMLElement>('[data-testid="member-talkativeness"]')];
    /** A row's name and the readout at its end, past the face's initial. */
    const reading = (row: HTMLElement) => `${row.querySelector('.truncate')?.textContent} ${row.lastElementChild?.textContent}`;
    expect(rows.map(reading)).toEqual(['세이야 50%', '카이 83%']);

    await click(host.querySelector<HTMLElement>('[data-testid="group-order-list"]')!);
    expect(host.textContent).toContain(messages.plot.groupOrderHints.list);
    const cap = host.querySelector<HTMLSelectElement>('[data-testid="group-max-speakers"]')!;
    expect([...cap.options].map((option) => option.value)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    await act(async () => {
      cap.value = '2';
      cap.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // 세이야 speaks only when the reader picks them.
    await click(rows[0]!.querySelector<HTMLElement>('button[aria-label="세이야의 대화량 0"]')!);
    expect(reading(rows[0]!)).toBe(`세이야 ${messages.plot.talkativenessZero}`);
    await click(button(host, messages.common.save));

    expect(call('/api/plots/plot-1')).toMatchObject({ groupSettings: { order: 'list', maxSpeakers: 2 } });
    expect(call('/api/plots/plot-1/characters/m1')).toMatchObject({ talkativeness: 0 });
    // A member nobody touched is not written.
    expect(call('/api/plots/plot-1/characters/m2')).toBeUndefined();
  });
});

describe('a 대화량 drawn on the seven stops', () => {
  it('is the nearest stop, the lower on a tie', () => {
    expect(talkativenessStop(0)).toBe(0);
    expect(talkativenessStop(8)).toBe(0);
    expect(talkativenessStop(9)).toBe(17);
    expect(talkativenessStop(45)).toBe(50);
    expect(talkativenessStop(100)).toBe(100);
  });
});
