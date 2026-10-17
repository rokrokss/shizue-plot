// @vitest-environment jsdom
/**
 * The header's model pill — Zeta's "zeta ⌄": the chat's main model by name, a
 * tap on it the same list the settings offer, a pick saved by the chat's PATCH
 * as the settings save it, and nothing to pick while a reply is written.
 *
 * The chat page is mounted with its heavy children stubbed, as in
 * replySuggestions.test.ts; the header is what this is about.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/ko.json';
import type { ChatState, ModelInfo } from '../src/lib/types';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

// Node's own `localStorage` shadows jsdom's (replySuggestions.test.ts).
const store = new Map<string, string>();
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  },
});

const MODELS: ModelInfo[] = [
  { id: 'm1', label: '모델 하나' },
  { id: 'm2', label: '모델 둘' },
] as ModelInfo[];

let chatState: ChatState;
let sent: { method: string; path: string; body: unknown }[] = [];
/** How a held generation is let finish. */
let release: (() => void) | null = null;

vi.mock('@/i18n/navigation', async () => {
  const { createElement: h } = await import('react');
  return {
    Link: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => h('a', { ...rest, href }, children),
  };
});
vi.mock('@/components/MessageRow', () => ({ MessageRow: () => null }));
vi.mock('@/components/ChatPanel', () => ({ ChatPanel: () => null }));
vi.mock('@/components/ChatSettings', () => ({ ChatSettings: () => null }));
// The member layout's session, by which the page leases the reader's Lua sandbox.
vi.mock('@/lib/authClient', () => ({ useSession: () => ({ data: { user: { id: 'reader' } }, isPending: false }) }));
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
  streamGeneration: async (_path: string, _body: unknown, onDelta: (text: string) => void): Promise<unknown> => {
    onDelta('그렇군요.');
    await new Promise<void>((resolve) => (release = resolve));
    return { kind: 'done', messageId: 'msg_2', usage: {} };
  },
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...original,
    apiGet: (url: string) => {
      if (url === '/api/models') return Promise.resolve(MODELS);
      if (url.startsWith('/api/chats/')) return Promise.resolve(chatState);
      if (url.endsWith('/public')) return Promise.resolve({ characters: [], displayScripts: [], defaultVariables: {} });
      return Promise.resolve([]);
    },
    apiSend: (method: string, path: string, body: unknown) => {
      sent.push({ method, path, body });
      if (method === 'PATCH') chatState = { ...chatState, chat: { ...chatState.chat, ...(body as object) } };
      return Promise.resolve(chatState);
    },
  };
});

const { default: ChatPage } = await import('../src/app/[locale]/(app)/(member)/chats/[id]/page');

const state = (model: string): ChatState =>
  ({
    chat: {
      id: 'cht_1', plotId: 'sty_1', personaId: null, title: '비 오는 밤의 서점', model, subModel: null, note: '',
      preset: 'default', headMessageId: 'msg_1', memoryRevision: 0, memorySettings: null, relationship: null,
      relationshipEnabled: true, narrator: null, allowComponentTurns: false, allowLowLevelAccess: false, statusWindowEnabled: false,
      choicesEnabled: false, reasoningEffort: null, absentCharacterIds: [], noteIds: [],
      createdAt: '2026-08-16T00:00:00.000Z', updatedAt: '2026-08-16T00:00:00.000Z',
    },
    path: [
      {
        id: 'msg_1', parentId: null, role: 'assistant', content: '문이 열린다.', source: 'user', directions: null,
        model: null, promptTokens: null, completionTokens: null, attachments: [], createdAt: '2026-08-16T00:00:00.000Z',
      },
    ],
    siblings: { msg_1: { index: 0, total: 1, ids: ['msg_1'] } },
  }) as unknown as ChatState;

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  chatState = state('m1');
  sent = [];
  release = null;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'ko', timeZone: 'Asia/Seoul', messages,
        children: createElement(ChatPage, { params: Promise.resolve({ id: 'cht_1' }) }) as ReactNode,
      }),
    );
  });
}

const pill = (): HTMLElement => host.querySelector('[data-testid="model-pill"]')!;
const picker = (): HTMLSelectElement => pill().querySelector('select')!;
/** What the pill shows, past the options the select holds. */
const face = (): string | null | undefined => pill().querySelector('span[aria-hidden="true"]')?.textContent;
const options = (): string[] => [...picker().options].map((option) => `${option.value}:${option.textContent}`);

async function pick(value: string): Promise<void> {
  await act(async () => {
    picker().value = value;
    picker().dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('the header’s model pill', () => {
  it('names the main model, offers the settings’ list, and saves a pick by the chat’s PATCH', async () => {
    await render();
    expect(face()).toBe('모델 하나');
    // Its own name, so the settings' "모델" stays the one control of that name.
    expect(picker().getAttribute('aria-label')).toBe(messages.chat.modelPill);
    expect(options()).toEqual(['m1:모델 하나', 'm2:모델 둘']);

    await pick('m2');
    expect(sent).toEqual([{ method: 'PATCH', path: '/api/chats/cht_1', body: { model: 'm2' } }]);
    expect(face()).toBe('모델 둘');
  });

  it('keeps a model the catalog has dropped, by its id, until another is picked', async () => {
    chatState = state('retired-model');
    await render();
    expect(face()).toBe('retired-model');
    expect(options()).toEqual(['retired-model:retired-model', 'm1:모델 하나', 'm2:모델 둘']);
  });

  it('is held while a reply is written', async () => {
    await render();
    expect(picker().disabled).toBe(false);
    const composer = host.querySelector('textarea')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(composer, '안녕');
      composer.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const sendButton = [...host.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === '보내기')!;
    await act(async () => sendButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(release).not.toBeNull();
    expect(picker().disabled).toBe(true);
    expect(picker().title).toBe(messages.chat.lockedWhileGenerating);

    await act(async () => release!());
    expect(picker().disabled).toBe(false);
  });
});
