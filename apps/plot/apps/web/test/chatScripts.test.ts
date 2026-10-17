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
import { act, createElement, StrictMode, type ReactNode } from 'react';
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
/** A work of several members: one bundle per scripted member, in roster order. */
let bundles: ScriptBundle[] | null = null;
/** What the plot's public read says besides the fixture's own. */
let publicPlot: Record<string, unknown> = {};
/** The server refuses a turn stored without a reply. */
let refuseTurn = false;
/** When set, the plot's public read waits for it. */
let plotGate: Promise<void> | null = null;

/** How many script runtimes the page built, and how many it let go. */
const runtimeLife = { made: 0, disposed: 0 };
vi.mock('@/lib/scripts/runtime', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/scripts/runtime')>();
  return {
    ...original,
    createScriptRuntime: (...args: Parameters<typeof original.createScriptRuntime>) => {
      runtimeLife.made += 1;
      const runtime = original.createScriptRuntime(...args);
      const dispose = runtime.dispose.bind(runtime);
      (runtime as { dispose: () => void }).dispose = () => {
        runtimeLife.disposed += 1;
        dispose();
      };
      return runtime;
    },
  };
});

vi.mock('@/i18n/navigation', async () => {
  const { createElement: h } = await import('react');
  return {
    Link: ({ href, children }: { href: string; children?: ReactNode }) => h('a', { href }, children),
  };
});
// Each row draws a button carrying the attribute the sanitizer leaves on one, and
// says whose name it is drawn under and the roster its lines are read against —
// and the page's own footer under it, where the regenerate button is.
vi.mock('@/components/MessageRow', async () => {
  const { createElement: h } = await import('react');
  return {
    MessageRow: (props: {
      content: string;
      shown?: string;
      name: string;
      roster?: readonly { name: string; aliases?: readonly string[] }[];
      speaker?: string;
      member?: string;
      spoken?: boolean;
      footer?: ReactNode | ((edit: (() => void) | null) => ReactNode);
    }) =>
      h(
        'div',
        {
          'data-testid': 'row',
          ...(props.member !== undefined ? { 'data-shizue-member': props.member } : {}),
          ...(props.spoken ? { 'data-shizue-spoken': '' } : {}),
          'data-name': props.name,
          'data-roster': JSON.stringify((props.roster ?? []).map((member) => [member.name, member.aliases ?? []])),
          ...(props.speaker !== undefined ? { 'data-speaker': props.speaker } : {}),
        },
        [
        h('span', { key: 'text' }, props.shown ?? props.content),
        h('button', { key: 'btn', type: 'button', 'data-shizue-trigger': '공격', 'data-shizue-trigger-id': 'b1' }, '베기'),
        h('div', { key: 'footer' }, typeof props.footer === 'function' ? props.footer(null) : props.footer),
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
    return { kind: 'done', messageId: 'm3', usage: {} };
  },
}));
// The member layout's session, by which the page leases the reader's Lua sandbox.
vi.mock('@/lib/authClient', () => ({ useSession: () => ({ data: { user: { id: 'reader' } }, isPending: false }) }));
vi.mock('@/lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...original,
    apiGet: (url: string) => {
      if (url.endsWith('/scripts')) {
        return Promise.resolve(bundles ? { scripts: bundles[0], members: bundles } : { scripts: bundle, members: bundle ? [bundle] : [] });
      }
      if (url.startsWith('/api/chats/')) return Promise.resolve(chatState);
      if (url.endsWith('/public')) {
        return (plotGate ?? Promise.resolve()).then(() => ({
          name: '여관',
          characters: [{ id: 'chr_1', name: '리안', avatarUrl: null, intro: '' }],
          displayScripts: [],
          defaultVariables: { hp: '100' },
          ...publicPlot,
        }));
      }
      return Promise.resolve([]);
    },
    apiSend: (method: string, path: string, body: unknown) => {
      sent.push({ method, path, body });
      if (path.endsWith('/messages') && refuseTurn) {
        return Promise.reject(new original.ApiError(409, 'head_moved', 'The chat moved on'));
      }
      if (path.endsWith('/messages')) {
        // A turn stored without a reply: where the chat places it, else last, with its delta.
        const fields = body as {
          content: string;
          variableDelta?: Record<string, string | null>;
          chat?: { keep: number; messages: ({ turn: true } | { role: ChatMessage['role']; content: string })[] };
        };
        const kept = fields.chat ? chatState.path.slice(0, 1 + fields.chat.keep) : chatState.path;
        const items = fields.chat?.messages ?? [{ turn: true as const }];
        const path = [...kept];
        items.forEach((item, index) => {
          const parent = path.at(-1)?.id ?? null;
          path.push('turn' in item ? message('u1', parent, 'user', fields.content) : message(`s${index}`, parent, item.role, item.content));
        });
        path[path.length - 1] = { ...path.at(-1)!, variableDelta: fields.variableDelta ?? null };
        chatState = stateWith(path);
      }
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
    readerPresetId: null,
    headMessageId: path.at(-1)!.id,
    memoryRevision: 0,
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
  // By what it says, or — an icon button — by its name.
  [...host.querySelectorAll('button')].find((node) => node.textContent === label || node.getAttribute('aria-label') === label);

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
  bundles = null;
  publicPlot = {};
  refuseTurn = false;
  plotGate = null;
  runtimeLife.made = 0;
  runtimeLife.disposed = 0;
  store.delete('shizue.customUi');
  chatState = stateWith([greeting, message('m1', 'm0', 'user', '안녕'), message('m2', 'm1', 'assistant', '응.')]);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  act(() => root.unmount());
  host.remove();
  // The page gives its script runtimes back a tick after it goes; let that land
  // here rather than in the next test's counts.
  await new Promise((resolve) => setTimeout(resolve, 0));
});

describe('opening', () => {
  it('waits for the plot’s read before drawing the chat, so its display scripts are there for the first paint', async () => {
    let release = (): void => undefined;
    plotGate = new Promise((resolve) => (release = resolve));
    await render();
    expect(host.querySelectorAll('[data-testid="row"]')).toHaveLength(0);
    await act(async () => release());
    await act(async () => undefined);
    expect(host.querySelectorAll('[data-testid="row"]').length).toBeGreaterThan(0);
  });

  it('does not wait on a plot whose read failed', async () => {
    plotGate = Promise.reject(new Error('gone'));
    plotGate.catch(() => undefined);
    await render();
    await act(async () => undefined);
    expect(host.querySelectorAll('[data-testid="row"]').length).toBeGreaterThan(0);
  });
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

  it('stores the turn with no reply and empties the composer when a start trigger stops it, and answers it on a regenerate', async () => {
    // Stops the first send only: the value it writes rides on the stored turn.
    bundle = scripted({
      triggers: [
        {
          comment: '',
          type: 'start',
          conditions: [{ type: 'var', var: 'held', value: '', operator: 'null' }],
          effect: [{ type: 'setvar', var: 'held', value: '1', operator: '=' }, { type: 'stop' }],
        },
        { comment: '', type: 'output', conditions: [], effect: [] },
      ],
    });
    await render();
    await sendText('/상태');
    expect(streamed).toEqual([]);
    expect(sent).toEqual([
      {
        method: 'POST',
        path: '/api/chats/cht_1/messages',
        body: { content: '/상태', baseHeadId: 'm2', variableDelta: { held: '1' }, stopped: true },
      },
    ]);
    // RisuAI's composer is empty once the turn is in the chat, and the turn is the head.
    expect(host.querySelector('textarea')!.value).toBe('');
    expect([...host.querySelectorAll('[data-testid="row"] > span')].map((node) => node.textContent).at(-1)).toBe('/상태');
    expect(host.querySelector('[data-testid="script-notice"]')).not.toBeNull();

    // A user head is answered the way any is: a regenerate builds on the stored turn.
    afterTurn = stateWith([...chatState.path, message('m3', 'u1', 'assistant', '상태: 좋음')]);
    await click(button('재생성')!);
    expect(streamed).toEqual([{ path: '/api/chats/cht_1/regenerate', body: { baseHeadId: 'u1', postProcess: true } }]);
  });

  it('stores the turn where a stopped start run left it, with what it added after it', async () => {
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
        path: '/api/chats/cht_1/messages',
        body: {
          content: '/굴림',
          baseHeadId: 'm2',
          chat: { keep: 2, messages: [{ turn: true }, { role: 'assistant', content: '굴림: 7' }] },
          stopped: true,
        },
      },
    ]);
    expect([...host.querySelectorAll('[data-testid="row"] > span')].map((node) => node.textContent).slice(-2)).toEqual(['/굴림', '굴림: 7']);
    expect(host.querySelector('textarea')!.value).toBe('');
  });

  it('gives the text back when the stopped turn could not be stored', async () => {
    bundle = scripted({ triggers: [{ comment: '', type: 'start', conditions: [], effect: [{ type: 'stop' }] }] });
    refuseTurn = true;
    await render();
    await sendText('/상태');
    expect(sent.map((call) => call.path)).toEqual(['/api/chats/cht_1/messages']);
    expect(host.querySelector('textarea')!.value).toBe('/상태');
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
    expect([...host.querySelectorAll('[data-testid="row"] > span')].map((node) => node.textContent)).toContain('문을 연다');
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

  it('answers /buttons with the index of the button the reader took', async () => {
    bundle = scripted({});
    await render();
    await sendText('/buttons labels=["가","나"]|/setvar key=pick');
    const options = [...document.querySelectorAll('[data-testid="script-dialog"] li button')];
    expect(options.map((node) => node.textContent)).toEqual(['가', '나']);
    await click(options[1]!);
    expect(sent.at(-1)?.body).toMatchObject({ variableDelta: { pick: '1' } });
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
    const rows = host.querySelectorAll('[data-testid="row"] button[data-shizue-trigger]');
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

    // RisuAI's display pass over the background runs the display triggers too.
    root.unmount();
    root = createRoot(host);
    bundle = scripted({
      overlay: { member: { backgroundHtml: '<p>밤</p>' }, persona: null },
      triggers: [
        {
          comment: '',
          type: 'display',
          conditions: [],
          effect: [
            { type: 'v2GetDisplayState', outputVar: 'text', indent: 0 },
            { type: 'v2ConcatString', source1: 'text', source1Type: 'var', source2: '<p>별</p>', source2Type: 'value', outputVar: 'text', indent: 0 },
            { type: 'v2SetDisplayState', value: 'text', valueType: 'var', indent: 0 },
          ],
        },
      ],
    });
    await render();
    expect(host.querySelector('[data-testid="chat-background"] .shizue-msg')!.innerHTML).toBe('<p>밤</p><p>별</p>');

    // The reader who turned custom UI off gets none of it.
    root.unmount();
    root = createRoot(host);
    store.set('shizue.customUi', '0');
    await render();
    expect(host.querySelector('[data-testid="chat-background"]')).toBeNull();
  });

  it('draws a character message its scripts wrote as their member’s, under the name it goes by here', async () => {
    publicPlot = {
      characters: [
        { id: 'chr_1', name: '리안', avatarUrl: null, intro: '' },
        { id: 'chr_2', name: '카이', avatarUrl: null, intro: '' },
      ],
    };
    bundle = scripted({ memberId: 'chr_2', overlay: { member: { name: '카이로' }, persona: null } });
    chatState = stateWith([...chatState.path, message('m3', 'm2', 'assistant', '굴림: 7', { source: 'script' })]);
    await render();
    // The model's reply names its own speakers; the one the script wrote is its member's.
    expect(rows().map((row) => row.dataset['speaker'] ?? null)).toEqual([null, null, null, '카이로']);
  });

  it('draws no background for a work without one', async () => {
    await render();
    expect(host.querySelector('[data-testid="chat-background"]')).toBeNull();
    expect(texts()).toEqual(['어서 와.', '안녕', '응.']);
  });
});

