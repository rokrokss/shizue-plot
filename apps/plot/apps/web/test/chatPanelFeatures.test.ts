// @vitest-environment jsdom
/**
 * The reader's half of the plot's two style features, in the notes panel.
 *
 * A toggle is only offered where the plot asked for the feature: the columns
 * behind them are true on every chat, so a panel that showed them unconditionally
 * would offer to turn off something that was never going to happen. What is
 * checked here is that rule and the answer each row sends.
 *
 * `createElement` rather than JSX, matching `chatSettings.test.ts`.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/ko.json';
import type { PublicMember } from '../src/lib/types';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: unknown }) =>
    createElement('a', { href }, children as never),
}));

const { ChatPanel } = await import('../src/components/ChatPanel');

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

let host: HTMLElement;
let root: Root;
/** Every toggle the panel has sent, as `feature: answer`. */
let sent: string[];
let saveNote: () => Promise<void> = async () => undefined;
/** Every narrator override the panel has saved. */
let savedNarrators: unknown[];

function render(features: {
  statusWindow: boolean;
  choices: boolean;
  scriptSimilarity?: boolean;
  members?: PublicMember[];
}): void {
  act(() => {
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'ko',
        timeZone: 'Asia/Seoul',
        messages,
        children: createElement(ChatPanel, {
          members: features.members ?? [],
          note: '',
          notes: [],
          noteIds: [],
          chatId: 'chat-1',
          headMessageId: null,
          memoryRevision: 0,
          memorySettings: null,
          narrator: null,
          customUi: true,
          allowComponentTurns: false,
          statusWindow: features.statusWindow,
          statusWindowEnabled: true,
          choices: features.choices,
          choicesEnabled: true,
          disabled: false,
          onSaveNote: () => saveNote(),
          onToggleNote: async () => undefined,
          onSaveMemorySettings: async () => undefined,
          onSaveNarrator: async (narrator: unknown) => void savedNarrators.push(narrator),
          onToggleCustomUi: () => undefined,
          onToggleComponentTurns: async () => undefined,
          onToggleStatusWindow: async (enabled: boolean) => void sent.push(`status:${enabled}`),
          onToggleChoices: async (enabled: boolean) => void sent.push(`choices:${enabled}`),
          scriptSimilarity: features.scriptSimilarity ?? false,
          onSaveEmotionProcessor: async (processor: string) => void sent.push(`emotion:${processor}`),
        }),
      }),
    );
  });
}

const section = (): HTMLElement | null =>
  host.querySelector('[data-testid="chat-plot-features"]');
const box = (label: string): HTMLInputElement =>
  [...(section()?.querySelectorAll('label') ?? [])]
    .find((node) => node.textContent === label)!
    .querySelector('input')!;

beforeEach(() => {
  sent = [];
  savedNarrators = [];
  saveNote = async () => undefined;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the plot features in the notes panel', () => {
  it('says nothing where the plot asked for neither feature', () => {
    render({ statusWindow: false, choices: false });
    expect(section()).toBeNull();
  });

  it('offers only the feature the plot turned on', () => {
    render({ statusWindow: true, choices: false });
    expect(section()).not.toBeNull();
    expect(section()!.textContent).toContain(messages.chat.statusWindowEnabled);
    expect(section()!.textContent).not.toContain(messages.chat.choicesEnabled);
  });

  it('sends each answer as the reader gives it', async () => {
    render({ statusWindow: true, choices: true });

    await act(async () => {
      box(messages.chat.statusWindowEnabled).click();
    });
    await act(async () => {
      box(messages.chat.choicesEnabled).click();
    });
    expect(sent).toEqual(['status:false', 'choices:false']);
  });
});

