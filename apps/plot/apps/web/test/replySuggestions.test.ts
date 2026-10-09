// @vitest-environment jsdom
/**
 * The reader's own half of the conversation, suggested: three things they could
 * say next, asked for by them and never sent for them.
 *
 * Distinct from the creator's 선택지, which the plot's characters offer inside a
 * reply. These are reader-initiated, nothing about them is stored, and they
 * answer the turn as it stands — so taking a turn is what dismisses them.
 *
 * The chat page is mounted with its heavy children stubbed: the composer, the
 * chips and the run loop are what this is about, and a real message list would
 * only bring a markdown pipeline along with it.
 *
 * `createElement` rather than JSX, matching the other component tests.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/ko.json';
import { ApiError } from '../src/lib/api';
import type { ChatState } from '../src/lib/types';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

/**
 * Node's own experimental `localStorage` shadows the jsdom one and is an empty
 * object without `--localstorage-file`, so the per-browser switches the page
 * reads on mount get a map of their own — the same stand-in catalogue.test.ts
 * builds, for the same reason.
 */
const store = new Map<string, string>();
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  },
});

/** What the chat read answers with, and every write the page has sent. */
let chatState: ChatState;
let sent: { path: string; body: unknown }[] = [];
/** What the next suggest call answers with; a rejection is a refusal. */
let suggested: () => Promise<{ suggestions: string[] }>;
/** Set by a test that wants the generation to still be running. */
let hold = false;
/** How that test lets it finish. */
let release: (() => void) | null = null;
/** The maps the message rows were drawn with, newest last. */
let drawnAssets: [string, string][][] = [];
/** Chat reads so far, and whether every one after the first is left in flight. */
let chatReads = 0;
let holdRefetch = false;

vi.mock('@/i18n/navigation', async () => {
  const { createElement: h } = await import('react');
  return {
    Link: ({ href, children, ...rest }: { href: string; children?: ReactNode }) =>
      h('a', { ...rest, href }, children),
  };
});

// The list, the notes panel and the settings row are all somebody else's test.
// The row keeps one thing: the asset map it was given, which is where a locked
// image is either a marker or a URL.
vi.mock('@/components/MessageRow', async () => {
  const { createElement: h } = await import('react');
  return {
    MessageRow: ({ assets }: { assets: ReadonlyMap<string, string> }) => {
      drawnAssets.push([...assets]);
      return h('div', { 'data-testid': 'message-row' });
    },
  };
});
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
  streamGeneration: async (
    _path: string,
    _body: unknown,
    onDelta: (text: string) => void,
  ): Promise<unknown> => {
    onDelta('그렇군요.');
    if (hold) await new Promise<void>((resolve) => (release = resolve));
    return { kind: 'done', messageId: 'msg_2', usage: {}, unlockedAssetIds: ['ast_1'] };
  },
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...original,
    apiGet: (url: string) => {
      if (url.startsWith('/api/chats/')) {
        chatReads += 1;
        // Held open by the unlock test, so what is on screen can only have come
        // from the `done` event rather than from the read that follows it.
        if (holdRefetch && chatReads > 1) return new Promise(() => undefined);
        return Promise.resolve(chatState);
      }
      if (url.endsWith('/public')) {
        return Promise.resolve({ characters: [], displayScripts: [], defaultVariables: {} });
      }
      if (url.endsWith('/assets')) {
        return Promise.resolve([
          {
            slug: 'kiss',
            url: '/api/plots/sty_1/assets/kiss',
            mime: 'image/png',
            width: null,
            height: null,
            thumbhash: null,
            createdAt: '2026-08-16T00:00:00.000Z',
          },
        ]);
      }
      return Promise.resolve([]);
    },
    apiSend: (_method: string, path: string, body: unknown) => {
      sent.push({ path, body });
      if (path.endsWith('/suggest')) return suggested();
      return Promise.resolve(chatState);
    },
  };
});

const { default: ChatPage } = await import('../src/app/[locale]/(app)/(member)/chats/[id]/page');