describe('a work of two members', () => {
  const rows = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('[data-testid="row"]')];
  const setvar = (variable: string, value: string) => ({
    type: 'v2SetVar',
    var: variable,
    value,
    operator: '=',
    valueType: 'value',
    indent: 0,
  });
  /** A display trigger that marks what it draws. */
  const marks = (mark: string) => ({
    comment: '',
    type: 'display' as const,
    conditions: [],
    effect: [
      { type: 'v2GetDisplayState', outputVar: 'text', indent: 0 },
      { type: 'v2ConcatString', source1: 'text', source1Type: 'var', source2: mark, source2Type: 'value', outputVar: 'text', indent: 0 },
      { type: 'v2SetDisplayState', value: 'text', valueType: 'var', indent: 0 },
    ],
  });
  /** Each member's card: an input trigger, a start, an output, a button and a display trigger of its own. */
  const card = (memberId: string, name: string, mark: string, extra: ScriptBundle['triggers'] = []): ScriptBundle =>
    scripted({
      memberId,
      name,
      triggers: [
        { comment: '', type: 'input', conditions: [], effect: [setvar(`input${name}`, `{{getvar::input리안}}+${name}`)] },
        { comment: '', type: 'start', conditions: [], effect: [setvar(`start${name}`, '1')] },
        { comment: '', type: 'output', conditions: [], effect: [setvar('finishedBy', name)] },
        { comment: '공격', type: 'manual', conditions: [], effect: [setvar('hit', name)] },
        marks(mark),
        ...extra,
      ],
    });

  beforeEach(() => {
    bundles = [card('chr_1', '리안', ' ★'), card('chr_2', '카이', ' ♥')];
    // 리안 speaks only when picked, so the round in list order is 카이's alone.
    publicPlot = {
      characters: [
        { id: 'chr_1', name: '리안', avatarUrl: null, intro: '', talkativeness: 0 },
        { id: 'chr_2', name: '카이', avatarUrl: null, intro: '', talkativeness: 50 },
      ],
      groupSettings: { order: 'list', maxSpeakers: 1 },
    };
    chatState = stateWith([
      greeting,
      message('m1', 'm0', 'user', '안녕'),
      message('m2', 'm1', 'assistant', '응.', { speakerMemberId: 'chr_2', groupTurnId: 'm2' }),
    ]);
  });

  it('builds the runtimes once both reads are in, and not again as the plot’s lands after the scripts’', async () => {
    // A rebuild takes the Lua sandbox down with the set it replaces, and an
    // `editDisplay` in flight with it.
    let open!: () => void;
    plotGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    await render();
    expect(runtimeLife.made).toBe(0);
    await act(async () => open());
    await act(async () => undefined);
    expect(runtimeLife).toEqual({ made: 2, disposed: 0 });
  });

  it('builds the runtimes once under strict mode, and gives them back a tick after the page goes', async () => {
    await act(async () => {
      root.render(
        createElement(StrictMode, null,
          createElement(NextIntlClientProvider, {
            locale: 'ko',
            timeZone: 'Asia/Seoul',
            messages,
            children: createElement(ChatPage, { params: Promise.resolve({ id: 'cht_1' }) }) as ReactNode,
          }),
        ),
      );
    });
    await act(async () => undefined);
    await act(async () => undefined);
    expect(runtimeLife).toEqual({ made: 2, disposed: 0 });
    act(() => root.unmount());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
    expect(runtimeLife).toEqual({ made: 2, disposed: 2 });
    // The suite's own unmount finds nothing left to do.
    root = createRoot(host);
  });

  it('chains both input passes on a send, and runs only the speaker’s start, naming it', async () => {
    await render();
    await sendText('들어간다');
    expect(streamed[0]!.path).toBe('/api/chats/cht_1/messages');
    expect(streamed[0]!.body).toMatchObject({
      content: '들어간다',
      speakerId: 'chr_2',
      memberId: 'chr_2',
      postProcess: true,
      // 카이's input pass read what 리안's left; 리안's start never ran.
      variableDelta: { input리안: 'null+리안', input카이: 'null+리안+카이', start카이: '1' },
    });
    expect((streamed[0]!.body as { variableDelta: Record<string, string> }).variableDelta).not.toHaveProperty('start리안');
  });

  it('finishes a reply with its speaker’s output pass', async () => {
    chatState = stateWith([
      greeting,
      message('m1', 'm0', 'user', '안녕'),
      message('m2', 'm1', 'assistant', '응.', { speakerMemberId: 'chr_2', groupTurnId: 'm2', scriptState: 'pending' }),
    ]);
    await render();
    await act(async () => undefined);
    const commit = sent.find((call) => call.path.endsWith('/script-commit'))!;
    expect(commit.body).toMatchObject({ messageId: 'm2', clearPending: true, memberId: 'chr_2', variableDelta: { finishedBy: '카이' } });
  });

  it('draws each message through its own member’s display triggers, the reader’s and the greeting through the lead’s', async () => {
    await render();
    expect(rows().map((row) => row.querySelector('span')!.textContent)).toEqual(['어서 와. ★', '안녕 ★', '응. ♥']);
    expect(rows().map((row) => row.dataset['shizueMember'])).toEqual(['chr_1', 'chr_1', 'chr_2']);
  });

  it('runs a button with the triggers of the member whose message holds it', async () => {
    await render();
    await click(rows()[2]!.querySelector('button[data-shizue-trigger]')!);
    expect(sent.at(-1)).toMatchObject({
      path: '/api/chats/cht_1/script-commit',
      body: { messageId: 'm2', memberId: 'chr_2', variableDelta: { hit: '카이' } },
    });
    await click(rows()[0]!.querySelector('button[data-shizue-trigger]')!);
    expect(sent.at(-1)).toMatchObject({ body: { memberId: 'chr_1', variableDelta: { hit: '리안' } } });
  });

  describe('whose first member carries no scripts', () => {
    beforeEach(() => {
      // 리안 heads the roster with no scripts of its own, and is the one who speaks; 카이 leads.
      bundles = [card('chr_2', '카이', ' ♥')];
      publicPlot = {
        characters: [
          { id: 'chr_1', name: '리안', avatarUrl: null, intro: '', talkativeness: 50 },
          { id: 'chr_2', name: '카이', avatarUrl: null, intro: '', talkativeness: 0 },
        ],
        groupSettings: { order: 'list', maxSpeakers: 1 },
      };
      chatState = stateWith([
        greeting,
        message('m1', 'm0', 'user', '안녕'),
        message('m2', 'm1', 'assistant', '응.', { speakerMemberId: 'chr_1', groupTurnId: 'm2' }),
      ]);
    });

    it('runs none of the lead’s start or output for its reply, the lead’s input pass still taken', async () => {
      await render();
      await sendText('들어간다');
      const body = streamed[0]!.body as Record<string, unknown>;
      expect(body).toMatchObject({ content: '들어간다', speakerId: 'chr_1', variableDelta: { input카이: 'null+카이' } });
      expect(body['variableDelta']).not.toHaveProperty('start카이');
      expect(body).not.toHaveProperty('postProcess');
      expect(body).not.toHaveProperty('memberId');
    });

    it('draws its reply through no display triggers, and the messages no member speaks through the lead’s', async () => {
      await render();
      expect(rows().map((row) => row.querySelector('span')!.textContent)).toEqual(['어서 와. ♥', '안녕 ♥', '응.']);
      // All three dressed as the first member's; only its reply is its own.
      expect(rows().map((row) => row.dataset['shizueMember'])).toEqual(['chr_1', 'chr_1', 'chr_1']);
      expect(rows().map((row) => row.hasAttribute('data-shizue-spoken'))).toEqual([false, false, true]);
    });

    it('runs nothing for a button in its reply, and the lead’s triggers for one in the greeting', async () => {
      await render();
      await click(rows()[2]!.querySelector('button[data-shizue-trigger]')!);
      expect(sent.filter((call) => call.path.endsWith('/script-commit'))).toEqual([]);
      await click(rows()[0]!.querySelector('button[data-shizue-trigger]')!);
      expect(sent.at(-1)).toMatchObject({
        path: '/api/chats/cht_1/script-commit',
        body: { memberId: 'chr_2', variableDelta: { hit: '카이' } },
      });
    });
  });

  it('draws a work of one with no member on its rows, as it always was', async () => {
    bundles = null;
    bundle = scripted({ memberId: 'chr_1', triggers: [marks(' ★')] });
    publicPlot = {};
    await render();
    expect(rows().map((row) => row.dataset['shizueMember'])).toEqual([undefined, undefined, undefined]);
    expect(rows().map((row) => row.querySelector('span')!.textContent)).toEqual(['어서 와. ★', '안녕 ★', '응. ★']);
  });
});