it('offers RisuAI’s two emotion processors only where a member shows its pictures beside the chat', async () => {
  const member = (mode: 'panel' | 'inlay'): PublicMember => ({
    id: mode,
    name: mode,
    nickname: null,
    avatarUrl: null,
    emotion: { mode, images: [{ name: 'happy', slug: 'happy' }] },
  });
  const choice = (): HTMLSelectElement | null => host.querySelector('[data-testid="chat-emotion"] select');
  render({ statusWindow: false, choices: false, members: [member('inlay')] });
  expect(choice()).toBeNull();
  render({ statusWindow: false, choices: false, members: [member('inlay'), member('panel')] });
  expect([...choice()!.options].map((option) => [option.value, option.textContent])).toEqual([
    ['submodel', messages.chat.emotionProcessorSubmodel],
    ['embedding', messages.chat.emotionProcessorEmbedding],
  ]);
  expect(choice()!.value).toBe('submodel');
  await act(async () => {
    choice()!.value = 'embedding';
    choice()!.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(sent).toEqual(['emotion:embedding']);
});

it('saves the limited third person as this chat’s point of view', async () => {
  render({ statusWindow: false, choices: false });
  const select = host.querySelector<HTMLSelectElement>('[data-testid="chat-narrator"] select')!;
  expect(select.querySelector('option[value="third-limited"]')?.textContent).toBe(
    messages.chat.narratorPovThirdLimited,
  );
  await act(async () => {
    select.value = 'third-limited';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(savedNarrators).toEqual([{ pov: 'third-limited' }]);
});

it('locks note and narrator drafts while its own save is pending', async () => {
  let finish!: () => void;
  saveNote = () => new Promise((resolve) => { finish = resolve; });
  render({ statusWindow: false, choices: false });
  const save = [...host.querySelectorAll('button')].find((node) => node.textContent === '저장')!;
  await act(async () => save.click());
  expect([...host.querySelectorAll('textarea')].every((node) => node.matches(':disabled'))).toBe(true);
  await act(async () => finish());
  expect([...host.querySelectorAll('textarea')].every((node) => !node.matches(':disabled'))).toBe(true);
});

describe('the similarity model in the notes panel', () => {
  /**
   * Node's own experimental `localStorage` shadows the jsdom one and is an empty
   * object without `--localstorage-file`, so the pick gets a map of its own.
   */
  const stored = new Map<string, string>();
  beforeEach(() => {
    stored.clear();
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    };
    for (const scope of new Set([globalThis, window])) {
      Object.defineProperty(scope, 'localStorage', { configurable: true, value: storage });
    }
  });

  const picker = (): HTMLElement | null => host.querySelector('[data-testid="chat-similarity"]');
  const select = (): HTMLSelectElement => picker()!.querySelector('select')!;

  it('is offered only where the plot’s scripts may search', () => {
    render({ statusWindow: false, choices: false });
    expect(picker()).toBeNull();
    render({ statusWindow: false, choices: false, scriptSimilarity: true });
    expect(picker()).not.toBeNull();
  });

  it('names each model with its download, picks the multilingual one by default, and says what it is for', () => {
    render({ statusWindow: false, choices: false, scriptSimilarity: true });
    expect(select().getAttribute('aria-labelledby')).toBe(picker()!.querySelector('h2')!.id);
    expect([...select().options].map((option) => [option.value, option.textContent])).toEqual([
      ['multiMiniLM', 'Multilingual MiniLM L12 v2 · 135MB'],
      ['MiniLM', 'MiniLM L6 v2 · 24MB'],
      ['bgeSmallEn', 'BGE Small English · 35MB'],
      ['nomic', 'Nomic Embed Text v1.5 · 138MB'],
      ['bgem3', 'BGE Medium 3 · 587MB · 무거움'],
      ['bgeM3Ko', 'BGE Medium 3 Korean · 587MB · 무거움'],
    ]);
    expect(select().value).toBe('multiMiniLM');
    expect(picker()!.textContent).toContain(messages.chat.similarityModels.multiMiniLM);
  });

  it('shows the pick this browser kept, and keeps a new one', async () => {
    stored.set('shizue.embeddingModel', 'bgeSmallEn');
    render({ statusWindow: false, choices: false, scriptSimilarity: true });
    expect(select().value).toBe('bgeSmallEn');
    await act(async () => {
      select().value = 'MiniLM';
      select().dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(stored.get('shizue.embeddingModel')).toBe('MiniLM');
    expect(select().value).toBe('MiniLM');
    expect(picker()!.textContent).toContain(messages.chat.similarityModels.MiniLM);
  });
});
