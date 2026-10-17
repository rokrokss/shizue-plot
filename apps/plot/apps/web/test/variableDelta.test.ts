// @vitest-environment jsdom
/**
 * The chat page's own variable fold reads what a card's scripts left on each
 * message (`variableDelta`), laid over that message's macros — the same fold the
 * server runs for the prompt, so the status window and the model agree.
 *
 * The chat page is mounted with its heavy children stubbed, as in
 * sceneFocus.test.ts; the variables are read off the display context the page
 * hands every message row.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/ko.json';
import type { ChatMessage, ChatState } from '../src/lib/types';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const store = new Map<string, string>();
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  },
});

/** The variables each message row was last drawn with. */
let drawn: Record<string, string>[] = [];
let chatState: ChatState;

vi.mock('@/i18n/navigation', async () => {
  const { createElement: h } = await import('react');
  return {
    Link: ({ href, children }: { href: string; children?: ReactNode }) => h('a', { href }, children),
    useRouter: () => ({ back: () => {}, push: () => {}, replace: () => {} }),
  };
});
vi.mock('@/components/MessageRow', () => ({
  MessageRow: (props: { display?: { variables: Record<string, string> } }) => {
    if (props.display) drawn.push({ ...props.display.variables });
    return null;
  },
}));
vi.mock('@/components/ChatPanel', () => ({ ChatPanel: () => null }));
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
  streamGeneration: async (): Promise<unknown> => ({ kind: 'done', messageId: 'msg_9', usage: {} }),
}));
// The member layout's session, by which the page leases the reader's Lua sandbox.
vi.mock('@/lib/authClient', () => ({ useSession: () => ({ data: { user: { id: 'reader' } }, isPending: false }) }));
vi.mock('@/lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...original,
    apiGet: (url: string) => {
      if (url.startsWith('/api/chats/')) return Promise.resolve(chatState);
      if (url.endsWith('/public')) {
        return Promise.resolve({
          characters: [{ id: 'chr_1', name: '리안', avatarUrl: null, intro: '' }],
          // One script is all it takes for the page to hand the rows a display
          // context, which is where the fold is read back.
          displayScripts: [{ in: 'HP', out: 'HP', order: 0, enabled: true }],
          defaultVariables: { route: '1', hp: '100' },
        });
      }
      return Promise.resolve([]);
    },
    apiSend: () => Promise.resolve(chatState),
  };
});

const { default: ChatPage } = await import('../src/app/[locale]/(app)/(member)/chats/[id]/page');

const message = (id: string, parentId: string | null, role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  parentId,
  role,
  content,
  source: 'user',
  directions: null,
  model: null,
  promptTokens: null,
  completionTokens: null,
  attachments: [],
  createdAt: '2026-08-16T00:00:00.000Z',
  ...extra,
});

const stateWith = (path: ChatMessage[]): ChatState => ({
  chat: {
    id: 'cht_1',
    plotId: 'sty_1',
    personaId: null,
    title: '여관',
    model: 'm1',
    subModel: null,
    note: '',
    preset: 'default',
    readerPresetId: null,
    headMessageId: path.at(-1)!.id,
    memoryRevision: 0,
    memorySettings: null,
    narrator: null,
    allowComponentTurns: false,
    statusWindowEnabled: false,
    choicesEnabled: false,
    reasoningEffort: null,
    absentCharacterIds: [],
    noteIds: [],
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
  },
  path,
  siblings: Object.fromEntries(path.map((entry) => [entry.id, { index: 0, total: 1, ids: [entry.id] }])),
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

beforeEach(() => {
  drawn = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("the page's variable fold", () => {
  it("lays each message's script delta over its macros, and folds the next message on top", async () => {
    chatState = stateWith([
      // A click on the opening's button left a route, and the opening's own macro
      // set the HP the delta then overrode.
      message('msg_1', null, 'assistant', '{{setvar::hp::90}}문이 열린다.', {
        variableDelta: { route: '2', hp: '80', door: 'open' },
      }),
      message('msg_2', 'msg_1', 'user', '{{addvar::hp::-5}} 들어간다', { variableDelta: null }),
      // The output scripts unset the door, and nothing else.
      message('msg_3', 'msg_2', 'assistant', '삐걱.', { variableDelta: { door: null } }),
    ]);
    await render();

    expect(drawn.at(-1)).toEqual({ route: '2', hp: '75' });
  });

  it('reads a branch whose messages carry no delta exactly as before', async () => {
    chatState = stateWith([
      message('msg_1', null, 'assistant', '{{setvar::hp::90}}문이 열린다.'),
      message('msg_2', 'msg_1', 'user', '{{addvar::hp::-5}} 들어간다'),
    ]);
    await render();

    expect(drawn.at(-1)).toEqual({ route: '1', hp: '85' });
  });
});
