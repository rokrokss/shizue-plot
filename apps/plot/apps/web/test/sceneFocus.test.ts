// @vitest-environment jsdom
/**
 * The next-speaker pick in the composer: offered only among the members on the
 * stage, carried by the next reply that has a speaker, and gone once that reply
 * landed — a failed one keeps it, so the retry asks for the same thing.
 *
 * The chat page is mounted with its heavy children stubbed, as in
 * replySuggestions.test.ts; the stream is where the request body is read.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/ko.json';
import type { ChatState } from '../src/lib/types';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const store = new Map<string, string>();
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  },
});

/** Every generation the page asked for, and how the next one ends. */
let streamed: { path: string; body: unknown }[] = [];
/** Every settings write, and the props the notes panel was last drawn with. */
let patched: unknown[] = [];
let panel: Record<string, unknown> | null = null;
let outcome: 'done' | 'error' = 'done';
let chatState: ChatState;

vi.mock('@/i18n/navigation', async () => {
  const { createElement: h } = await import('react');
  return {
    Link: ({ href, children }: { href: string; children?: ReactNode }) => h('a', { href }, children),
  };
});
vi.mock('@/components/MessageRow', () => ({ MessageRow: () => null }));
vi.mock('@/components/ChatPanel', () => ({
  ChatPanel: (props: Record<string, unknown>) => {
    panel = props;
    return null;
  },
}));
vi.mock('@/components/ChatSettings', () => ({ ChatSettings: () => null }));
vi.mock('use-stick-to-bottom', async () => {
  const { createRef } = await import('react');
  return {
    useStickToBottom: () => ({
      scrollRef: createRef<HTMLDivElement>(),
      contentRef: createRef<HTMLDivElement>(),
      isAtBottom: true,
      scrollToBottom: () => undefined,
    }),
  };
});
vi.mock('@/lib/sse', () => ({
  streamGeneration: async (path: string, body: unknown): Promise<unknown> => {
    streamed.push({ path, body });
    return outcome === 'done'
      ? { kind: 'done', messageId: 'msg_2', usage: {}, unlockedAssetIds: [] }
      : { kind: 'error', message: 'provider exploded' };
  },
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...original,
    apiGet: (url: string) => {
      if (url.startsWith('/api/chats/')) return Promise.resolve(chatState);
      if (url.endsWith('/public')) {
        return Promise.resolve({
          characters: [
            { id: 'chr_lian', name: '리안', avatarUrl: null, intro: '' },
            { id: 'chr_minsu', name: '민수', avatarUrl: null, intro: '' },
            { id: 'chr_yuna', name: '유나', avatarUrl: null, intro: '' },
          ],
          displayScripts: [],
          defaultVariables: {},
        });
      }
      return Promise.resolve([]);
    },
    apiSend: (_method: string, _path: string, body: unknown) => {
      patched.push(body);
      return Promise.resolve(chatState);
    },
  };
});

const { default: ChatPage } = await import('../src/app/[locale]/(app)/(member)/chats/[id]/page');

const baseState = (absentCharacterIds: string[]): ChatState => ({
  chat: {
    id: 'cht_1',
    plotId: 'sty_1',
    personaId: null,
    title: '여관',
    model: 'm1',
    note: '',
    preset: 'default',
    headMessageId: 'msg_1',
    memory: null,
    memorySettings: null,
    relationship: null,
    relationshipEnabled: true,
    narrator: null,
    allowComponentTurns: false,
    statusWindowEnabled: false,
    choicesEnabled: false,
    reasoningEffort: null,
    absentCharacterIds,
    noteIds: [],
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
  },
  path: [
    {
      id: 'msg_1',
      parentId: null,
      role: 'assistant',
      content: '문이 열린다.',
      source: 'user',
      directions: null,
      model: null,
      promptTokens: null,
      completionTokens: null,
      attachments: [],
      createdAt: '2026-08-16T00:00:00.000Z',
    },
  ],
  siblings: { msg_1: { index: 0, total: 1, ids: ['msg_1'] } },
});

let host: HTMLElement;
let root: Root;

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'ko',
        timeZone: 'Asia/Seoul',
        messages,
        children: createElement(ChatPage, { params: Promise.resolve({ id: 'cht_1' }) }) as ReactNode,
      }),
    );
  });
}

const button = (label: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((node) => node.textContent === label);

async function click(node: Element): Promise<void> {
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function sendText(value: string): Promise<void> {
  const field = host.querySelector('textarea')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click(button('보내기')!);
}

beforeEach(() => {
  streamed = [];
  patched = [];
  panel = null;
  outcome = 'done';
  chatState = baseState(['chr_yuna']);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the next-speaker pick', () => {
  it('offers only the members on the stage, and rides on one reply', async () => {
    await render();
    await click(host.querySelector('[data-testid="focus-picker"]')!);
    expect(button('유나')).toBeUndefined();
    await click(button('민수')!);

    await sendText('안녕');
    expect(streamed[0]).toEqual({
      path: '/api/chats/cht_1/messages',
      body: { content: '안녕', focusCharacterIds: ['chr_minsu'] },
    });

    await sendText('또 안녕');
    expect(streamed[1]!.body).toEqual({ content: '또 안녕' });
  });

  it('keeps the pick through a failed reply, so the retry asks again', async () => {
    outcome = 'error';
    await render();
    await click(host.querySelector('[data-testid="focus-picker"]')!);
    await click(button('리안')!);

    await sendText('안녕');
    await click(button('다시 시도')!);
    expect(streamed[1]).toEqual({
      path: '/api/chats/cht_1/regenerate',
      body: { focusCharacterIds: ['chr_lian'] },
    });
  });

  it('is not offered when only one member is on the stage', async () => {
    chatState = baseState(['chr_minsu', 'chr_yuna']);
    await render();
    expect(host.querySelector('[data-testid="focus-picker"]')).toBeNull();
  });
});

describe('the scene cast in the notes panel', () => {
  it('sends a member away without the ids no member has any more', async () => {
    chatState = baseState(['chr_gone', 'chr_yuna']);
    await render();
    await click(button('노트')!);
    const toggle = panel!['onToggleAbsent'] as (id: string, absent: boolean) => Promise<void>;
    await act(() => toggle('chr_minsu', true));
    await act(() => toggle('chr_yuna', false));
    expect(patched).toEqual([
      { absentCharacterIds: ['chr_yuna', 'chr_minsu'] },
      { absentCharacterIds: [] },
    ]);
  });

  it('hands the inspector to the plot\'s creator only', async () => {
    await render();
    await click(button('노트')!);
    expect(panel!['inspectChatId']).toBeUndefined();

    act(() => root.unmount());
    root = createRoot(host);
    chatState = { ...baseState([]), isPlotOwner: true };
    await render();
    await click(button('노트')!);
    expect(panel!['inspectChatId']).toBe('cht_1');
  });
});
