/**
 * The card scripts of a work of several members, each member's in a runtime of
 * its own (`lib/scripts/group.ts`): a send's input passes chained across the
 * members on the stage, the speaker's start alone, the output pass committed as
 * the speaker's, display and buttons routed by whose message it is — and a work
 * of one sending exactly what it always sent.
 */
import { computeVariables, emptyVariables, type Variables } from '@shizue/core/variables';
import type { TriggerScript, TriggerStep } from '@shizue/core/triggers';
import { describe, expect, it } from 'vitest';
import type { ScriptEngine } from '../src/lib/scripts/engine';
import { groupDisplayEdits, prepareGroupSend, runtimeOf, type ScriptCast } from '../src/lib/scripts/group';
import {
  createScriptRuntime,
  sharedScripts,
  type ScriptBundle,
  type ScriptRuntime,
  type ScriptUi,
  type ScriptView,
} from '../src/lib/scripts/runtime';
import type { ChatMessage } from '../src/lib/types';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
/** A member with no scripts of its own. */
const C = '00000000-0000-4000-8000-00000000000c';

const vars = (entries: Record<string, string> = {}): Variables => Object.assign(emptyVariables(), entries);

const message = (
  id: string,
  parentId: string | null,
  role: ChatMessage['role'],
  content: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage => ({
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
});

const trigger = (type: TriggerScript['type'], effect: TriggerStep[], extra: Partial<TriggerScript> = {}): TriggerScript => ({
  comment: '',
  type,
  conditions: [],
  effect,
  ...extra,
});

const setvar = (variable: string, value: string, operator = '='): TriggerStep => ({
  type: 'v2SetVar',
  var: variable,
  value,
  operator,
  valueType: 'value',
  indent: 0,
});

/** A display trigger that marks what it draws with `mark`. */
const marks = (mark: string): TriggerScript =>
  trigger('display', [
    { type: 'v2GetDisplayState', outputVar: 'text', indent: 0 },
    { type: 'v2ConcatString', source1: 'text', source1Type: 'var', source2: mark, source2Type: 'value', outputVar: 'text', indent: 0 },
    { type: 'v2SetDisplayState', value: 'text', valueType: 'var', indent: 0 },
  ]);

function bundle(memberId: string, name: string, extra: Partial<ScriptBundle> = {}): ScriptBundle {
  return {
    memberId,
    name,
    triggers: [],
    editScripts: [],
    lowLevelAccess: false,
    character: {
      description: `${name}의 설명`,
      personality: '',
      scenario: '',
      exampleDialogue: '',
      lorebook: [],
      postHistoryInstructions: '',
    },
    overlay: { member: null, persona: null },
    ...extra,
  };
}

function fakeApi() {
  const calls: { method: string; path: string; body: Record<string, unknown> }[] = [];
  return {
    calls,
    api: {
      send: async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
        calls.push({ method, path, body: (body ?? {}) as Record<string, unknown> });
        return (path.endsWith('/script-llm') ? { result: '답' } : {}) as T;
      },
    },
  };
}

const silentUi: ScriptUi = {
  alert: async () => undefined,
  input: async () => '',
  select: async (options) => options[0] ?? '',
  confirm: async () => false,
};

const defaults = vars({ hp: '100' });
const names = { user: '아린', char: '여관' };
const view = (messages: ChatMessage[]): ScriptView => ({ messages, defaults, names, note: '', persona: '여행자' });

const greeting = message('m0', null, 'assistant', '어서 와.');

/** The runtimes of one chat, as the page builds them: one per scripted member, sharing what members share. */
function castOf(
  bundles: ScriptBundle[],
  { api, engines = {} }: {
    api: ReturnType<typeof fakeApi>['api'];
    engines?: Record<string, ScriptEngine[]>;
  },
): ScriptCast {
  const shared = sharedScripts(bundles[0]!);
  const byMember = new Map<string, ScriptRuntime>(
    bundles.map((one) => [
      one.memberId,
      createScriptRuntime({
        chatId: 'c1',
        bundle: one,
        api,
        ui: silentUi,
        shared,
        group: true,
        engines: engines[one.memberId] ?? [],
      }),
    ]),
  );
  return { byMember, lead: byMember.get(bundles[0]!.memberId)! };
}

