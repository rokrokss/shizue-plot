// @vitest-environment jsdom
/**
 * The studio's Save sends a member's card only when a field it tracks has
 * changed, so a field the editor shows but the tracker misses looks editable and
 * is never written. The prompt overrides and the card lorebook are such fields.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, Suspense, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../messages/ko.json';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const card = {
  spec: 'v3', name: '하루', description: '', personality: '', scenario: '', firstMes: '',
  alternateGreetings: [], mesExample: '', systemPrompt: '', postHistoryInstructions: '',
  creatorNotes: '', tags: [], creator: '', characterVersion: '', lorebook: [],
  loreSettings: { scanDepth: 4, recursiveScanning: false } as { scanDepth: number; recursiveScanning: boolean; tokenBudget?: number },
  extensions: {} as Record<string, unknown>, raw: null as unknown,
};
const plot = {
  id: 'plot-1', name: '제목', intro: '', description: '', language: 'ko', tags: [],
  commentsEnabled: true, intros: [], narrator: null, style: null, profiles: [], lorebook: [],
  customUi: null, coverUrl: null, visibility: 'private', safetyLevel: 'all',
  plotLoreConstantTokens: 0,
  characters: [{
    id: 'member-1', name: '하루', card, avatarUrl: null, orderIndex: 0, importedFrom: null,
    license: null, loreConstantTokens: 0, createdAt: '', updatedAt: '',
  }],
};
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
  send.mockReset();
  card.loreSettings = { scanDepth: 4, recursiveScanning: false };
  card.extensions = {};
  card.raw = null;
  send.mockImplementation((_method, path) => Promise.resolve(path === '/api/plots/plot-1' ? plot : {}));
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function type(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const button = (scope: ParentNode, label: string) => [...scope.querySelectorAll('button')].find((node) => node.textContent === label)!;
/** A Field's textarea, found by the label text it is wrapped in. */
const field = (scope: ParentNode, label: string) =>
  [...scope.querySelectorAll('label')].find((node) => node.firstElementChild?.textContent?.startsWith(label))!
    .querySelector('textarea')!;

async function render() {
  await act(async () => root.render(createElement(NextIntlClientProvider, {
    locale: 'ko', timeZone: 'Asia/Seoul', messages,
    children: createElement(Suspense, { fallback: null }, createElement(Studio, { params: Promise.resolve({ id: 'plot-1' }) })),
  })));
}
const memberPatch = () => send.mock.calls.find(([, path]) => path === '/api/plots/plot-1/characters/member-1');

it('sends the prompt overrides and the card lorebook with the member on Save', async () => {
  await render();
  const row = host.querySelector('[data-testid="plot-member"]')!;
  await type(field(row, messages.plot.memberSystemPrompt), '{{original}} 존댓말만 쓴다.');
  await type(field(row, messages.plot.memberPostHistory), '하루의 시점을 지킨다.');
  await act(async () => button(row, messages.plot.addLore).click());
  await act(async () => button(host, messages.common.save).click());

  expect(memberPatch()?.[2]).toMatchObject({
    card: {
      systemPrompt: '{{original}} 존댓말만 쓴다.',
      postHistoryInstructions: '하루의 시점을 지킨다.',
      lorebook: [{ content: '', enabled: true }],
    },
  });
});

/** An emptied number input parses to 0, and a 0 budget is a book that never says anything. */
it('clears the book budget on the first card back to automatic', async () => {
  card.loreSettings = { scanDepth: 4, recursiveScanning: false, tokenBudget: 2048 };
  await render();
  const budget = host.querySelector<HTMLInputElement>(`input[placeholder="${messages.plot.loreBudgetAuto}"]`)!;
  expect(budget.value).toBe('2048');
  await type(budget, '');
  await act(async () => button(host, messages.common.save).click());

  expect((memberPatch()?.[2] as { card: typeof card }).card.loreSettings).toEqual({
    scanDepth: 4,
    recursiveScanning: false,
  });
});

/**
 * A RisuAI card from the Realm carries megabytes the studio never edits — its
 * original JSON, and its extension with the scripts and triggers — which once
 * put the save past the API's 5MB body. Save sends what the editor writes, and
 * the card's two RisuAI settings as values, so the body stays small.
 */
it('saves a big card’s member without its original card or extensions', async () => {
  const blob = 'x'.repeat(3 * 1024 * 1024);
  card.raw = { data: { description: blob } };
  card.extensions = { risuai: { customScripts: [{ in: blob, out: '' }], viewScreen: 'emotion', utilityBot: true } };
  await render();
  const row = host.querySelector('[data-testid="plot-member"]')!;
  await type(field(row, messages.plot.memberDescription), '고친 설정');
  await act(async () => button(host, messages.common.save).click());

  const body = memberPatch()?.[2] as Record<string, unknown>;
  expect(JSON.stringify(body).length).toBeLessThan(1000);
  expect(body).toMatchObject({ card: { description: '고친 설정' }, emotionMode: 'panel', utilityBot: true });
});