const state = (locked: boolean): ChatState => ({
  chat: {
    id: 'cht_1',
    plotId: 'sty_1',
    personaId: null,
    title: '비 오는 밤의 서점',
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
    absentCharacterIds: [],
    noteIds: [],
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
  },
  path: [
    {
      id: 'msg_1',
      parentId: null,
      role: 'assistant',
      content: '문이 열린다. {{img::kiss}}',
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
  assetLocks: [{ assetId: 'ast_1', slug: 'kiss', locked, kind: 'keyword' }],
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
        children: createElement(ChatPage, {
          params: Promise.resolve({ id: 'cht_1' }),
        }) as ReactNode,
      }),
    );
  });
}

const suggest = (): HTMLButtonElement => host.querySelector('[data-testid="suggest-button"]')!;
const chips = (): HTMLButtonElement[] => [
  ...host.querySelectorAll<HTMLButtonElement>('[data-testid="reply-suggestion"]'),
];
const composer = (): HTMLTextAreaElement => host.querySelector('textarea')!;
const send = (): HTMLButtonElement =>
  [...host.querySelectorAll('button')].find((node) => node.textContent === '보내기')!;

async function click(node: Element): Promise<void> {
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function type(node: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  chatState = state(true);
  sent = [];
  drawnAssets = [];
  hold = false;
  release = null;
  chatReads = 0;
  holdRefetch = false;
  suggested = () => Promise.resolve({ suggestions: ['괜찮아요?', '*문을 닫는다*', '누구세요?'] });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the reply suggestions', () => {
  it('asks on the press, and puts what comes back above the composer', async () => {
    await render();
    expect(chips()).toHaveLength(0);

    await click(suggest());
    expect(sent).toEqual([{ path: '/api/chats/cht_1/suggest', body: undefined }]);
    expect(chips().map((chip) => chip.textContent)).toEqual([
      '괜찮아요?',
      '*문을 닫는다*',
      '누구세요?',
    ]);
  });

  it('fills the composer and stops there — sending stays the reader’s own act', async () => {
    await render();
    await click(suggest());
    await click(chips()[1]!);

    expect(composer().value).toBe('*문을 닫는다*');
    // One ask, and nothing sent: the chip wrote into the field and no further.
    expect(sent).toEqual([{ path: '/api/chats/cht_1/suggest', body: undefined }]);
    expect(chips()).toHaveLength(3);
  });

  it('lets them go the moment a turn is taken', async () => {
    await render();
    await click(suggest());
    await type(composer(), '괜찮아요?');
    await click(send());

    expect(chips()).toHaveLength(0);
  });

  it('stands back while a reply is streaming', async () => {
    hold = true;
    await render();
    await type(composer(), '안녕하세요');
    // The stream is held open, so the page is in the middle of a generation.
    await click(send());
    expect(suggest().disabled).toBe(true);

    await act(async () => {
      release?.();
    });
    expect(suggest().disabled).toBe(false);
  });

  it('says why it could not, quietly, and leaves the composer alone', async () => {
    await render();
    suggested = () =>
      Promise.reject(new ApiError(503, 'suggestions_unavailable', 'not configured'));
    await click(suggest());

    expect(chips()).toHaveLength(0);
    expect(host.textContent).toContain(messages.errors.suggestions_unavailable);
    // Not the banner a lost turn gets: nothing was stored and nothing was lost.
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
});

describe('an image the turn unlocked', () => {
  it('is a marker until the chat opens it, and the picture the moment it does', async () => {
    await render();
    expect(drawnAssets.at(-1)).toEqual([['kiss', '#shizue-lock:keyword']]);

    // The turn that earns the unlock. The read that follows it is held open and
    // the server's answer still says locked, so what is on screen afterwards is
    // the `done` event's doing and nothing else's.
    holdRefetch = true;
    await type(composer(), '입맞춤');
    await click(send());

    expect(drawnAssets.at(-1)).toEqual([['kiss', '/api/plots/sty_1/assets/kiss']]);
  });
});
