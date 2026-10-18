// @vitest-environment jsdom
/**
 * The AI draft on the creator's shelf: one premise in, a whole first version
 * out. The draft itself is stored nowhere — the server answers with the fields
 * a create takes — so what this checks is the order of the three writes it turns
 * into, and that the creator lands in the editor with them already in the work.
 *
 * `createElement` rather than JSX, matching the other component tests.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/ko.json';
import { ApiError } from '../src/lib/api';
import type { ModelInfo, PlotDraft } from '../src/lib/types';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

/**
 * Node's own experimental `localStorage` shadows the jsdom one and is an empty
 * object without `--localstorage-file`, so the page gets a map of its own.
 */
const store = new Map<string, string>();
const storage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
};
for (const scope of new Set([globalThis, window])) {
  Object.defineProperty(scope, 'localStorage', { configurable: true, value: storage });
}

const push = vi.fn<(href: string) => void>();
/** Every write the page has sent, in order. */
let sent: { path: string; body: unknown }[] = [];
/** What the draft call answers with; a rejection is how a failure is tested. */
let drafted: () => Promise<PlotDraft>;
let created: () => Promise<{ id: string }>;
/** The creator's models; empty unless a test is about picking one. */
let catalog: ModelInfo[] = [];

vi.mock('@/i18n/navigation', async () => {
  const { createElement: h } = await import('react');
  return {
    Link: ({ href, children, ...rest }: { href: string; children?: ReactNode }) =>
      h('a', { ...rest, href }, children),
    usePathname: () => '/plots',
    useRouter: () => ({ push }),
  };
});

vi.mock('@/lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...original,
    apiGet: (path: string) => Promise.resolve(path === '/api/models' ? catalog : []),
    apiSend: (_method: string, path: string, body: unknown) => {
      sent.push({ path, body });
      if (path === '/api/plots/draft') return drafted();
      if (path === '/api/plots') return created();
      return Promise.resolve({ id: 'chr_1' });
    },
  };
});

const { default: PlotsPage } = await import('../src/app/[locale]/(app)/(member)/plots/page');

const draft: PlotDraft = {
  name: '비 오는 밤의 서점',
  intro: '문 닫은 서점에 손님이 온다.',
  description: '작은 도시의 헌책방, 비 오는 밤.',
  characters: [{ name: '세라', description: '야간 점원.', personality: '조용하다.' }],
  intros: ['문이 열린다.'],
  tags: ['미스터리'],
};

let host: HTMLElement;
let root: Root;

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'ko',
        timeZone: 'Asia/Seoul',
        messages,
        children: createElement(PlotsPage) as ReactNode,
      }),
    );
  });
}

const opener = (): HTMLButtonElement => host.querySelector('[data-testid="plot-draft-open"]')!;
const panel = (): HTMLElement | null => host.querySelector('[data-testid="plot-draft-panel"]');
const premise = (): HTMLTextAreaElement => panel()!.querySelector('textarea')!;
const write = (): HTMLButtonElement =>
  [...panel()!.querySelectorAll('button')].find((node) => node.textContent === '초안 만들기')!;

async function click(node: Element): Promise<void> {
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** Types into a controlled textarea the way React reads it back. */
async function type(node: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  sent = [];
  drafted = () => Promise.resolve(draft);
  created = () => Promise.resolve({ id: 'sty_9' });
  catalog = [];
  store.clear();
  push.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the AI draft', () => {
  it('opens beside 새 플롯, and asks for nothing until there is a premise', async () => {
    await render();
    expect(panel()).toBeNull();

    await click(opener());
    expect(panel()).not.toBeNull();
    expect(write().disabled).toBe(true);
  });

  it('creates the work the draft describes and lands in its editor', async () => {
    await render();
    await click(opener());
    await type(premise(), '비 오는 밤, 문 닫은 서점에 손님이 온다.');
    await click(write());

    expect(sent).toEqual([
      { path: '/api/plots/draft', body: { premise: '비 오는 밤, 문 닫은 서점에 손님이 온다.' } },
      {
        path: '/api/plots',
        body: {
          name: draft.name,
          intro: draft.intro,
          description: draft.description,
          intros: draft.intros,
          tags: draft.tags,
        },
      },
      {
        path: '/api/plots/sty_9/characters',
        body: {
          name: '세라',
          card: { description: '야간 점원.', personality: '조용하다.' },
        },
      },
    ]);
    expect(push).toHaveBeenCalledWith('/plots/sty_9');
  });

  it('says why a refused draft was refused, and stores nothing', async () => {
    await render();
    await click(opener());
    await type(premise(), '한 줄.');
    drafted = () =>
      Promise.reject(new ApiError(503, 'draft_unavailable', 'No model can write a draft'));
    await click(write());

    expect(sent).toHaveLength(1);
    expect(push).not.toHaveBeenCalled();
    expect(host.textContent).toContain(messages.errors.draft_unavailable);
    // Still there, with the premise in it, ready to be tried again.
    expect(premise().value).toBe('한 줄.');
  });

  it('says so when the model could not write one', async () => {
    await render();
    await click(opener());
    await type(premise(), '한 줄.');
    drafted = () =>
      Promise.reject(new ApiError(502, 'draft_failed', 'The model did not return a usable draft'));
    await click(write());

    expect(host.textContent).toContain(messages.errors.draft_failed);
  });
});