/** Two RisuAI cards: each an input trigger, an `editinput` script, a start trigger, an output trigger. */
const two = (): ScriptBundle[] => [
  bundle(A, '세이', {
    triggers: [
      trigger('input', [setvar('fromA', '{{getvar::hp}}')]),
      trigger('start', [setvar('startedBy', 'A')]),
      trigger('output', [setvar('finishedBy', 'A')]),
    ],
    editScripts: [{ type: 'editinput', in: '안녕', out: '안녕하세요' }],
  }),
  bundle(B, '카이', {
    triggers: [
      // B's input pass reads what A's left: the variable and the rewritten text.
      trigger('input', [setvar('fromB', '{{getvar::fromA}}')]),
      trigger('start', [setvar('startedBy', 'B'), setvar('hp', '1', '-=')]),
      trigger('output', [setvar('finishedBy', 'B')]),
    ],
    editScripts: [{ type: 'editinput', in: '하세요', out: '하세요!' }],
  }),
];

describe('a send in a work of several members', () => {
  it('chains every staged member’s input pass in roster order, then runs the speaker’s start alone', async () => {
    const { api, calls } = fakeApi();
    const cast = castOf(two(), { api });
    let picked = '';
    const { prepared, speakerId } = await prepareGroupSend(cast, view([greeting]), '안녕', undefined, {
      stage: [A, B],
      pick: (text) => {
        picked = text;
        return B;
      },
    });
    // The round is picked off the turn both input passes left.
    expect(picked).toBe('안녕하세요!');
    expect(speakerId).toBe(B);
    expect(prepared.content).toBe('안녕하세요!');
    // The speaker's: its member named, its output pass owed.
    expect(prepared.body).toMatchObject({ baseHeadId: 'm0', memberId: B, postProcess: true });
    // A's start never ran; B's did, after both input passes.
    const stored = { content: prepared.content!, variableDelta: prepared.body['variableDelta'] as Record<string, string> };
    expect(computeVariables([greeting, stored], defaults, names)).toEqual(
      vars({ hp: '99', fromA: '100', fromB: '100', startedBy: 'B' }),
    );
    expect(calls).toEqual([]);
  });

  it('runs no input pass of a member off the stage', async () => {
    const { api } = fakeApi();
    const cast = castOf(two(), { api });
    const { prepared } = await prepareGroupSend(cast, view([greeting]), '안녕', undefined, { stage: [B], pick: () => A });
    // Only B's input pass: A's `editinput` and A's variable are not there; A, the speaker, starts.
    expect(prepared.content).toBe('안녕');
    expect(prepared.body).toMatchObject({ memberId: A, variableDelta: { fromB: 'null', startedBy: 'A' } });
    expect(prepared.body['variableDelta']).not.toHaveProperty('fromA');
  });

  it('gives a speaker with no scripts no start and no output pass, the input passes still kept', async () => {
    const { api } = fakeApi();
    const cast = castOf(two(), { api });
    const { prepared } = await prepareGroupSend(cast, view([greeting]), '안녕', undefined, { stage: [A, B, C], pick: () => C });
    expect(prepared.content).toBe('안녕하세요!');
    expect(prepared.body['postProcess']).toBeUndefined();
    expect(prepared.body['memberId']).toBeUndefined();
    expect(prepared.body['variableDelta']).toEqual({ fromA: '100', fromB: '100' });
  });

  it('carries what each member’s pass rewrote of its own card, and keeps each once accepted', async () => {
    const { api } = fakeApi();
    const rewrites = (description: string): TriggerScript =>
      trigger('input', [{ type: 'v2SetCharacterDesc', value: description, valueType: 'value', indent: 0 }]);
    const cast = castOf([bundle(A, '세이', { triggers: [rewrites('A가 바꿈')] }), bundle(B, '카이', { triggers: [rewrites('B가 바꿈')] })], { api });
    const { prepared } = await prepareGroupSend(cast, view([greeting]), '안녕', undefined, { stage: [A, B], pick: () => A });
    expect(prepared.body['overlay']).toEqual({ members: { [A]: { description: 'A가 바꿈' }, [B]: { description: 'B가 바꿈' } } });
    prepared.accept();
    // The next run of each member reads its own rewrite.
    expect(cast.byMember.get(B)!.bundle.memberId).toBe(B);
    const again = await prepareGroupSend(cast, view([greeting]), '안녕', undefined, { stage: [B], pick: () => B });
    expect(again.prepared.body['overlay']).toEqual({ members: { [B]: { description: 'B가 바꿈' } } });
  });
});

