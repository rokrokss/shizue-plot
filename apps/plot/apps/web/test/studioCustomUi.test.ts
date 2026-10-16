// @vitest-environment jsdom
/**
 * The studio's custom UI in a work of several members: each display script says
 * whose messages it is for (적용 대상), a member's stylesheet — a companion's, or
 * one started from nothing — and the work's one background ride the one Save, a
 * member's removal takes what came with it,
 * and a companion's import takes up what its card brought — saying which of its
 * default variables the work already had — once, even when the import is one
 * that ended while the page reloaded.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, Suspense, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/ko.json';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const card = (name: string, extra: Record<string, unknown> = {}) => ({
  spec: 'v3', name, description: '', personality: '', scenario: '', firstMes: '',
  alternateGreetings: [], mesExample: '', systemPrompt: '', postHistoryInstructions: '',
  creatorNotes: '', tags: [], creator: '', characterVersion: '', lorebook: [],
  loreSettings: { scanDepth: 4, recursiveScanning: false }, extensions: {}, raw: null, ...extra,
});
const member = (id: string, name: string) => ({
  id, name, card: card(name), avatarUrl: null, orderIndex: 0, importedFrom: null,
  license: null, loreConstantTokens: 0, talkativeness: 50, createdAt: '', updatedAt: '',
});
const script = (input: string, memberId?: string) => ({ in: input, out: '<b>$&</b>', order: 0, enabled: true, ...(memberId ? { memberId } : {}) });
let plot: Record<string, unknown>;

const send = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const upload = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('../src/lib/api')>()),
  apiGet: (path: string) => Promise.resolve(path === '/api/plots/plot-1' ? plot : []),
  apiSend: (...args: unknown[]) => send(...args),
  apiDelete: (path: string) => send('DELETE', path),
  apiUpload: (...args: unknown[]) => upload(...args),
}));
vi.mock('@/lib/fileImport', async (original) => ({
  ...(await original<typeof import('../src/lib/fileImport')>()),
  importFile: (...args: unknown[]) => upload(...args),
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
    commentsEnabled: true, intros: [], narrator: null, style: null, profiles: [], lorebook: [],
    customUi: {
      displayScripts: [script('\\[all\\]'), script('\\[kai\\]', 'm2')],
      memberCss: { m2: '.kai { color: blue; }' },
      defaultVariables: { hp: '100' },
    },
    // What the chat draws now: a plot from before the work's own background.
    backgroundHtml: '<div class="sky">밤</div>',
    coverUrl: null, visibility: 'private', safetyLevel: 'all',
    plotLoreConstantTokens: 0, groupSettings: { order: 'natural', maxSpeakers: 3 },
    characters: [member('m1', '세이야'), member('m2', '카이')],
  };
  send.mockReset();
  send.mockImplementation((_method, path) => Promise.resolve(path === '/api/plots/plot-1' ? plot : {}));
  upload.mockReset();
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
/** The custom UI the last plot save carried. */
const savedUi = () =>
  (send.mock.calls.filter(([method, at]) => method === 'PATCH' && at === '/api/plots/plot-1').at(-1)?.[2] as { customUi: Record<string, unknown> })
    .customUi;
