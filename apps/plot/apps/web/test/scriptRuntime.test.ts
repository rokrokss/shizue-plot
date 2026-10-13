/**
 * The chat's script runtime against a fake API: what each moment of a turn sends
 * to the server, and that every delta it sends folds back, on the server's side,
 * to the state the scripts ended in.
 */
import { applyVariableDelta, computeVariables, emptyVariables, type Variables } from '@shizue/core/variables';
import type { TriggerScript, TriggerStep } from '@shizue/core/triggers';
import { describe, expect, it } from 'vitest';
import { loadWholeBranch } from '../src/lib/scripts/branch';
import { createScriptRuntime, type ScriptBundle, type ScriptUi, type ScriptView } from '../src/lib/scripts/runtime';
import type { ChatMessage, ChatState } from '../src/lib/types';

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
  createdAt: '2026-10-13T00:00:00.000Z',
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

function bundle(extra: Partial<ScriptBundle> = {}): ScriptBundle {
  return {
    memberId: '00000000-0000-4000-8000-000000000001',
    name: '리안',
    triggers: [],
    editScripts: [],
    lowLevelAccess: false,
    character: {
      description: '사서.',
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

/** Records every request and answers with a state built from the body. */
function fakeApi(answer: (path: string, body: Record<string, unknown>) => ChatState = () => ({}) as ChatState) {
  const calls: { method: string; path: string; body: Record<string, unknown> }[] = [];
  return {
    calls,
    api: {
      send: async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
        calls.push({ method, path, body: (body ?? {}) as Record<string, unknown> });
        return answer(path, (body ?? {}) as Record<string, unknown>) as T;
      },
    },
  };
}

const silentUi: ScriptUi = {
  alert: async () => undefined,
  input: async () => '',
  select: async (options) => options[0] ?? '',
};

const defaults = vars({ hp: '100' });
const names = { user: '아린', char: '여관' };

const view = (messages: ChatMessage[], extra: Partial<ScriptView> = {}): ScriptView => ({
  messages,
  defaults,
  names,
  note: '',
  persona: '여행자',
  ...extra,
});

/** What the server folds a stored branch to: macros, then each message's delta. */
const serverFold = (messages: { content: string; variableDelta?: Record<string, string | null> | null }[]): Variables =>
  computeVariables(messages, defaults, names);

const greeting = message('m0', null, 'assistant', '어서 와.');
const reply = message('m2', 'm1', 'assistant', '{{setvar::hp::90}}다친 것 같다.', {
  scriptState: 'pending',
  scriptRev: 0,
  variableDelta: { mood: 'tense' },
});
const branch = [greeting, message('m1', 'm0', 'user', '들어간다'), reply];

describe('prepare: a send', () => {
  it('runs the input triggers, the input scripts and the start triggers, and sends what folds back to their end', async () => {
    const { api, calls } = fakeApi();
    const runtime = createScriptRuntime({
      chatId: 'c1',
      api,
      ui: silentUi,
      bundle: bundle({
        triggers: [
          trigger('input', [setvar('seenInput', '{{lastmessage}}')]),
          trigger('start', [
            setvar('hp', '5', '-='),
            { type: 'v2GetLastMessage', outputVar: 'sentAs', indent: 0 },
            { type: 'v2SystemPrompt', location: 'historyend', value: 'HP {{getvar::hp}}', valueType: 'value', indent: 0 },
          ]),
        ],
        editScripts: [{ type: 'editinput', in: '안녕', out: '안녕하세요' }],
      }),
    });
    const messages = [greeting, message('m1', 'm0', 'user', '앉는다'), message('m2', 'm1', 'assistant', '응.')];
    const prepared = await runtime.prepare('send', view(messages), '안녕 {{addvar::hp::1}}');

    expect(prepared.stop).toBe(false);
    expect(prepared.content).toBe('안녕하세요 {{addvar::hp::1}}');
    expect(prepared.body).toMatchObject({
      baseHeadId: 'm2',
      injections: { historyend: 'HP 96\n\n' },
    });
    expect(prepared.body['postProcess']).toBeUndefined();
    // Stored on the turn, the delta folds back to where the scripts ended.
    const stored = { content: prepared.content!, variableDelta: prepared.body['variableDelta'] as Record<string, string> };
    expect(serverFold([...messages, stored])).toEqual(
      vars({ hp: '96', seenInput: '응.', sentAs: '안녕하세요 {{addvar::hp::1}}' }),
    );
    // Nothing needed committing first.
    expect(calls).toEqual([]);
  });

  it('asks for post-processing when the plot has output scripts, and stops on a start trigger’s stop', async () => {
    const { api } = fakeApi();
    const runtime = createScriptRuntime({
      chatId: 'c1',
      api,
      ui: silentUi,
      bundle: bundle({
        triggers: [
          trigger('output', [setvar('x', '1')]),
          trigger('start', [{ type: 'stop' }], {
            conditions: [{ type: 'exists', type2: 'loose', value: '/roll', depth: 1 }],
          }),
        ],
      }),
    });
    expect(runtime.finishesReplies).toBe(true);
    const normal = await runtime.prepare('send', view([greeting]), '안녕');
    expect(normal.body).toMatchObject({ postProcess: true, baseHeadId: 'm0' });
    const stopped = await runtime.prepare('send', view([greeting]), '/roll 2d6');
    expect(stopped.stop).toBe(true);
  });

  it('commits a start trigger’s rewrite of the head before the turn, and carries the overlay once accepted', async () => {
    const { api, calls } = fakeApi(() => ({ marker: 'rewritten' }) as unknown as ChatState);
    const runtime = createScriptRuntime({
      chatId: 'c1',
      api,
      ui: silentUi,
      bundle: bundle({
        triggers: [
          trigger('start', [
            { type: 'v2ModifyChat', index: '0', indexType: 'value', value: '고친 인사', valueType: 'value', indent: 0 },
            { type: 'v2SetCharacterDesc', value: '{{description}} 지금은 기사.', valueType: 'value', indent: 0 },
            { type: 'v2SetAuthorNote', value: '비', valueType: 'value', indent: 0 },
          ]),
        ],
      }),
    });
    const head = message('m1', null, 'assistant', '인사', { scriptRev: 2 });
    // The opening here is not the root greeting's place: a message after it is the head.
    const messages = [greeting, { ...head, parentId: 'm0' }];
    const prepared = await runtime.prepare('regenerate', view(messages));
    // A regenerate's branch stops before the head it replaces: index 0 is the
    // greeting's first follower, which is not the head, so nothing is committed.
    expect(calls).toEqual([]);
    const auto = await runtime.prepare('auto', view(messages));
    expect(calls).toEqual([
      { method: 'POST', path: '/api/chats/c1/script-commit', body: { messageId: 'm1', scriptRev: 2, content: '고친 인사' } },
    ]);
    expect(auto.state).toEqual({ marker: 'rewritten' });
    expect(auto.body).toMatchObject({
      overlay: { members: { '00000000-0000-4000-8000-000000000001': { description: '사서. 지금은 기사.' } } },
      note: '비',
    });
    // Until the server takes a generation, the runtime's copy does not move…
    const again = await runtime.prepare('auto', view(messages));
    expect((again.body['overlay'] as { members: Record<string, { description: string }> }).members['00000000-0000-4000-8000-000000000001']!.description).toBe(
      '사서. 지금은 기사.',
    );
    // …and once it has, the next run reads the rewrite.
    again.accept();
    const third = await runtime.prepare('auto', view(messages));
    expect((third.body['overlay'] as { members: Record<string, { description: string }> }).members['00000000-0000-4000-8000-000000000001']!.description).toBe(
      '사서. 지금은 기사. 지금은 기사.',
    );
    expect(prepared.stop).toBe(false);
  });
});

describe('prepare: the other generations', () => {
  it('runs the start triggers on the branch the generation reads, and sends their writes as startDelta', async () => {
    const { api } = fakeApi();
    const runtime = createScriptRuntime({
      chatId: 'c1',
      api,
      ui: silentUi,
      bundle: bundle({ triggers: [trigger('start', [{ type: 'v2GetMessageCount', outputVar: 'count', indent: 0 }])] }),
    });
    const messages = [greeting, message('m1', 'm0', 'user', '{{setvar::hp::50}}'), message('m2', 'm1', 'assistant', '{{setvar::hp::1}}')];
    // A regenerate replaces the head: the triggers see one message, and its fold.
    const regenerate = await runtime.prepare('regenerate', view(messages));
    expect(regenerate.body['startDelta']).toEqual({ count: '1' });
    expect(applyVariableDelta(serverFold(messages.slice(0, -1)), regenerate.body['startDelta'] as Record<string, string>)).toEqual(
      vars({ hp: '50', count: '1' }),
    );
    const cont = await runtime.prepare('continue', view(messages));
    expect(cont.body['startDelta']).toEqual({ count: '2' });
  });

  it('sends only the head check when nothing runs before a generation', async () => {
    const runtime = createScriptRuntime({ chatId: 'c1', api: fakeApi().api, ui: silentUi, bundle: bundle() });
    expect((await runtime.prepare('narrate', view([greeting]))).body).toEqual({ baseHeadId: 'm0' });
  });
});

describe('finish', () => {
  it('rewrites the pending reply, runs the output triggers, and commits a delta that replaces the server’s', async () => {
    const { api, calls } = fakeApi();
    const runtime = createScriptRuntime({
      chatId: 'c1',
      api,
      ui: silentUi,
      bundle: bundle({
        triggers: [
          trigger('output', [
            setvar('hp', '10', '-='),
            { type: 'v2GetLastMessage', outputVar: 'last', indent: 0 },
          ]),
        ],
        editScripts: [{ type: 'editoutput', in: '다친 것 같다', out: '다쳤다 (HP {{getvar::hp}})' }],
      }),
    });
    const done = await runtime.finish(view(branch));
    expect(done?.followUp).toBe(false);
    expect(calls).toHaveLength(1);
    const body = calls[0]!.body;
    expect(body).toMatchObject({
      messageId: 'm2',
      scriptRev: 0,
      clearPending: true,
      content: '{{setvar::hp::90}}다쳤다 (HP 90).',
    });
    // Stored with the new text and the new delta, the reply folds to where the
    // output triggers ended — the start triggers' mood included.
    const stored = [...branch.slice(0, -1), { content: body['content'] as string, variableDelta: body['variableDelta'] as Record<string, string> }];
    expect(serverFold(stored)).toEqual(vars({ hp: '80', mood: 'tense', last: '{{setvar::hp::90}}다쳤다 (HP 90).' }));
  });

  it('does nothing for a head that is not pending, and still clears one when no script is left to run', async () => {
    const { api, calls } = fakeApi();
    const runtime = createScriptRuntime({ chatId: 'c1', api, ui: silentUi, bundle: bundle() });
    expect(await runtime.finish(view([greeting]))).toBeNull();
    await runtime.finish(view(branch));
    expect(calls[0]!.body).toMatchObject({ clearPending: true, variableDelta: { mood: 'tense' } });
    expect(calls[0]!.body['content']).toBeUndefined();
  });

  it('keeps an output trigger’s rewrite of the reply, and passes a low-level follow-up on', async () => {
    const { api, calls } = fakeApi();
    const runtime = createScriptRuntime({
      chatId: 'c1',
      api,
      ui: silentUi,
      bundle: bundle({
        lowLevelAccess: true,
        triggers: [
          trigger('output', [
            { type: 'v2ModifyChat', index: '{{lastmessageid}}', indexType: 'value', value: '바뀐 대답', valueType: 'value', indent: 0 },
            { type: 'sendAIprompt' },
          ]),
        ],
      }),
    });
    const done = await runtime.finish(view(branch));
    expect(done?.followUp).toBe(true);
    expect(calls[0]!.body['content']).toBe('바뀐 대답');
  });
});

describe('manual', () => {
  it('runs the named trigger and commits its writes on the head, with the trigger id', async () => {
    const { api, calls } = fakeApi();
    const runtime = createScriptRuntime({
      chatId: 'c1',
      api,
      ui: silentUi,
      bundle: bundle({
        triggers: [trigger('manual', [setvar('clicked', '{{trigger_id}}'), setvar('hp', '1', '+=')], { comment: '공격' })],
      }),
    });
    expect([...runtime.triggerNames]).toEqual(['공격']);
    const done = [greeting, message('m1', 'm0', 'user', '{{setvar::hp::50}}')];
    await runtime.manual('공격', 'btn-7', view(done));
    expect(calls[0]!.body).toMatchObject({ messageId: 'm1', scriptRev: 0, variableDelta: { clicked: 'btn-7', hp: '51' } });
    const stored = [greeting, { content: done[1]!.content, variableDelta: calls[0]!.body['variableDelta'] as Record<string, string> }];
    expect(serverFold(stored)).toEqual(vars({ hp: '51', clicked: 'btn-7' }));
    // A name no trigger has commits nothing.
    expect(await runtime.manual('없음', null, view(done))).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('asks the reader through the page, and commits the answer', async () => {
    const { api, calls } = fakeApi();
    const asked: string[] = [];
    const runtime = createScriptRuntime({
      chatId: 'c1',
      api,
      ui: { ...silentUi, input: async (text) => (asked.push(text), '아린') },
      bundle: bundle({
        triggers: [
          trigger('manual', [{ type: 'v2GetAlertInput', display: '이름은?', displayType: 'value', outputVar: 'name', indent: 0 }], {
            comment: '이름',
          }),
        ],
      }),
    });
    await runtime.manual('이름', null, view([greeting]));
    expect(asked).toEqual(['이름은?']);
    expect(calls[0]!.body['variableDelta']).toEqual({ name: '아린' });
  });
});

describe('display', () => {
  it('rewrites the text the display triggers are given, without touching the chat', () => {
    const runtime = createScriptRuntime({
      chatId: 'c1',
      api: fakeApi().api,
      ui: silentUi,
      bundle: bundle({
        triggers: [
          trigger('display', [
            { type: 'v2GetDisplayState', outputVar: 'text', indent: 0 },
            { type: 'v2ConcatString', source1: 'text', source1Type: 'var', source2: ' ♥', source2Type: 'value', outputVar: 'text', indent: 0 },
            { type: 'v2SetDisplayState', value: 'text', valueType: 'var', indent: 0 },
          ]),
        ],
      }),
    });
    expect(runtime.rewritesDisplay).toBe(true);
    expect(runtime.display('안녕', view([greeting]), vars())).toBe('안녕 ♥');
  });
});

describe('the Lua seat', () => {
  it('logs a risu-btn and a Lua trigger with no engine, and hands them to one that is installed', async () => {
    const logged: string[] = [];
    const lua = [trigger('start', [{ type: 'triggerlua', code: 'x' }])];
    const without = createScriptRuntime({
      chatId: 'c1',
      api: fakeApi().api,
      ui: silentUi,
      bundle: bundle({ triggers: lua }),
      log: (entry) => logged.push(entry.effect ?? entry.kind),
    });
    // A plot whose only scripts are Lua finishes no replies without the engine.
    expect(without.finishesReplies).toBe(false);
    await without.button('data');
    expect(logged).toEqual(['risu-btn']);

    const seen: string[] = [];
    const { api, calls } = fakeApi(() => ({ variables: { visits: '4', old: 'x' } }) as unknown as ChatState);
    const globals: Variables[] = [];
    const withEngine = createScriptRuntime({
      chatId: 'c1',
      api,
      ui: silentUi,
      bundle: bundle({ triggers: lua }),
      onGlobalVariables: (variables) => void globals.push(variables),
      engines: [
        {
          name: 'lua',
          handles: () => true,
          runCode: async (request) => {
            seen.push(request.mode);
            request.scope.setVar('fromLua', '1');
            // Lua's setGlobalVar: the reader's, not the branch's.
            request.scope.setGlobalVar('visits', String(Number(request.scope.getGlobalVar('visits')) + 1));
            request.scope.setGlobalVar('gone', null);
          },
          button: async (data) => void seen.push(`button:${data}`),
        },
      ],
    });
    const prepared = await withEngine.prepare('auto', view([greeting], { globalVariables: vars({ visits: '3' }) }));
    await withEngine.button('go');
    expect(seen).toEqual(['start', 'button:go']);
    expect(prepared.body['startDelta']).toEqual({ fromLua: '1' });
    expect(calls).toEqual([
      { method: 'PATCH', path: '/api/chats/c1/global-variables', body: { variables: { visits: '4', gone: null } } },
    ]);
    expect(globals).toEqual([{ visits: '4', old: 'x' }]);
  });
});

describe('loadWholeBranch', () => {
  it('reads every window before the loaded one, oldest last', async () => {
    const all = Array.from({ length: 5 }, (_, index) =>
      message(`m${index}`, index === 0 ? null : `m${index - 1}`, index % 2 ? 'user' : 'assistant', String(index)),
    );
    const windowOf = (end: number, size: number): ChatState =>
      ({ path: all.slice(Math.max(0, end - size), end), siblings: {}, hasMore: end - size > 0 }) as unknown as ChatState;
    const reads: string[] = [];
    const whole = await loadWholeBranch(windowOf(5, 2), async (cursor) => {
      reads.push(cursor);
      return windowOf(all.findIndex((entry) => entry.id === cursor), 2);
    });
    expect(whole.path.map((entry) => entry.id)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    expect(whole.hasMore).toBe(false);
    expect(reads).toEqual(['m3', 'm1']);
  });
});