describe('the draft’s model', () => {
  const modelSelect = (): HTMLSelectElement | null =>
    panel()!.querySelector('[data-testid="draft-model"]');

  beforeEach(() => {
    catalog = [
      { id: 'm1', label: '모델 하나' },
      { id: 'm2', label: '가벼운 모델' },
    ];
  });

  async function draftWith(): Promise<unknown> {
    await type(premise(), '한 줄.');
    await click(write());
    return sent[0]!.body;
  }

  it('starts on the first model and sends it', async () => {
    await render();
    await click(opener());
    expect([...modelSelect()!.options].map((option) => option.textContent)).toEqual(['모델 하나', '가벼운 모델']);
    expect(modelSelect()!.value).toBe('m1');
    expect(await draftWith()).toEqual({ premise: '한 줄.', model: 'm1' });
  });

  it('remembers the last pick in this browser', async () => {
    await render();
    await click(opener());
    await act(async () => {
      modelSelect()!.value = 'm2';
      modelSelect()!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(store.get('shizue.draftModel')).toBe('m2');

    // A later visit opens on it.
    act(() => root.unmount());
    root = createRoot(host);
    await render();
    await click(opener());
    expect(modelSelect()!.value).toBe('m2');
    expect(await draftWith()).toEqual({ premise: '한 줄.', model: 'm2' });
  });

  it('falls back to the first model when the remembered one is no longer offered', async () => {
    store.set('shizue.draftModel', 'gone/model');
    await render();
    await click(opener());
    expect(modelSelect()!.value).toBe('m1');
    expect(await draftWith()).toEqual({ premise: '한 줄.', model: 'm1' });
  });

  it('leaves the choice to the server while there is no catalog', async () => {
    catalog = [];
    await render();
    await click(opener());
    expect(modelSelect()).toBeNull();
    expect(await draftWith()).toEqual({ premise: '한 줄.' });
  });
});

describe('the draft guide', () => {
  const toggle = (): HTMLButtonElement => panel()!.querySelector('[data-testid="draft-guide-toggle"]')!;
  const guide = (): HTMLElement => panel()!.querySelector('[data-testid="draft-guide"]')!;

  it('is collapsed until asked for, and out of reach while it is', async () => {
    await render();
    await click(opener());
    expect(toggle().textContent).toContain(messages.plots.draftGuide);
    // A native button: Enter and Space work without a handler of its own.
    expect(toggle().tagName).toBe('BUTTON');
    expect(toggle().type).toBe('button');
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(toggle().getAttribute('aria-controls')).toBe(guide().id);
    expect(guide().hasAttribute('inert')).toBe(true);
  });

  it('opens on a press, says so, and is remembered in this browser', async () => {
    await render();
    await click(opener());
    await click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(guide().hasAttribute('inert')).toBe(false);
    for (const key of ['Input', 'Model', 'Result', 'Choice'] as const) {
      expect(guide().textContent).toContain(messages.plots[`draftGuide${key}`]);
    }
    expect(store.get('shizue.draftGuideOpen')).toBe('1');

    // Reopening the panel finds it as it was left.
    await click(opener());
    await click(opener());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');

    await click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(guide().hasAttribute('inert')).toBe(true);
    expect(store.get('shizue.draftGuideOpen')).toBe('0');
  });
});

it('locks the premise and all creation doors through generation and persistence, then recovers on failure', async () => {
  let finishDraft!: (value: PlotDraft) => void;
  let failCreate!: (error: Error) => void;
  drafted = () => new Promise((resolve) => { finishDraft = resolve; });
  created = () => new Promise((_resolve, reject) => { failCreate = reject; });
  await render();
  await click(opener());
  await type(premise(), '아직 저장하지 않은 설정');
  await click(write());
  expect(premise().matches(':disabled')).toBe(true);
  expect(opener().matches(':disabled')).toBe(true);
  expect(host.querySelector('[data-testid="plot-import-input"]')!.matches(':disabled')).toBe(true);
  const otherDoor = [...host.querySelectorAll('button')].find((node) => node.textContent === '새 플롯')!;
  expect(otherDoor.matches(':disabled')).toBe(true);
  await click(write());
  expect(sent).toHaveLength(1);
  await act(async () => finishDraft(draft));
  expect(sent).toHaveLength(2);
  expect(premise().matches(':disabled')).toBe(true);
  await act(async () => failCreate(new Error('write failed')));
  expect(premise().matches(':disabled')).toBe(false);
  expect(premise().value).toBe('아직 저장하지 않은 설정');
  expect(opener().matches(':disabled')).toBe(false);
  expect(push).not.toHaveBeenCalled();
});
