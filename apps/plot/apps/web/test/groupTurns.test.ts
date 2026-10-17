// @vitest-environment jsdom
/**
 * Group turns on the chat page: in a work of two or more members a turn is
 * answered one reply per speaker, each its own request — the first with the
 * turn, the rest joining its round — and stop, retry, 재생성, 지금 말하기 and
 * a line typed as a member (`@이름:`) all act on rounds. A work of
 * one answers as it always has and never names a speaker.
 *
 * The chat page is mounted with its heavy children stubbed, as in
 * replySuggestions.test.ts; the stream is where the requests are read. The
 * speaker picking itself is `lib/groupRound`'s, tested in groupRound.test.ts.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/ko.json';
import type { ChatMessage, ChatState, GroupSettings, PublicMember } from '../src/lib/types';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const store = new Map<string, string>();
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  },
});

/** Every generation the page asked for, and how the next ones end, in order. */
let streamed: { path: string; body: Record<string, unknown> | undefined }[] = [];
/** `hold` waits until the reader stops it. Past the end, everything lands. */
let outcomes: ('done' | 'error' | 'hold')[] = [];
/** Every other write, and the props the notes panel was last drawn with. */
let sent: { method: string; path: string; body: unknown }[] = [];
let panel: Record<string, unknown> | null = null;
let chatState: ChatState;
let roster: (PublicMember & { intro: string })[];
let groupSettings: GroupSettings;

vi.mock('@/i18n/navigation', async () => {
  const { createElement: h } = await import('react');
  return {
    Link: ({ href, children }: { href: string; children?: ReactNode }) => h('a', { href }, children),
    useRouter: () => ({ back: () => {}, push: () => {}, replace: () => {} }),
  };
});
// Each row says whose it is drawn as and whom it is waiting on, with the page's
// footer under it — where 재생성 and 이어가기 are.
vi.mock('@/components/MessageRow', async () => {
  const { createElement: h } = await import('react');
  return {
    MessageRow: (props: {
      role: string;
      content: string;
      speaker?: string;
      typing?: { name: string };
      footer?: ReactNode | ((edit: (() => void) | null) => ReactNode);
    }) =>
      h(
        'div',
        {
          'data-testid': 'row',
          'data-role': props.role,
          ...(props.speaker !== undefined ? { 'data-speaker': props.speaker } : {}),
          ...(props.typing ? { 'data-typing': props.typing.name } : {}),
        },
        [h('span', { key: 'text' }, props.content), h('div', { key: 'footer' }, typeof props.footer === 'function' ? props.footer(null) : props.footer)],
      ),
  };
});
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
  streamGeneration: async (
    path: string,
    body: Record<string, unknown> | undefined,
    _onDelta: unknown,
    signal: AbortSignal,
  ): Promise<unknown> => {
    streamed.push({ path, body });
    const outcome = outcomes.shift() ?? 'done';
    if (outcome === 'hold') {
      await new Promise((resolve) => signal.addEventListener('abort', resolve));
      return { kind: 'aborted' };
    }
    if (outcome === 'error') return { kind: 'error', message: 'provider exploded' };
    const messageId = `msg_${streamed.length}`;
    // As the API answers: a group reply's speaker, and its round — its own id
    // when it opens one.
    const speakerId = body?.['speakerId'];
    return {
      kind: 'done',
      messageId,
      usage: {},
      ...(typeof speakerId === 'string'
        ? {
            speakerMemberId: speakerId === 'narrator' ? null : speakerId,
            groupTurnId: (body?.['groupTurnId'] as string | undefined) ?? messageId,
          }
        : {}),
    };
  },
}));
// The member layout's session, by which the page leases the reader's Lua sandbox.
vi.mock('@/lib/authClient', () => ({ useSession: () => ({ data: { user: { id: 'reader' } }, isPending: false }) }));
vi.mock('@/lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...original,
    apiGet: (url: string) => {
      if (url.endsWith('/scripts')) return Promise.resolve({ scripts: null });
      if (url.startsWith('/api/chats/')) return Promise.resolve(chatState);
      if (url.endsWith('/public')) {
        return Promise.resolve({ name: '여관', characters: roster, groupSettings, displayScripts: [], defaultVariables: {} });
      }
      return Promise.resolve([]);
    },
    apiSend: (method: string, path: string, body: unknown) => {
      sent.push({ method, path, body });
      return Promise.resolve(chatState);
    },
  };
});

const { default: ChatPage } = await import('../src/app/[locale]/(app)/(member)/chats/[id]/page');

const member = (id: string, name: string): PublicMember & { intro: string } => ({
  id,
  name,
  avatarUrl: null,
  intro: '',
  talkativeness: 50,
});