describe('the other moments, by whose they are', () => {
  /** A reply of `speaker` the server holds pending. */
  const pendingOf = (speaker: string): ChatMessage[] => [
    greeting,
    message('m1', 'm0', 'user', '안녕'),
    message('m2', 'm1', 'assistant', '반가워.', { scriptState: 'pending', scriptRev: 0, speakerMemberId: speaker }),
  ];

  it('finishes a reply with its speaker’s output pass, the commit naming the speaker', async () => {
    const { api, calls } = fakeApi();
    const cast = castOf(two(), { api });
    await runtimeOf(cast, B)!.finish(view(pendingOf(B)));
    const commit = calls.find((call) => call.path.endsWith('/script-commit'))!;
    expect(commit.body).toMatchObject({ messageId: 'm2', clearPending: true, memberId: B, variableDelta: { finishedBy: 'B' } });
  });

  it('routes a member’s message to its own runtime, one no member speaks to the lead’s, and a member with none to nothing', () => {
    const { api } = fakeApi();
    // A leads, B is its own; C — the work's first member or not — carries none and borrows none.
    const cast = castOf(two(), { api });
    expect(runtimeOf(cast, A)).toBe(cast.lead);
    expect(runtimeOf(cast, B)).toBe(cast.byMember.get(B));
    expect(runtimeOf(cast, null)).toBe(cast.lead);
    expect(runtimeOf(cast, C)).toBeNull();
    expect(runtimeOf(cast, 'narrator')).toBe(cast.lead);
  });

  it('draws each message through the display triggers of the member it is', () => {
    const { api } = fakeApi();
    const [first, second] = two();
    const cast = castOf(
      [{ ...first!, triggers: [marks(' ★')] }, { ...second!, triggers: [marks(' ♥')] }],
      { api },
    );
    const at = view([greeting]);
    expect(runtimeOf(cast, A)!.display('세이의 답', at, vars())).toBe('세이의 답 ★');
    expect(runtimeOf(cast, B)!.display('카이의 답', at, vars())).toBe('카이의 답 ♥');
  });

  it('asks each runtime’s display listeners about its own messages only', async () => {
    const { api } = fakeApi();
    const listener = (mark: string): ScriptEngine => ({
      name: 'lua',
      handles: (phase) => phase === 'editdisplay',
      display: async (items) => items.map((item) => `${item.text}${mark}`),
    });
    const lua = [trigger('start', [{ type: 'triggerlua', code: 'x' }])];
    const cast = castOf([bundle(A, '세이', { triggers: lua }), bundle(B, '카이', { triggers: lua })], {
      api,
      engines: { [A]: [listener('★')], [B]: [listener('♥')] },
    });
    const at = view([greeting, message('m1', 'm0', 'assistant', '둘')]);
    const shown = await groupDisplayEdits(
      cast,
      [
        { id: 'm0', text: '하나', memberId: null },
        { id: 'm1', text: '둘', memberId: B },
      ],
      (runtime, items) => runtime.displayEdits(items, at, vars()),
    );
    expect([...shown]).toEqual([
      ['m0', '하나★'],
      ['m1', '둘♥'],
    ]);
  });

  it('runs a button with the scripts of the member whose message holds it, committed as that member’s', async () => {
    const { api, calls } = fakeApi();
    const presser = (mark: string): ScriptEngine => ({
      name: 'lua',
      handles: (phase) => phase === 'button',
      button: async (data, scope) => scope.setVar('pressed', `${mark}:${data}`),
    });
    const lua = [trigger('start', [{ type: 'triggerlua', code: 'x' }])];
    const cast = castOf([bundle(A, '세이', { triggers: lua }), bundle(B, '카이', { triggers: lua })], {
      api,
      engines: { [A]: [presser('A')], [B]: [presser('B')] },
    });
    const at = view([greeting, message('m1', 'm0', 'assistant', '카이의 답', { speakerMemberId: B })]);
    await runtimeOf(cast, B)!.button('열기', at);
    expect(calls.at(-1)!.body).toMatchObject({ memberId: B, variableDelta: { pressed: 'B:열기' } });
  });

  it('names the calling member on a script’s model call', async () => {
    const { api, calls } = fakeApi();
    const cast = castOf(
      [
        bundle(A, '세이'),
        bundle(B, '카이', {
          lowLevelAccess: true,
          triggers: [trigger('manual', [{ type: 'v2RunLLM', value: '물어봐', valueType: 'value', outputVar: 'said', model: 'model', indent: 0 }], { comment: '묻기' })],
        }),
      ],
      { api },
    );
    await runtimeOf(cast, B)!.manual('묻기', null, view([greeting]));
    expect(calls.find((call) => call.path.endsWith('/script-llm'))!.body).toMatchObject({ memberId: B });
  });
});