const targets = () => [...host.querySelectorAll<HTMLSelectElement>('[data-testid="display-script-member"]')];
async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function type(field: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('적용 대상', () => {
  it('says whose messages each script is for, and saves a change with the tags, the stylesheets and an untouched background left as they were', async () => {
    await render();
    expect(targets().map((select) => select.value)).toEqual(['', 'm2']);
    expect([...targets()[0]!.options].map((option) => option.textContent)).toEqual([messages.plot.displayScriptMemberAll, '세이야', '카이']);
    await choose(targets()[0]!, 'm1');
    await choose(targets()[1]!, '');
    await click(button(host, messages.common.save));
    expect(savedUi()).toMatchObject({
      displayScripts: [script('\\[all\\]', 'm1'), script('\\[kai\\]')],
      memberCss: { m2: '.kai { color: blue; }' },
    });
    // A plot from before the work's own background keeps drawing its card's until it is edited.
    expect(savedUi()).not.toHaveProperty('backgroundHtml');
  });

  it('is not offered in a work of one', async () => {
    plot = { ...plot, characters: [member('m1', '세이야')] };
    await render();
    expect(targets()).toHaveLength(0);
  });
});

describe('적용 범위', () => {
  const bounds = (testId: string) => [...host.querySelectorAll<HTMLInputElement>(`[data-testid="${testId}"]`)];
  async function enter(field: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('shows each script’s range, blank for no limit, and saves what is typed as the API reads it', async () => {
    plot = {
      ...plot,
      customUi: { displayScripts: [script('\\[all\\]'), { ...script('\\[kai\\]', 'm2'), minDepth: 1, maxDepth: 3 }] },
    };
    await render();
    const group = host.querySelector(`[role="group"][aria-label="${messages.plot.displayScriptRange}"]`)!;
    expect(group.textContent).toContain(messages.plot.displayScriptRangeHint);
    expect(bounds('display-script-min-depth').map((field) => field.value)).toEqual(['', '1']);
    expect(bounds('display-script-max-depth').map((field) => field.value)).toEqual(['', '3']);
    expect(bounds('display-script-min-depth')[0]!.getAttribute('aria-label')).toBe(messages.plot.displayScriptRangeFrom);

    await enter(bounds('display-script-max-depth')[0]!, '0');
    await enter(bounds('display-script-min-depth')[1]!, '');
    await enter(bounds('display-script-max-depth')[1]!, '-2');
    await click(button(host, messages.common.save));
    expect(savedUi()['displayScripts']).toEqual([
      { ...script('\\[all\\]'), maxDepth: 0 },
      script('\\[kai\\]', 'm2'),
    ]);
  });
});

describe('a member’s stylesheet', () => {
  const adds = () => [...host.querySelectorAll<HTMLButtonElement>('[data-testid="member-css-add"]')];
  const sheets = () => [...host.querySelectorAll<HTMLTextAreaElement>('[data-testid="member-css"]')];

  it('starts from nothing for a member without one, and rides the save', async () => {
    await render();
    // 카이's came with its card; 세이야 has none, and is offered one.
    expect(adds().map((node) => node.textContent)).toEqual([messages.plot.memberCssAdd.replace('{name}', '세이야')]);
    await click(adds()[0]!);
    expect(adds()).toHaveLength(0);
    expect(sheets().map((field) => field.value)).toEqual(['', '.kai { color: blue; }']);
    await type(sheets()[0]!, '.seiya { color: red; }');
    await click(button(host, messages.common.save));
    expect(savedUi()['memberCss']).toEqual({ m1: '.seiya { color: red; }', m2: '.kai { color: blue; }' });
  });

  it('is dropped when saved empty', async () => {
    await render();
    await click(adds()[0]!);
    await type(sheets()[1]!, '  ');
    await click(button(host, messages.common.save));
    expect(savedUi()['memberCss']).toEqual({});
  });

  it('is not offered in a work of one', async () => {
    plot = { ...plot, characters: [member('m1', '세이야')], customUi: { displayScripts: [], defaultVariables: {} } };
    await render();
    expect(adds()).toHaveLength(0);
    expect(sheets()).toHaveLength(0);
  });
});

describe('the work’s background', () => {
  it('starts from what the chat draws now, and becomes the work’s own once edited', async () => {
    await render();
    const field = host.querySelector<HTMLTextAreaElement>('[data-testid="work-background"]')!;
    expect(field.value).toBe('<div class="sky">밤</div>');
    await type(field, '');
    await click(button(host, messages.common.save));
    expect(savedUi()).toMatchObject({ backgroundHtml: '' });
  });
});

describe('the roster’s custom UI', () => {
  it('drops a removed member’s scripts and stylesheet from what the next save carries', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await render();
    expect(host.querySelector<HTMLTextAreaElement>('[data-testid="member-css"]')?.value).toBe('.kai { color: blue; }');
    const label = messages.common.removeItem.replace('{item}', '카이');
    await click(host.querySelector<HTMLElement>(`button[aria-label="${label}"]`)!);
    expect(send.mock.calls.some(([method, at]) => method === 'DELETE' && at === '/api/plots/plot-1/characters/m2')).toBe(true);
    await click(button(host, messages.common.save));
    expect(savedUi()['displayScripts']).toEqual([script('\\[all\\]')]);
    expect(savedUi()['memberCss']).toEqual({});
    confirm.mockRestore();
  });

  it('takes up what an imported companion brought, and says which of its variables the work kept', async () => {
    plot = { ...plot, characters: [member('m1', '세이야')], customUi: { displayScripts: [script('\\[all\\]')], defaultVariables: { hp: '100' } } };
    await render();
    upload.mockImplementation(async () => {
      // What the server lifted off the card, as the plot read after the import has it.
      plot = {
        ...plot,
        characters: [member('m1', '세이야'), member('m3', '미오')],
        customUi: {
          displayScripts: [script('\\[all\\]'), script('\\[mio\\]', 'm3')],
          memberCss: { m3: '.mio { color: pink; }' },
          defaultVariables: { hp: '100', gold: '3' },
          backgroundHtml: '<div class="sky">밤</div>',
        },
      };
      return { ...member('m3', '미오'), variableConflicts: ['hp'] };
    });
    const input = host.querySelector<HTMLInputElement>('[data-testid="member-import-input"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['{}'], 'mio.json')] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    await act(async () => undefined);
    expect(host.querySelector('[data-testid="variable-conflicts"]')?.textContent).toContain('hp');
    await click(button(host, messages.common.save));
    expect(savedUi()).toMatchObject({
      displayScripts: [script('\\[all\\]'), script('\\[mio\\]', 'm3')],
      memberCss: { m3: '.mio { color: pink; }' },
      defaultVariables: { hp: '100', gold: '3' },
      backgroundHtml: '<div class="sky">밤</div>',
    });
  });

  it('takes nothing up twice from an import that ended while the page reloaded and is shown again', async () => {
    // The work as the reloaded page read it: the companion and its script are in already.
    plot = {
      ...plot,
      characters: [member('m1', '세이야'), member('m3', '미오')],
      customUi: { displayScripts: [script('\\[all\\]'), script('\\[mio\\]', 'm3')], defaultVariables: { hp: '100' } },
    };
    await render();
    upload.mockResolvedValue({ ...member('m3', '미오'), variableConflicts: [] });
    const input = host.querySelector<HTMLInputElement>('[data-testid="member-import-input"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['{}'], 'mio.json')] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    await act(async () => undefined);
    expect(host.querySelectorAll('[data-testid="plot-member"]')).toHaveLength(2);
    await click(button(host, messages.common.save));
    expect(savedUi()['displayScripts']).toEqual([script('\\[all\\]'), script('\\[mio\\]', 'm3')]);
  });
});