function message(id: string, parentId: string | null, role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
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
    createdAt: '2026-10-14T00:00:00.000Z',
    ...extra,
  };
}

const greeting = message('msg_g', null, 'assistant', '문이 열린다.');

function stateWith(path: ChatMessage[], absentCharacterIds: string[] = [], siblings: ChatState['siblings'] = {}): ChatState {
  return {
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
      headMessageId: path.at(-1)?.id ?? null,
      memoryRevision: 0,
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
      createdAt: '2026-10-14T00:00:00.000Z',
      updatedAt: '2026-10-14T00:00:00.000Z',
    },
    path,
    siblings: Object.fromEntries(path.map((entry) => [entry.id, siblings[entry.id] ?? { index: 0, total: 1, ids: [entry.id] }])),
  };
}

/** A round answered: the reader's turn, 리안's reply opening round r1, 민수's joining it. */
const answered = (): ChatMessage[] => [
  greeting,
  message('u1', 'msg_g', 'user', '안녕'),
  message('r1', 'u1', 'assistant', '리안의 말', { speakerMemberId: 'chr_lian', groupTurnId: 'r1' }),
  message('r2', 'r1', 'assistant', '민수의 말', { speakerMemberId: 'chr_minsu', groupTurnId: 'r1' }),
];

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
  // By what it says, or — an icon button — by its name; a sheet's are in its portal.
  [...document.body.querySelectorAll('button')].find((node) => node.textContent === label || node.getAttribute('aria-label') === label);