describe('a work of one member', () => {
  it('names no member on any request', async () => {
    const { api, calls } = fakeApi();
    const [only] = two();
    const runtime = createScriptRuntime({
      chatId: 'c1',
      bundle: {
        ...only!,
        lowLevelAccess: true,
        triggers: [
          ...only!.triggers,
          trigger('manual', [{ type: 'v2RunLLM', value: '물어봐', valueType: 'value', outputVar: 'said', model: 'model', indent: 0 }], { comment: '묻기' }),
        ],
      },
      api,
      ui: silentUi,
    });
    const sent = await runtime.prepare('send', view([greeting]), '안녕');
    expect(sent.body).not.toHaveProperty('memberId');
    const regenerate = await runtime.prepare('regenerate', view([greeting, message('m1', 'm0', 'user', '안녕')]));
    expect(regenerate.body).not.toHaveProperty('memberId');
    await runtime.finish(
      view([greeting, message('m1', 'm0', 'user', '안녕'), message('m2', 'm1', 'assistant', '응.', { scriptState: 'pending', scriptRev: 0 })]),
    );
    await runtime.manual('묻기', null, view([greeting]));
    for (const call of calls) expect(call.body).not.toHaveProperty('memberId');
    expect(calls.map((call) => call.path)).toEqual(['/api/chats/c1/script-commit', '/api/chats/c1/script-llm', '/api/chats/c1/script-commit']);
  });

  it('prepares a send exactly as its own passes chained by hand', async () => {
    const make = () => createScriptRuntime({ chatId: 'c1', bundle: two()[1]!, api: fakeApi().api, ui: silentUi });
    const whole = await make().prepare('send', view([greeting]), '안녕하세요');
    const one = make();
    const byHand = await one.startSend(await one.input(one.beginSend(view([greeting]), '안녕하세요')));
    expect(byHand.body).toEqual(whole.body);
    expect(byHand.content).toBe(whole.content);
  });
});

