// @vitest-environment jsdom
/**
 * A card's scripts on the chat page: a send carries what the input and start
 * scripts decided, a reply the server holds pending is finished — after the turn
 * and on load — a button runs its manual trigger, and a start trigger's stop
 * keeps the text in the composer.
 *
 * The chat page is mounted with its heavy children stubbed, as in
 * sceneFocus.test.ts; the stream and the API are where the requests are read.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/ko.json';
import type { ScriptBundle } from '../src/lib/scripts/runtime';
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

let streamed: { path: string; body: unknown }[] = [];
let sent: { method: string; path: string; body: unknown }[] = [];
let chatState: ChatState;
/** What the server holds after a generation, if it differs from `chatState`. */
let afterTurn: ChatState | null = null;
let bundle: ScriptBundle | null = null;

vi.mock('@/i18n/navigation', async () => {
  const { createElement: h } = await import('react');
  return {
    Link: ({ href, children }: { href: string; children?: ReactNode }) => h('a', { href }, children),
  };
});
// Each row draws a button carrying the attribute the sanitizer leaves on one.
vi.mock('@/components/MessageRow', async () => {
  const { createElement: h } = await import('react');
  return {
    MessageRow: (props: { content: string; shown?: string }) =>
      h('div', { 'data-testid': 'row' }, [
        h('span', { key: 'text' }, props.shown ?? props.content),
        h('button', { key: 'btn', type: 'button', 'data-shizue-trigger': '공격', 'data-shizue-trigger-id': 'b1' }, '베기'),
      ]),
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
  streamGeneration: async (path: string, body: unknown): Promise<unknown> => {
    streamed.push({ path, body });
    if (afterTurn) chatState = afterTurn;
    return { kind: 'done', messageId: 'm3', usage: {}, unlockedAssetIds: [] };
  },
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...original,
    apiGet: (url: string) => {
      if (url.endsWith('/scripts')) return Promise.resolve({ scripts: bundle });
      if (url.startsWith('/api/chats/')) return Promise.resolve(chatState);
      if (url.endsWith('/public')) {
        return Promise.resolve({
          name: '여관',
          characters: [{ id: 'chr_1', name: '리안', avatarUrl: null, intro: '' }],
          displayScripts: [],
          defaultVariables: { hp: '100' },
        });
      }
      return Promise.resolve([]);
    },
    apiSend: (method: string, path: string, body: unknown) => {
      sent.push({ method, path, body });
      if (path.endsWith('/script-commit')) {
        const head = chatState.path.at(-1)!;
        const fields = body as { content?: string; variableDelta?: Record<string, string | null> | null };
        chatState = {
          ...chatState,
          path: [
            ...chatState.path.slice(0, -1),
            {
              ...head,
              ...(fields.content !== undefined ? { content: fields.content } : {}),
              ...('variableDelta' in fields ? { variableDelta: fields.variableDelta ?? null } : {}),
              scriptState: null,
              scriptRev: (head.scriptRev ?? 0) + 1,
            },
          ],
        };
      }
      return Promise.resolve(chatState);
    },
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
  scriptRev: 0,
  scriptState: null,
  createdAt: '2026-10-13T00:00:00.000Z',
  ...extra,
});

const stateWith = (path: ChatMessage[]): ChatState => ({
  chat: {
    id: 'cht_1',
    plotId: 'sty_1',
    personaId: null,
    title: '여관',
    model: 'm1',
    note: '',
    preset: 'default',
    headMessageId: path.at(-1)!.id,
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
    createdAt: '2026-10-13T00:00:00.000Z',
    updatedAt: '2026-10-13T00:00:00.000Z',
  },
  path,
  siblings: Object.fromEntries(path.map((entry) => [entry.id, { index: 0, total: 1, ids: [entry.id] }])),
});

const scripted = (extra: Partial<ScriptBundle>): ScriptBundle => ({
  memberId: '00000000-0000-4000-8000-000000000001',
  name: '리안',
  triggers: [],
  editScripts: [],
  lowLevelAccess: false,
  character: { description: '', personality: '', scenario: '', exampleDialogue: '', lorebook: [], postHistoryInstructions: '' },
  overlay: { member: null, persona: null },
  ...extra,
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
  // The scripts' read and the plot's land after the first render.
  await act(async () => undefined);
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

const greeting = message('m0', null, 'assistant', '어서 와.');

beforeEach(() => {
  streamed = [];
  sent = [];
  afterTurn = null;
  bundle = null;
  chatState = stateWith([greeting, message('m1', 'm0', 'user', '안녕'), message('m2', 'm1', 'assistant', '응.')]);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('a send', () => {
  it('carries the rewritten text, the delta, the injections and the head it ran on', async () => {
    bundle = scripted({
      triggers: [
        {
          comment: '',
          type: 'start',
          conditions: [],
          effect: [
            { type: 'setvar', var: 'hp', value: '10', operator: '-=' },
            { type: 'systemprompt', location: 'promptend', value: '조심.' },
          ],
        },
        { comment: '', type: 'output', conditions: [], effect: [] },
      ],
      editScripts: [{ type: 'editinput', in: '공격', out: '베어 들어간다' }],
    });
    await render();
    await sendText('공격!');
    expect(streamed[0]).toEqual({
      path: '/api/chats/cht_1/messages',
      body: {
        content: '베어 들어간다!',
        baseHeadId: 'm2',
        postProcess: true,
        variableDelta: { hp: '90' },
        injections: { promptend: '조심.\n\n' },
      },
    });
  });

  it('keeps the text in the composer when a start trigger stops it', async () => {
    bundle = scripted({
      triggers: [{ comment: '', type: 'start', conditions: [], effect: [{ type: 'stop' }] }],
    });
    await render();
    await sendText('/상태');
    expect(streamed).toEqual([]);
    expect(host.querySelector('textarea')!.value).toBe('/상태');
    expect(host.querySelector('[data-testid="script-notice"]')).not.toBeNull();
  });

  it('sends as it always did when the plot carries no scripts', async () => {
    await render();
    await sendText('안녕');
    expect(streamed[0]!.body).toEqual({ content: '안녕' });
  });
});

describe('a pending reply', () => {
  it('is finished after the turn that made it, before the composer is given back', async () => {
    bundle = scripted({
      editScripts: [{ type: 'editoutput', in: '날 것', out: '다듬은 것' }],
    });
    afterTurn = stateWith([
      ...chatState.path,
      message('m3', 'm2', 'user', '또'),
      message('m4', 'm3', 'assistant', '날 것', { scriptState: 'pending' }),
    ]);
    await render();
    await sendText('또');
    const commit = sent.find((call) => call.path.endsWith('/script-commit'));
    expect(commit?.body).toMatchObject({ messageId: 'm4', scriptRev: 0, clearPending: true, content: '다듬은 것' });
  });

  it('is finished when the chat opens on one', async () => {
    bundle = scripted({ editScripts: [{ type: 'editoutput', in: '응', out: '그래' }] });
    chatState = stateWith([greeting, message('m1', 'm0', 'user', '안녕'), message('m2', 'm1', 'assistant', '응.', { scriptState: 'pending', scriptRev: 3 })]);
    await render();
    await act(async () => undefined);
    expect(sent).toEqual([
      {
        method: 'POST',
        path: '/api/chats/cht_1/script-commit',
        body: { messageId: 'm2', scriptRev: 3, clearPending: true, variableDelta: null, content: '그래.' },
      },
    ]);
  });

  it('is kept as written when the plot has no scripts left to finish it', async () => {
    chatState = stateWith([greeting, message('m1', 'm0', 'assistant', '응.', { parentId: 'm0', scriptState: 'pending' })]);
    await render();
    await act(async () => undefined);
    expect(sent).toEqual([
      { method: 'POST', path: '/api/chats/cht_1/script-commit', body: { messageId: 'm1', scriptRev: 0, clearPending: true } },
    ]);
  });
});

describe('a button', () => {
  it('runs the manual trigger it names and commits on the head', async () => {
    bundle = scripted({
      triggers: [
        {
          comment: '공격',
          type: 'manual',
          conditions: [],
          effect: [{ type: 'v2SetVar', var: 'hit', value: '{{trigger_id}}', operator: '=', valueType: 'value', indent: 0 }],
        },
      ],
    });
    await render();
    const rows = host.querySelectorAll('[data-testid="row"] button');
    await click(rows[rows.length - 1]!);
    expect(sent).toEqual([
      {
        method: 'POST',
        path: '/api/chats/cht_1/script-commit',
        body: { messageId: 'm2', scriptRev: 0, variableDelta: { hit: 'b1' } },
      },
    ]);
  });
});