async function click(node: Element): Promise<void> {
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** The notes panel, which the sheet ☰ opens has the way into. */
async function openNotes(): Promise<void> {
  await click(button('대화 설정')!);
  await click(button('노트')!);
}

/** Lets the round's chain of requests run on, as far as nothing holds it. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function type(value: string): Promise<void> {
  const field = host.querySelector('textarea')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function sendText(value: string): Promise<void> {
  await type(value);
  await click(button('보내기')!);
  await settle();
}

/** The speaker of each request, in order. */
const speakers = (): unknown[] => streamed.map((entry) => entry.body?.['speakerId']);

beforeEach(() => {
  streamed = [];
  outcomes = [];
  sent = [];
  panel = null;
  roster = [member('chr_lian', '리안'), member('chr_minsu', '민수'), member('chr_yuna', '유나')];
  groupSettings = { order: 'list', maxSpeakers: 3 };
  chatState = stateWith([greeting]);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('a round in a work of several members', () => {
  it('asks each speaker in turn: the first with the turn, the rest joining its round, the last as the final one', async () => {
    await render();
    await sendText('안녕');
    expect(streamed).toEqual([
      { path: '/api/chats/cht_1/messages', body: { content: '안녕', speakerId: 'chr_lian', finalSpeaker: false } },
      { path: '/api/chats/cht_1/reply', body: { speakerId: 'chr_minsu', finalSpeaker: false, groupTurnId: 'msg_1' } },
      { path: '/api/chats/cht_1/reply', body: { speakerId: 'chr_yuna', finalSpeaker: true, groupTurnId: 'msg_1' } },
    ]);
    // The composer is the reader's again once the round is over.
    expect(button('보내기')).toBeDefined();
  });

  it('picks from the stage only', async () => {
    chatState = stateWith([greeting], ['chr_minsu']);
    await render();
    await sendText('안녕');
    expect(speakers()).toEqual(['chr_lian', 'chr_yuna']);
  });

  it('shows whom it waits on and who is next, and a stop asks nobody after the one stopped', async () => {
    outcomes = ['done', 'hold'];
    await render();
    await sendText('안녕');
    expect(speakers()).toEqual(['chr_lian', 'chr_minsu']);
    // The row being written is 민수's, and 유나 is still to come.
    expect(host.querySelector('[data-typing]')?.getAttribute('data-typing')).toBe('민수');
    expect(host.querySelector('[data-testid="round-next"]')?.textContent).toBe('다음: 유나');

    await click(button('중단')!);
    await settle();
    expect(speakers()).toEqual(['chr_lian', 'chr_minsu']);
    expect(host.querySelector('[data-testid="round-next"]')).toBeNull();
    expect(button('보내기')).toBeDefined();
  });

  it('asks a failed speaker again in the same round, and goes on from there', async () => {
    outcomes = ['done', 'error'];
    await render();
    await sendText('안녕');
    expect(speakers()).toEqual(['chr_lian', 'chr_minsu']);

    await click(button('다시 시도')!);
    await settle();
    expect(streamed.slice(2)).toEqual([
      { path: '/api/chats/cht_1/reply', body: { speakerId: 'chr_minsu', finalSpeaker: false, groupTurnId: 'msg_1' } },
      { path: '/api/chats/cht_1/reply', body: { speakerId: 'chr_yuna', finalSpeaker: true, groupTurnId: 'msg_1' } },
    ]);
  });

  it('asks a send’s failed first speaker again, as an answer to the stored turn', async () => {
    outcomes = ['error'];
    await render();
    await sendText('안녕');
    await click(button('다시 시도')!);
    await settle();
    expect(streamed[1]).toEqual({
      path: '/api/chats/cht_1/regenerate',
      body: { speakerId: 'chr_lian', finalSpeaker: false },
    });
  });

  it('redoes the whole round on 재생성', async () => {
    chatState = stateWith(answered());
    await render();
    expect([...host.querySelectorAll('[data-testid="row"]')].map((row) => row.getAttribute('data-speaker'))).toEqual([
      null,
      null,
      '리안',
      '민수',
    ]);

    await click(button('재생성')!);
    await settle();
    expect(streamed).toEqual([
      { path: '/api/chats/cht_1/regenerate', body: { speakerId: 'chr_lian', finalSpeaker: false } },
      { path: '/api/chats/cht_1/reply', body: { speakerId: 'chr_minsu', finalSpeaker: false, groupTurnId: 'msg_1' } },
      { path: '/api/chats/cht_1/reply', body: { speakerId: 'chr_yuna', finalSpeaker: true, groupTurnId: 'msg_1' } },
    ]);

  });

  it('lets a member speak now, a round of one', async () => {
    chatState = stateWith(answered());
    await render();
    await openNotes();
    const speakNow = panel!['onSpeakNow'] as (memberId: string) => void;
    await act(async () => speakNow('chr_yuna'));
    await settle();
    expect(streamed).toEqual([{ path: '/api/chats/cht_1/reply', body: { speakerId: 'chr_yuna', finalSpeaker: true } }]);
  });

  it('sends a line written as a member as that member’s, who then sits the round out', async () => {
    await render();
    // Typing the line's `@` offers the stage and the narrator; the name typed narrows it.
    await type('@');
    const list = (): string[] =>
      [...host.querySelectorAll('[data-testid="mention-list"] [role="option"] .truncate')].map((node) => node.textContent ?? '');
    expect(list()).toEqual(['리안', '민수', '유나', '내레이터']);
    await type('@민');
    expect(list()).toHaveLength(1);
    await click(host.querySelector('[data-testid="mention-list"] button')!);
    expect(host.querySelector('textarea')!.value).toBe('@민수: ');
    expect(host.querySelector('[data-testid="mention-list"]')).toBeNull();
    await sendText('@민수: 반가워');
    expect(streamed[0]!.body).toMatchObject({ content: '@민수: 반가워' });
    expect(speakers()).toEqual(['chr_lian', 'chr_yuna']);
  });
});

describe('a work of one member', () => {
  it('asks as it always has, naming no speaker and offering no round controls', async () => {
    roster = [member('chr_lian', '리안')];
    chatState = stateWith(answered().slice(0, 3));
    await render();

    await sendText('안녕');
    expect(streamed).toEqual([{ path: '/api/chats/cht_1/messages', body: { content: '안녕' } }]);
    await click(button('재생성')!);
    await settle();
    expect(streamed[1]).toEqual({ path: '/api/chats/cht_1/regenerate', body: undefined });

    await openNotes();
    expect(panel!['onSpeakNow']).toBeUndefined();
  });
});

describe('the scene cast in the notes panel', () => {
  it('sends a member away without the ids no member has any more', async () => {
    chatState = stateWith([greeting], ['chr_gone', 'chr_yuna']);
    await render();
    await openNotes();
    const toggle = panel!['onToggleAbsent'] as (id: string, absent: boolean) => Promise<void>;
    await act(() => toggle('chr_minsu', true));
    await act(() => toggle('chr_yuna', false));
    expect(sent.map((entry) => entry.body)).toEqual([
      { absentCharacterIds: ['chr_yuna', 'chr_minsu'] },
      { absentCharacterIds: [] },
    ]);
  });

  it("hands the inspector to the plot's creator only", async () => {
    await render();
    await openNotes();
    expect(panel!['inspectChatId']).toBeUndefined();

    act(() => root.unmount());
    root = createRoot(host);
    chatState = { ...stateWith([greeting]), isPlotOwner: true };
    await render();
    await openNotes();
    expect(panel!['inspectChatId']).toBe('cht_1');
  });
});
