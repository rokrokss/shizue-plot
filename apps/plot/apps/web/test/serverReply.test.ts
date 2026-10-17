// @vitest-environment jsdom
/**
 * A reply the server finishes on its own (§7.2): a dropped stream no longer stops
 * it, so the page waits for the chat's slot to free and reads what was stored;
 * the stop button says the stop to the server and reads only once it is
 * answered; and a page that opens on a reply already going waits for it too.
 *
 * The chat page is mounted with its heavy children stubbed, as in
 * modelPill.test.ts.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/ko.json';
import type { ChatState } from '../src/lib/types';

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

/** What the chat answers now, and the answers queued after it, one per read. */
let current: ChatState;
let queued: ChatState[] = [];
let chatReads = 0;
let sent: { method: string; path: string }[] = [];
/** How the next generation ends. */
let ending: 'dropped' | 'held' = 'dropped';
/** The server's answer to the stop, let go by the test. */
let answerStop: (() => void) | null = null;

vi.mock('@/i18n/navigation', async () => {
  const { createElement: h } = await import('react');
  return {
    Link: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => h('a', { ...rest, href }, children),
  };
});
vi.mock('@/components/MessageRow', () => ({ MessageRow: () => null }));
vi.mock('@/components/ChatPanel', () => ({ ChatPanel: () => null }));
vi.mock('@/components/ChatSettings', () => ({ ChatSettings: () => null }));
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
  streamGeneration: async (
    _path: string,
    _body: unknown,
    onDelta: (text: string) => void,
    signal: AbortSignal,
  ): Promise<unknown> => {
    onDelta('부분');
    if (ending === 'dropped') return { kind: 'dropped' };
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
    return { kind: 'aborted' };
  },
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...original,
    apiGet: (url: string) => {
      if (url === '/api/models') return Promise.resolve([]);
      if (url.endsWith('/public')) return Promise.resolve({ characters: [], displayScripts: [], defaultVariables: {} });
      if (url === '/api/chats/cht_1' || url.startsWith('/api/chats/cht_1?')) {
        chatReads += 1;
        current = queued.shift() ?? current;
        return Promise.resolve(current);
      }
      if (url.startsWith('/api/chats/')) return Promise.resolve(current);
      return Promise.resolve([]);
    },
    apiSend: (method: string, path: string) => {
      sent.push({ method, path });
      if (path.endsWith('/stop')) return new Promise<void>((resolve) => (answerStop = resolve));
      return Promise.resolve(current);
    },
  };
});

const { default: ChatPage } = await import('../src/app/[locale]/(app)/(member)/chats/[id]/page');

const message = (id: string, parentId: string | null, role: 'user' | 'assistant', content: string) => ({
  id, parentId, role, content, source: 'user', directions: null, model: null, promptTokens: null,
  completionTokens: null, attachments: [], createdAt: '2026-08-16T00:00:00.000Z',
});
const greeting = message('msg_1', null, 'assistant', '문이 열린다.');
const turn = message('msg_2', 'msg_1', 'user', '안녕');
const reply = message('msg_3', 'msg_2', 'assistant', '부분 응답 끝.');

const state = (path: ReturnType<typeof message>[], generating: boolean): ChatState =>
  ({
    chat: {
      id: 'cht_1', plotId: 'sty_1', personaId: null, title: '비 오는 밤의 서점', model: 'm1', subModel: null, note: '',
      preset: 'default', headMessageId: path.at(-1)!.id, memoryRevision: 0, memorySettings: null, relationship: null,
      relationshipEnabled: true, narrator: null, allowComponentTurns: false, statusWindowEnabled: false,
      choicesEnabled: false, reasoningEffort: null, absentCharacterIds: [], noteIds: [], generating,
      createdAt: '2026-08-16T00:00:00.000Z', updatedAt: '2026-08-16T00:00:00.000Z',
    },
    path,
    siblings: Object.fromEntries(path.map((entry) => [entry.id, { index: 0, total: 1, ids: [entry.id] }])),
  }) as unknown as ChatState;

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  current = state([greeting], false);
  queued = [];
  chatReads = 0;
  sent = [];
  ending = 'dropped';
  answerStop = null;
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

const button = (label: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === label);
const notice = (): Element | null => host.querySelector('[data-testid="server-generating"]');
const alert = (): Element | null => host.querySelector('[role="alert"]');

async function send(text: string): Promise<void> {
  const composer = host.querySelector('textarea')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(composer, text);
    composer.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button(messages.chat.send)!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

/** Lets real time pass inside `act` until `check` holds; the page polls every two seconds. */
async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 6_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(what);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 100)));
  }
}

describe('a reply the server finishes on its own', () => {
  it('waits for the reply a dropped stream left with the server, then lets go without an error', async () => {
    await render();
    // The first read after the drop finds the reply still going; the next finds it stored.
    queued = [state([greeting, turn], true), state([greeting, turn, reply], false)];
    const before = chatReads;
    await send('안녕');

    expect(notice()).not.toBeNull();
    expect(button(messages.chat.stop)).toBeDefined();
    await until(() => notice() === null, 'the page never stopped waiting');
    expect(chatReads - before).toBeGreaterThanOrEqual(2);
    expect(current.path.at(-1)!.id).toBe('msg_3');
    expect(alert()).toBeNull();
    expect(button(messages.chat.send)).toBeDefined();
  }, 10_000);

  it('says it lost the reply when the server stored nothing either', async () => {
    await render();
    queued = [state([greeting, turn], false)];
    await send('안녕');
    await until(() => alert() !== null, 'no error was shown');
    expect(alert()!.textContent).toContain(messages.errors.stream_interrupted);
  });

  it('asks the server to stop, and reads the chat only once the stop is answered', async () => {
    await render();
    ending = 'held';
    await send('안녕');
    queued = [state([greeting, turn, message('msg_3', 'msg_2', 'assistant', '부분')], false)];
    const before = chatReads;

    await act(async () => button(messages.chat.stop)!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(sent).toContainEqual({ method: 'POST', path: '/api/chats/cht_1/stop' });
    // The stopped reply is not stored until the server answers, so nothing reads before then.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(chatReads).toBe(before);

    await act(async () => answerStop!());
    await until(() => chatReads > before, 'the chat was never read after the stop');
    await until(() => button(messages.chat.send) !== undefined, 'the composer never let go');
    expect(alert()).toBeNull();
  });

  it('waits on a reply already going when the page opens, with sending held', async () => {
    current = state([greeting, turn], true);
    queued = [state([greeting, turn], true), state([greeting, turn, reply], false)];
    await render();
    expect(notice()).not.toBeNull();
    expect(button(messages.chat.send)!.disabled).toBe(true);

    await until(() => notice() === null, 'the page never saw the reply land');
    expect(current.path.at(-1)!.id).toBe('msg_3');
  }, 10_000);
});
