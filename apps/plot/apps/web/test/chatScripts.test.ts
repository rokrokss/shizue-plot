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
/** What the plot's public read says besides the fixture's own. */
let publicPlot: Record<string, unknown> = {};

vi.mock('@/i18n/navigation', async () => {
  const { createElement: h } = await import('react');
  return {
    Link: ({ href, children }: { href: string; children?: ReactNode }) => h('a', { href }, children),
  };
});
// Each row draws a button carrying the attribute the sanitizer leaves on one, and
// says whose name it is drawn under and the roster its lines are read against.
vi.mock('@/components/MessageRow', async () => {
  const { createElement: h } = await import('react');
  return {
    MessageRow: (props: {
      content: string;
      shown?: string;
      name: string;
      roster?: readonly { name: string; aliases?: readonly string[] }[];
    }) =>
      h(
        'div',
        {
          'data-testid': 'row',
          'data-name': props.name,
          'data-roster': JSON.stringify((props.roster ?? []).map((member) => [member.name, member.aliases ?? []])),
        },
        [
        h('span', { key: 'text' }, props.shown ?? props.content),
        h('button', { key: 'btn', type: 'button', 'data-shizue-trigger': '공격', 'data-shizue-trigger-id': 'b1' }, '베기'),
        ],
      ),
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
    afterTurn = null;
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
          ...publicPlot,
        });
      }
      return Promise.resolve([]);
    },
    apiSend: (method: string, path: string, body: unknown) => {
      sent.push({ method, path, body });
      if (path.endsWith('/script-commit')) {
        const head = chatState.path.at(-1)!;
        const fields = body as {
          content?: string;
          variableDelta?: Record<string, string | null> | null;
          chat?: { messages: { role?: ChatMessage['role']; content?: string; id?: string }[] };
        };
        // Only what a chat appends: enough for the page to show the branch it answers with.
        const added = (fields.chat?.messages ?? []).filter((item) => item.id === undefined);
        chatState = {
          ...chatState,
          path: [
            ...chatState.path.slice(0, -1),
            {
              ...head,
              ...(fields.content !== undefined ? { content: fields.content } : {}),
              ...('variableDelta' in fields && !fields.chat ? { variableDelta: fields.variableDelta ?? null } : {}),
              scriptState: null,
              scriptRev: (head.scriptRev ?? 0) + 1,
            },
            ...added.map((item, index) => message(`s${index}`, head.id, item.role!, item.content!)),
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
    subModel: null,
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
  publicPlot = {};
  store.delete('shizue.customUi');
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

  it('shows what a stopped start run did to the chat, and still keeps the text in the composer', async () => {
    bundle = scripted({
      triggers: [
        {
          comment: '',
          type: 'start',
          conditions: [],
          effect: [{ type: 'impersonate', role: 'char', value: '굴림: 7' }, { type: 'stop' }],
        },
      ],
    });
    await render();
    await sendText('/굴림');
    expect(streamed).toEqual([]);
    expect(sent).toEqual([
      {
        method: 'POST',
        path: '/api/chats/cht_1/script-commit',
        body: {
          messageId: 'm2',
          scriptRev: 0,
          variableDelta: null,
          chat: { keep: 2, messages: [{ role: 'assistant', content: '굴림: 7' }] },
        },
      },
    ]);
    expect([...host.querySelectorAll('[data-testid="row"] span')].map((node) => node.textContent)).toContain('굴림: 7');
    expect(host.querySelector('textarea')!.value).toBe('/굴림');
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

  it('answers a reader’s turn its output triggers added, when they ask for another reply', async () => {
    bundle = scripted({
      lowLevelAccess: true,
      triggers: [
        {
          comment: '',
          type: 'output',
          conditions: [],
          effect: [{ type: 'impersonate', role: 'user', value: '다음 행동' }, { type: 'sendAIprompt' }],
        },
      ],
    });
    const consenting = (state: ChatState): ChatState => ({ ...state, chat: { ...state.chat, allowComponentTurns: true } });
    chatState = consenting(chatState);
    afterTurn = consenting(
      stateWith([
        ...chatState.path,
        message('m3', 'm2', 'user', '또'),
        message('m4', 'm3', 'assistant', '날 것', { scriptState: 'pending' }),
      ]),
    );
    await render();
    await sendText('또');
    await act(async () => undefined);
    const commit = sent.find((call) => call.path.endsWith('/script-commit'));
    expect(commit?.body).toMatchObject({ messageId: 'm4', chat: { keep: 4, messages: [{ role: 'user', content: '다음 행동' }] } });
    // RisuAI generates on whatever the chat ends with: a turn of the reader's is answered, not carried on from.
    expect(streamed.map((call) => call.path)).toEqual(['/api/chats/cht_1/messages', '/api/chats/cht_1/regenerate']);
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

describe('a slash command', () => {
  it('runs on a work with scripts: what it did is committed, nothing is sent, and the composer stays empty', async () => {
    bundle = scripted({});
    await render();
    await sendText('/send 문을 연다|/setvar key=door open');
    expect(streamed).toEqual([]);
    expect(sent).toEqual([
      {
        method: 'POST',
        path: '/api/chats/cht_1/script-commit',
        body: {
          messageId: 'm2',
          scriptRev: 0,
          variableDelta: { door: 'open' },
          chat: { keep: 2, messages: [{ role: 'user', content: '문을 연다' }] },
        },
      },
    ]);
    expect([...host.querySelectorAll('[data-testid="row"] span')].map((node) => node.textContent)).toContain('문을 연다');
    expect(host.querySelector('textarea')!.value).toBe('');
  });

  it('is plain text on a work without scripts', async () => {
    await render();
    await sendText('/send 안녕');
    expect(streamed[0]!.body).toEqual({ content: '/send 안녕' });
  });

  it('is sent as text when it names a command RisuAI does not run', async () => {
    bundle = scripted({});
    await render();
    await sendText('/모름 그냥 글');
    await act(async () => undefined);
    expect(sent).toEqual([]);
    expect(streamed.map((call) => call.body)).toEqual([{ content: '/모름 그냥 글', baseHeadId: 'm2' }]);
  });

  it('asks through the script dialog, and goes on with the answer', async () => {
    bundle = scripted({});
    await render();
    await sendText('/input 이름은?|/setvar key=name');
    // The sheet is drawn over the page, outside it.
    expect(document.querySelector('[data-testid="script-dialog"]')?.textContent).toContain('이름은?');
    const field = document.querySelector<HTMLInputElement>('[data-testid="script-dialog"] input')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(field, '아린');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click([...document.querySelectorAll('[data-testid="script-dialog"] button')].find((node) => node.textContent === '확인')!);
    expect(sent.at(-1)?.body).toMatchObject({ variableDelta: { name: '아린' } });
    expect(streamed).toEqual([]);
  });

  it('sends /multisend’s message and asks for the reply once the reader agrees to it', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    bundle = scripted({});
    await render();
    await sendText('/multisend 문을 두드린다');
    await act(async () => undefined);
    expect(confirm).toHaveBeenCalledOnce();
    expect(sent[0]).toMatchObject({ method: 'PATCH', path: '/api/chats/cht_1', body: { allowComponentTurns: true } });
    // Pushed as it is: no input scripts, and answered.
    expect(streamed.map((call) => call.body)).toEqual([{ content: '문을 두드린다', baseHeadId: 'm2' }]);
    confirm.mockRestore();
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

describe('what the scripts rewrote of their character', () => {
  const rows = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('[data-testid="row"]')];
  const texts = (): string[] => rows().map((row) => row.querySelector('span')!.textContent ?? '');

  it('draws the member under the name its scripts gave it, its lines under the old one still its own', async () => {
    bundle = scripted({ memberId: 'chr_1', overlay: { member: { name: '세라' }, persona: null } });
    await render();
    // A plot of one member is that character: the chat is with the new name.
    expect(rows().map((row) => row.dataset['name'])).toEqual(['세라', '나', '세라']);
    expect(rows()[0]!.dataset['roster']).toBe(JSON.stringify([['세라', ['리안']]]));
    expect(host.textContent).toContain('세라');
  });

  it('keeps the plot’s name over a cast of several, where only the member is renamed', async () => {
    publicPlot = {
      characters: [
        { id: 'chr_1', name: '리안', avatarUrl: null, intro: '' },
        { id: 'chr_2', name: '카이', avatarUrl: null, intro: '' },
      ],
    };
    bundle = scripted({ memberId: 'chr_1', overlay: { member: { name: '세라' }, persona: null } });
    await render();
    expect(rows()[0]!.dataset['name']).toBe('여관');
    expect(rows()[0]!.dataset['roster']).toBe(JSON.stringify([['세라', ['리안']], ['카이', []]]));
  });

  it('shows the first message its scripts set where the branch opens on the first opening, and only there', async () => {
    bundle = scripted({ overlay: { member: { firstMessage: '{{char}}의 문이 다시 열린다.' }, persona: null } });
    await render();
    expect(texts()[0]).toBe('여관의 문이 다시 열린다.');

    // The branch opens on the second opening: RisuAI draws that one, as stored.
    root.unmount();
    root = createRoot(host);
    chatState = {
      ...chatState,
      siblings: { ...chatState.siblings, m0: { index: 1, total: 2, ids: ['m9', 'm0'] } },
    };
    await render();
    expect(texts()[0]).toBe('어서 와.');
  });

  it('draws the card’s background behind the conversation, or the one its scripts set, as custom UI', async () => {
    publicPlot = { backgroundHtml: '<div class="bg">hp {{getvar::hp}}</div><script>alert(1)</script>' };
    await render();
    const background = host.querySelector('[data-testid="chat-background"]')!;
    expect(background.getAttribute('aria-hidden')).toBe('true');
    // Read as CBS against the chat, and held to the display sanitizer inside the message scope.
    expect(background.querySelector('.shizue-msg')!.innerHTML).toBe('<div class="x-shizue-bg">hp 100</div>');

    root.unmount();
    root = createRoot(host);
    bundle = scripted({ overlay: { member: { backgroundHtml: '<p>밤</p>' }, persona: null } });
    await render();
    expect(host.querySelector('[data-testid="chat-background"] .shizue-msg')!.innerHTML).toBe('<p>밤</p>');

    // The reader who turned custom UI off gets none of it.
    root.unmount();
    root = createRoot(host);
    store.set('shizue.customUi', '0');
    await render();
    expect(host.querySelector('[data-testid="chat-background"]')).toBeNull();
  });

  it('draws no background for a work without one', async () => {
    await render();
    expect(host.querySelector('[data-testid="chat-background"]')).toBeNull();
    expect(texts()).toEqual(['어서 와.', '안녕', '응.']);
  });
});
